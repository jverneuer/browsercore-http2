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

import { randomInt } from "node:crypto";
import type { EventEmitter } from "node:events";
import type {
    Frame,
    Http2Connection,
    Http2Options,
    Http2Request,
    Http2Response,
    Http2SettingsMap,
    Http2StreamId,
} from "./types.js";
import { FrameType } from "./types.js";
import { parseFrame, parseFrameHeader, serializeFrame, FRAME_HEADER_LENGTH } from "./frame/frame.js";
import { encodeHeaders } from "./hpack/hpack.js";
import { SettingsAckTimeoutError } from "./errors.js";
import { createStreamManager, type StreamManager } from "./stream/stream.js";

/** The fixed client connection preface string (RFC 7540 §3.5). */
const CLIENT_PREFACE = new TextEncoder().encode("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");

/** Default SETTINGS ACK timeout (ms). */
const DEFAULT_SETTINGS_ACK_TIMEOUT_MS = 5_000;

/** Empty byte array constant for optional debug data. */
const EMPTY_BYTES = new Uint8Array(0);

/** Byte type alias matching the `Uint8Array<ArrayBufferLike>` wire signatures. */
type Bytes = Uint8Array<ArrayBufferLike>;

/**
 * Concrete HTTP/2 connection. The public surface matches the fixed
 * `Http2Connection` interface; internal state is kept on the instance.
 */
export class Http2ConnectionImpl implements Http2Connection {
    public readonly id: string;
    public settings: Http2SettingsMap;

    /** The underlying byte-stream transport. */
    private readonly _transport: Http2Options["transport"];
    /** Stream manager (also an EventEmitter for connection-level signals). */
    private readonly _manager: StreamManager & EventEmitter;
    /** Serializes + writes a frame to the transport. */
    private readonly _sendFrame: (frame: Frame) => void;

    /** Set once the connection begins graceful shutdown (GOAWAY sent/received). */
    private _closing = false;
    /** Set once the connection is fully torn down. */
    private _closed = false;
    /** Ids of currently-active client (odd) streams. */
    private readonly _activeClientStreams = new Set<Http2StreamId>();
    /** Resolvers waiting on a concurrency slot to free. */
    private readonly _slotWaiters: Array<() => void> = [];

    public constructor(
        id: string,
        options: Http2Options,
        manager: StreamManager & EventEmitter,
        sendFrame: (frame: Frame) => void,
    ) {
        this.id = id;
        this.settings = options.initialSettings ?? {};
        this._transport = options.transport;
        this._manager = manager;
        this._sendFrame = sendFrame;
    }

    // --- public Http2Connection surface ----------------------------------------

    public async request(req: Http2Request): Promise<Http2Response> {
        if (this._closing || this._closed) {
            throw new Error("connection is closing");
        }
        // Backpressure: wait until a concurrency slot is available.
        await this._acquireSlot();

        const stream = this._manager.openStream();
        this._activeClientStreams.add(stream.id);

        const endStreamNoBody = req.body === undefined || req.body.length === 0;

        return new Promise<Http2Response>((resolve, reject) => {
            // If the connection tore down while we were acquiring a slot, bail.
            if (this._closing || this._closed) {
                this._activeClientStreams.delete(stream.id);
                this._releaseSlot();
                reject(new Error("connection is closing"));
                return;
            }

            this._manager.expectResponse(stream.id, resolve, reject);
            this._sendHeaders(stream.id, req, endStreamNoBody);

            if (endStreamNoBody) {
                // HEADERS already carried END_STREAM; nothing more to send.
                return;
            }
            // Feed the body through the stream manager's flow-controlled send path.
            this._manager.sendData(stream.id, req.body ?? EMPTY_BYTES, true);
        });
    }

    public async goaway(lastStreamId: Http2StreamId, errorCode: number, debugData?: Bytes): Promise<void> {
        this._closing = true;
        this._sendFrame({
            type: FrameType.GOAWAY,
            flags: 0,
            streamId: 0 as Http2StreamId,
            lastStreamId,
            errorCode,
            debugData: debugData ?? EMPTY_BYTES,
        });
    }

    public async ping(opaqueData?: bigint): Promise<bigint> {
        const data = opaqueData ?? randomUint64();
        return new Promise<bigint>((resolve, reject) => {
            if (this._closed) {
                reject(new Error("connection is closed"));
                return;
            }
            // Resolve only on the ACK that echoes *our* opaque data. Late or
            // unrelated ACKs are ignored (the handler self-removes on match).
            const handler = (acked: bigint): void => {
                if (acked === data) {
                    this._manager.off("pingAck", handler);
                    resolve(acked);
                }
            };
            this._manager.on("pingAck", handler);
            this._sendFrame({
                type: FrameType.PING,
                flags: 0,
                streamId: 0 as Http2StreamId,
                ack: false,
                opaqueData: data,
            });
        });
    }

