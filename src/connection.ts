/**
 * HTTP/2 connection implementation.
 *
 * Wires frame parsing/serialization, HPACK, the stream manager, settings
 * exchange, and flow control over a `@browsercore/transport` duplex byte stream.
 *
 * Lifecycle:
 *   1. `connectHttp2()` writes the client connection preface (the 24-byte PRI
 *      string + a SETTINGS frame).
 *   2. A read loop reassembles the byte stream into frames (TCP may coalesce /
 *      split them) and feeds each to the stream manager.
 *   3. We wait for the peer's SETTINGS ACK — the handshake completes once it
 *      arrives, or `SettingsAckTimeoutError` fires after the configured timeout.
 *   4. `request()` opens an odd-numbered stream, sends HEADERS (+ DATA), and
 *      resolves with the response once response HEADERS and END_STREAM arrive.
 *
 * Concurrency: outbound streams are bounded by the peer's MAX_CONCURRENT_STREAMS
 * (from SETTINGS). `request()` waits for a slot to free before opening a new
 * stream rather than throwing — honest backpressure that keeps the connection
 * usable under load.
 *
 * Known limitations:
 *   - Request HEADERS are sent in a single frame (no CONTINUATION splitting).
 *     Real request header blocks are well under the 16 KiB max-frame size.
 *   - Server push is decoded and surfaced via the `"push"` / `"pushResponse"`
 *     stream-manager events but is not exposed through the `Http2Connection`
 *     interface (the interface is fixed and has no push API).
 *   - PRIORITY frames are accepted but do not reorder the send queue.
 */

import type { EventEmitter } from "node:events";
import { crypto, type CryptoProvider } from "@browsercore/crypto";
import {
    silentLogger,
    FrameType,
    systemClock,
    type Clock,
    type Frame,
    type Http2Connection,
    type Http2ConnectionId,
    type Http2Options,
    type Http2Request,
    type Http2Response,
    type Http2SettingsMap,
    type Http2StreamId,
    type Logger,
} from "./types.js";
import { parseFrame, parseFrameHeader, serializeFrame, FRAME_HEADER_LENGTH } from "./frame/frame.js";
import { encodeHeaders } from "./hpack/hpack.js";
import {
    SettingsAckTimeoutError,
    GoawayReceivedError,
    ConnectionClosedError,
} from "./errors.js";
import { createStreamManager, type StreamManager } from "./stream/stream.js";

/** The fixed client connection preface string (RFC 7540 §3.5). */
const CLIENT_PREFACE = new TextEncoder().encode("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");

/** Default SETTINGS ACK timeout (ms). */
const DEFAULT_SETTINGS_ACK_TIMEOUT_MS = 5_000;

/** Empty byte array constant for optional debug data. */
const EMPTY_BYTES = new Uint8Array(0);

/** Byte type alias matching the `Uint8Array` wire signatures. */
type Bytes = Uint8Array;

/**
 * Concrete HTTP/2 connection. The public surface matches the fixed
 * `Http2Connection` interface; internal state is kept on the instance.
 */
export class Http2ConnectionImpl implements Http2Connection {
    public readonly id: Http2ConnectionId;
    public settings: Http2SettingsMap;

    /** The underlying byte-stream transport. */
    private readonly transport: Http2Options["transport"];
    /** Clock for timeouts + id generation (defaults to systemClock). */
    private readonly clock: Clock;
    /** Crypto provider for non-protocol randomness (e.g. PING opaque data). */
    private readonly provider: CryptoProvider;
    /** Stream manager (also an EventEmitter for connection-level signals). */
    private readonly manager: StreamManager & EventEmitter;
    /** Serializes + writes a frame to the transport. */
    private readonly sendFrame: (frame: Frame) => void;

    /** Logging sink (defaults to silentLogger). Injected via Http2Options. */
    private readonly logger: Logger;
    /** Set once the connection begins graceful shutdown (GOAWAY sent/received). */
    private closing = false;
    /** Set once the connection is fully torn down. */
    private closed = false;
    /** GOAWAY frame the peer sent, if any — used to reject new requests. */
    private receivedGoaway: { lastStreamId: Http2StreamId; errorCode: number; debugData: Bytes } | undefined;
    /** Ids of currently-active client (odd) streams. */
    private readonly activeClientStreams = new Set<Http2StreamId>();
    /** Resolvers waiting on a concurrency slot to free. */
    private readonly slotWaiters: Array<() => void> = [];

    public constructor(
        id: Http2ConnectionId,
        options: Http2Options,
        manager: StreamManager & EventEmitter,
        sendFrame: (frame: Frame) => void,
        provider: CryptoProvider,
    ) {
        this.id = id;
        this.settings = options.initialSettings ?? {};
        this.clock = options.clock ?? systemClock;
        this.transport = options.transport;
        this.manager = manager;
        this.sendFrame = sendFrame;
        this.provider = provider;
        // The logger defaults to silent so library consumers see no output unless
        // they opt in. Assigned here so both the no-arg and full-options paths
        // share the same default.
        this.logger = options.logger ?? silentLogger;
    }

    // --- public Http2Connection surface ----------------------------------------

    public async request(req: Http2Request): Promise<Http2Response> {
        if (this.closing || this.closed) {
            throw this.closingError();
        }
        // Backpressure: wait until a concurrency slot is available.
        await this.acquireSlot();

        const stream = this.manager.openStream();
        this.activeClientStreams.add(stream.id);

        const endStreamNoBody = req.body === undefined || req.body.length === 0;

        return new Promise<Http2Response>((resolve, reject) => {
            // If the connection tore down while we were acquiring a slot, bail.
            if (this.closing || this.closed) {
                this.activeClientStreams.delete(stream.id);
                this.releaseSlot();
                reject(this.closingError());
                return;
            }

            this.manager.expectResponse(stream.id, resolve, reject);
            this.sendHeaders(stream.id, req, endStreamNoBody);

            if (endStreamNoBody) {
                // HEADERS already carried END_STREAM; nothing more to send.
                return;
            }
            // Feed the body through the stream manager's flow-controlled send path.
            this.manager.sendData(stream.id, req.body ?? EMPTY_BYTES, true);
        });
    }

    public goaway(lastStreamId: Http2StreamId, errorCode: number, debugData?: Bytes): Promise<void> {
        this.closing = true;
        this.sendFrame({
            type: FrameType.GOAWAY,
            flags: 0,
            streamId: 0 as Http2StreamId,
            lastStreamId,
            errorCode,
            debugData: debugData ?? EMPTY_BYTES,
        });
        return Promise.resolve();
    }

    public ping(opaqueData?: bigint): Promise<bigint> {
        const data = opaqueData ?? randomUint64(this.provider);
        return new Promise<bigint>((resolve, reject) => {
            if (this.closed) {
                reject(new ConnectionClosedError());
                return;
            }
            // Resolve only on the ACK that echoes *our* opaque data. Late or
            // unrelated ACKs are ignored (the handler self-removes on match).
            const handler = (acked: bigint): void => {
                if (acked === data) {
                    this.manager.off("pingAck", handler);
                    resolve(acked);
                }
            };
            this.manager.on("pingAck", handler);
            this.sendFrame({
                type: FrameType.PING,
                flags: 0,
                streamId: 0 as Http2StreamId,
                ack: false,
                opaqueData: data,
            });
        });
    }