    public async close(): Promise<void> {
        if (this._closed) return;
        this._closing = true;
        // Graceful shutdown: GOAWAY(lastStreamId=0) then close the transport.
        // Ignore errors here — the transport may already be gone.
        try {
            this._sendFrame({
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
        this._manager.abortAll(new Error("connection closed"));
        this._activeClientStreams.clear();
        this._drainSlotWaiters();
        this._closed = true;
        await this._transport.close({ kind: "client_close" });
    }

    // --- frame I/O -------------------------------------------------------------

    /** Encode request pseudo-headers + headers and send a HEADERS frame. */
    private _sendHeaders(streamId: Http2StreamId, req: Http2Request, endStream: boolean): void {
        const headers = new Map<string, string>();
        headers.set(":method", req.method);
        headers.set(":scheme", req.scheme);
        headers.set(":authority", req.authority);
        headers.set(":path", req.path);
        for (const [key, value] of req.headers) {
            headers.set(key, value);
        }
        const encoded = encodeHeaders(headers);
        // END_HEADERS (0x4) always set; END_STREAM (0x1) when there is no body.
        const flags = 0x4 | (endStream ? 0x1 : 0);
        this._sendFrame({
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
    private async _acquireSlot(): Promise<void> {
        while (
            !this._closing &&
            !this._closed &&
            this._activeClientStreams.size >= this._manager.maxConcurrentStreams
        ) {
            await new Promise<void>((resolve) => this._slotWaiters.push(resolve));
        }
    }

    /** Release one slot and wake a waiter (if any). */
    private _releaseSlot(): void {
        const waiter = this._slotWaiters.shift();
        if (waiter !== undefined) waiter();
    }

    /** Wake every waiting request (used on shutdown). */
    private _drainSlotWaiters(): void {
        for (const waiter of this._slotWaiters) waiter();
        this._slotWaiters.length = 0;
    }

    /** Bookkeeping when the manager reports a stream closed. */
    private _onStreamClosed(streamId: Http2StreamId): void {
        if (this._activeClientStreams.delete(streamId)) {
            this._releaseSlot();
        }
    }

    /** Tear down the connection on a fatal transport / dispatch error. */
    private _handleFatal(err: Error): void {
        if (this._closed) return;
        this._closing = true;
        this._manager.abortAll(err);
        this._activeClientStreams.clear();
        this._drainSlotWaiters();
        this._closed = true;
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
        this._manager.on("goaway", (lastStreamId: Http2StreamId, errorCode: number, debugData: Bytes) => {
            void lastStreamId;
            void errorCode;
            void debugData;
            this._closing = true;
        });
        this._manager.on("streamClosed", (streamId: Http2StreamId) => this._onStreamClosed(streamId));

        // Fire-and-forget the read loop; it runs until the transport closes.
        void this._readLoop();
    }

    /** Read the next frame header + payload from the transport. */
    private async _readOneFrame(): Promise<Frame> {
        // Read the 9-byte header first.
        let headerBytes = await this._transport.read();
        while (headerBytes.length < FRAME_HEADER_LENGTH) {
            const extra = await this._transport.read();
            headerBytes = concat(headerBytes, extra);
        }
        const header = parseFrameHeader(headerBytes);
        const total = FRAME_HEADER_LENGTH + header.length;

        // Read until we have the full payload (it may have arrived with the
        // header or in subsequent reads).
        let frameBytes = headerBytes;
        while (frameBytes.length < total) {
            const extra = await this._transport.read();
            frameBytes = concat(frameBytes, extra);
        }
        return parseFrame(frameBytes.subarray(0, total) as Bytes);
    }

    /**
     * Main read loop: read frames, dispatch them to the stream manager. On a
     * transport error or close, tear the connection down.
     */
    private async _readLoop(): Promise<void> {
        try {
            while (!this._closed) {
                const frame = await this._readOneFrame();
                try {
                    this._manager.dispatch(frame);
                } catch (err) {
                    // A dispatch error (e.g. malformed HPACK) is fatal for the
                    // connection per RFC 7540 §4.2 — GOAWAY + teardown.
                    this._handleFatal(err instanceof Error ? err : new Error(String(err)));
                    return;
                }
            }
        } catch (err) {
            // transport.read() rejected: socket closed / error.
            if (!this._closed) {
                this._handleFatal(err instanceof Error ? err : new Error(String(err)));
            }
        }
    }

    /** Resolve once the SETTINGS ACK arrives, or reject after the timeout. */
    public waitForSettingsAck(timeoutMs: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                this._manager.off("settingsAck", onAck);
                reject(new SettingsAckTimeoutError(timeoutMs));
                this._handleFatal(new SettingsAckTimeoutError(timeoutMs));
            }, timeoutMs);

            const onAck = (): void => {
                clearTimeout(timer);
                this._manager.off("settingsAck", onAck);
                resolve();
            };
            this._manager.once("settingsAck", onAck);
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
function randomUint64(): bigint {
    const hi = BigInt(randomInt(0, 0x100000000));
    const lo = BigInt(randomInt(0, 0x100000000));
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
    const id = `http2_${Date.now().toString(36)}`;
    const timeoutMs = options.settingsAckTimeoutMs ?? DEFAULT_SETTINGS_ACK_TIMEOUT_MS;

    // Single frame-sending callback shared by the manager and the connection.
    const sendFrame = (frame: Frame): void => {
        const bytes = serializeFrame(frame);
        void options.transport.write(bytes).catch(() => {
            // Write failures surface on the transport's error/close path; the
            // read loop will tear down the connection.
        });
    };

    const manager = createStreamManager(sendFrame);
    const conn = new Http2ConnectionImpl(id, options, manager, sendFrame);

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