    public async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.closing = true;
        this.logger.debug("closing connection", { id: this.id });
        // Graceful shutdown: GOAWAY(lastStreamId=0) then close the transport.
        // Ignore errors here — the transport may already be gone.
        try {
            this.sendFrame({
                type: FrameType.GOAWAY,
                flags: 0,
                streamId: 0 as Http2StreamId,
                lastStreamId: 0 as Http2StreamId,
                errorCode: 0,
                debugData: EMPTY_BYTES,
            });
        } catch {
            // best-effort
        }
        // Reject anything still in flight, then drop the transport.
        this.manager.abortAll(new ConnectionClosedError());
        this.activeClientStreams.clear();
        this.drainSlotWaiters();
        this.closed = true;
        await this.transport.close({ kind: "client_close" });
    }

    // --- frame I/O -------------------------------------------------------------

    /** Encode request pseudo-headers + headers and send a HEADERS frame. */
    private sendHeaders(streamId: Http2StreamId, req: Http2Request, endStream: boolean): void {
        const headers = new Map<string, string>([
            [":method", req.method],
            [":scheme", req.scheme],
            [":authority", req.authority],
            [":path", req.path],
            ...Array.from(req.headers.entries()),
        ]);
        const encoded = encodeHeaders(headers);
        // END_HEADERS (0x4) always set; END_STREAM (0x1) when there is no body.
        const flags = 0x4 | (endStream ? 0x1 : 0);
        this.sendFrame({
            type: FrameType.HEADERS,
            flags,
            streamId,
            endHeaders: true,
            endStream,
            padded: false,
            payload: encoded,
        });
    }

    // --- concurrency slot pool -------------------------------------------------

    /** Resolve when a concurrency slot is free, honoring MAX_CONCURRENT_STREAMS. */
    private async acquireSlot(): Promise<void> {
        while (
            !this.closing &&
            !this.closed &&
            this.activeClientStreams.size >= this.manager.maxConcurrentStreams
        ) {
            // oxlint-disable-next-line no-await-in-loop -- deliberate one-at-a-time backpressure: each slot frees exactly one waiter
            await new Promise<void>((resolve) => {
                this.slotWaiters.push(resolve);
            });
        }
    }

    /** Release one slot and wake a waiter (if any). */
    private releaseSlot(): void {
        const waiter = this.slotWaiters.shift();
        if (waiter !== undefined) {
            waiter();
        }
    }

    /** Wake every waiting request (used on shutdown). */
    private drainSlotWaiters(): void {
        for (const waiter of this.slotWaiters) {
            waiter();
        }
        this.slotWaiters.length = 0;
    }

    /** Bookkeeping when the manager reports a stream closed. */
    private onStreamClosed(streamId: Http2StreamId): void {
        if (this.activeClientStreams.delete(streamId)) {
            this.releaseSlot();
        }
    }

    /**
     * The error to raise for a request that cannot proceed because the
     * connection is closing. If the peer sent a GOAWAY, surface that as a
     * `GoawayReceivedError`; otherwise a `ConnectionClosedError`.
     */
    private closingError(): GoawayReceivedError | ConnectionClosedError {
        const goaway = this.receivedGoaway;
        return goaway === undefined
            ? new ConnectionClosedError()
            : new GoawayReceivedError(goaway.lastStreamId, goaway.errorCode, goaway.debugData);
    }

    /** Tear down the connection on a fatal transport / dispatch error. */
    private handleFatal(err: Error): void {
        if (this.closed) {
            return;
        }
        this.logger.error("connection fatal error", { id: this.id, error: err.message });
        this.closing = true;
        this.manager.abortAll(err);
        this.activeClientStreams.clear();
        this.drainSlotWaiters();
        this.closed = true;
    }

    // --- read loop + bootstrap -------------------------------------------------

    /**
     * Start the frame read loop. Must be called before awaiting the SETTINGS
     * ACK so frames are actually consumed from the transport.
     */
    public startReadLoop(): void {
        // The manager emits connection-level signals we need to react to:
        //   - "goaway": stop accepting new work.
        //   - "streamClosed": free a concurrency slot.
        this.manager.on("goaway", (lastStreamId: Http2StreamId, errorCode: number, debugData: Bytes) => {
            this.logger.warn("peer sent GOAWAY", {
                id: this.id,
                lastStreamId: String(lastStreamId),
                errorCode,
                debugDataBytes: debugData.length,
            });
            this.receivedGoaway = { lastStreamId, errorCode, debugData };
            this.closing = true;
        });
        this.manager.on("streamClosed", (streamId: Http2StreamId) => {
            this.onStreamClosed(streamId);
        });

        // Fire-and-forget the read loop; it runs until the transport closes.
        void this.readLoop();
    }

    /**
     * Leftover bytes from the last transport read that did not form a complete
     * frame. TCP coalesces writes, so a single read() can return more than one
     * frame; we buffer the surplus here instead of dropping it.
     */
    private readBuffer: Bytes = new Uint8Array(0);

    /** Read the next frame header + payload from the transport. */
    private async readOneFrame(): Promise<Frame> {
        // Top up the header buffer from any leftovers, then from the transport,
        // until we have the 9-byte frame header.
        let headerBytes = this.readBuffer;
        while (headerBytes.length < FRAME_HEADER_LENGTH) {
            // oxlint-disable-next-line no-await-in-loop -- each read depends on accumulated bytes; ordering is inherent
            const extra = await this.transport.read();
            headerBytes = concat(headerBytes, extra);
        }
        const header = parseFrameHeader(headerBytes);
        const total = FRAME_HEADER_LENGTH + header.length;

        // Read until we have the full payload (it may have arrived with the
        // header or in subsequent reads).
        let frameBytes = headerBytes;
        while (frameBytes.length < total) {
            // oxlint-disable-next-line no-await-in-loop -- each read depends on accumulated bytes; ordering is inherent
            const extra = await this.transport.read();
            frameBytes = concat(frameBytes, extra);
        }
        // Stash any trailing bytes past this frame for the next call.
        this.readBuffer = frameBytes.subarray(total) as Bytes;
        return parseFrame(frameBytes.subarray(0, total) as Bytes);
    }

    /**
     * Main read loop: read frames, dispatch them to the stream manager. On a
     * transport error or close, tear the connection down.
     */
    private async readLoop(): Promise<void> {
        try {
            while (!this.closed) {
                // oxlint-disable-next-line no-await-in-loop -- live socket read loop: frames must be processed in arrival order
                const frame = await this.readOneFrame();
                try {
                    this.manager.dispatch(frame);
                } catch (err) {
                    // A dispatch error (e.g. malformed HPACK) is fatal for the
                    // connection per RFC 7540 §4.2 — GOAWAY + teardown.
                    this.handleFatal(err instanceof Error ? err : new Error(String(err)));
                    return;
                }
            }
        } catch (err) {
            // transport.read() rejected: socket closed / error.
            if (!this.closed) {
                this.logger.warn("transport read failed", {
                    id: this.id,
                    error: err instanceof Error ? err.message : String(err),
                });
                this.handleFatal(err instanceof Error ? err : new Error(String(err)));
            }
        }
    }

    /** Resolve once the SETTINGS ACK arrives, or reject after the timeout. */
    public waitForSettingsAck(timeoutMs: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const timer = this.clock.setTimeout(() => {
                this.manager.off("settingsAck", onAck);
                this.logger.error("SETTINGS ACK timeout", { id: this.id, timeoutMs });
                reject(new SettingsAckTimeoutError(timeoutMs));
                this.handleFatal(new SettingsAckTimeoutError(timeoutMs));
            }, timeoutMs);

            const onAck = (): void => {
                this.clock.clearTimeout(timer);
                this.manager.off("settingsAck", onAck);
                this.logger.debug("SETTINGS handshake complete", { id: this.id, settings: this.settings });
                resolve();
            };
            this.manager.once("settingsAck", onAck);
        });
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Concatenate two byte arrays. */
function concat(a: Bytes, b: Bytes): Bytes {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/** A random 64-bit opaque value for PING frames. */
function randomUint64(provider: CryptoProvider): bigint {
    const bytes = provider.randomBytes(8);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const hi = BigInt(view.getUint32(0));
    const lo = BigInt(view.getUint32(4));
    return (hi << 32n) | lo;
}

// ---------------------------------------------------------------------------
// connectHttp2
// ---------------------------------------------------------------------------

/**
 * Establish an HTTP/2 connection over an existing transport.
 *
 * Performs the connection preface (client connection preface string + SETTINGS
 * frame) and waits for the peer's SETTINGS ACK.
 */
export async function connectHttp2(options: Http2Options): Promise<Http2Connection> {
    const clock = options.clock ?? systemClock;
    const id = `http2_${clock.now().toString(36)}` as Http2ConnectionId;
    const timeoutMs = options.settingsAckTimeoutMs ?? DEFAULT_SETTINGS_ACK_TIMEOUT_MS;
    const provider = options.crypto ?? crypto;

    // Single frame-sending callback shared by the manager and the connection.
    const sendFrame = (frame: Frame): void => {
        const bytes = serializeFrame(frame);
        void options.transport.write(bytes).catch(() => {
            // Write failures surface on the transport's error/close path; the
            // read loop will tear down the connection.
        });
    };

    const manager = createStreamManager(sendFrame);
    const conn = new Http2ConnectionImpl(id, options, manager, sendFrame, provider);

    // Write the client connection preface (RFC 7540 §3.5):
    //   PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n  +  SETTINGS frame.
    await options.transport.write(CLIENT_PREFACE);
    sendFrame({
        type: FrameType.SETTINGS,
        flags: 0,
        streamId: 0 as Http2StreamId,
        ack: false,
        settings: options.initialSettings ?? {},
    });

    // Start consuming frames BEFORE awaiting the ACK so we don't deadlock if
    // the peer's SETTINGS + ACK arrive back-to-back.
    conn.startReadLoop();

    await conn.waitForSettingsAck(timeoutMs);
    return conn;
}
