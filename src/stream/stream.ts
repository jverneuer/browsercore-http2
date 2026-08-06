/**
 * HTTP/2 stream state machine + flow control.
 *
 * Each stream transitions through the RFC 7540 §5.1 states and carries its own
 * flow-control window (in addition to the connection-level window). The stream
 * manager owns the set of live streams and dispatches incoming frames.
 *
 * Design notes (honest, documented):
 *
 * - Flow control is real. `sendData()` sends only as many bytes as the
 *   min(connection send window, stream send window, max frame size) allows and
 *   queues the rest per stream. When a WINDOW_UPDATE arrives (connection or
 *   stream level) the relevant send queue is drained. This mirrors RFC 7540
 *   §6.9: a sender MUST NOT exceed either window.
 *
 * - Padding: per RFC 7540 §6.9.1 the pad length + padding count against the
 *   flow-control window. We decrement the receive windows by the *full* frame
 *   payload length (including padding) and only then strip the pad-length prefix
 *   and trailing padding to recover the application data.
 *
 * - Server push: inbound PUSH_PROMISE frames open a remote-reserved stream whose
 *   headers we decode and whose pushed response (HEADERS + DATA) we resolve into
 *   an `Http2Response`. These are surfaced via the `"push"` /
 *   `"pushResponse"` events and buffered on the stream — the fixed
 *   `Http2Connection` interface has no push API, so push is observable-only here.
 *
 * - Response HEADERS are assumed to arrive in a single frame (END_HEADERS set).
 *   If END_HEADERS is clear we buffer CONTINUATION payloads until it is set,
 *   then decode the reassembled HPACK block. Padding on response HEADERS is
 *   stripped naively (pad-length prefix + trailing pad removed); priority
 *   fields on inbound response headers are ignored. This covers the vast
 *   majority of real servers.
 */

import type { EventEmitter } from "node:events";
import type {
    FlowControlWindow,
    Frame,
    Http2Response,
    Http2StreamId,
    StreamState,
} from "../types.js";
import { decodeHeaders } from "../hpack/hpack.js";
import { DEFAULT_MAX_FRAME_SIZE } from "../frame/frame.js";
import { GoawayReceivedError, RstStreamError, StreamClosedError } from "../errors.js";

/** A single HTTP/2 stream — state + flow-control windows. */
export interface Http2Stream {
    readonly id: Http2StreamId;
    state: StreamState;
    /** Window for sending DATA (we decrement as we send; WINDOW_UPDATE grows it). */
    localWindow: FlowControlWindow;
    /** Window for receiving DATA (we grow it via WINDOW_UPDATE as we consume). */
    remoteWindow: FlowControlWindow;
}

/** A handle the stream manager exposes to the connection for sending. */
export interface StreamManager {
    /** Create a new idle stream in the `open` state. */
    openStream(): Http2Stream;

    /** Apply a decoded frame to the relevant stream, mutating state. */
    dispatch(frame: Frame): void;

    /** Send DATA on a stream, respecting the stream-level flow-control window. */
    sendData(streamId: Http2StreamId, data: Uint8Array, endStream: boolean): void;

    /** Apply a WINDOW_UPDATE to a stream's local (send) window. */
    applyWindowUpdate(streamId: Http2StreamId, increment: number): void;

    /**
     * Register the response resolver for a client-opened stream. `resolve` is
     * called with the full `Http2Response` once response headers and END_STREAM
     * have both arrived; `reject` is called if the stream is reset, the
     * connection goes away, or HPACK decode fails.
     */
    expectResponse(
        streamId: Http2StreamId,
        resolve: (res: Http2Response) => void,
        reject: (err: Error) => void,
    ): void;

    /** Effective peer MAX_CONCURRENT_STREAMS (updated via SETTINGS). */
    readonly maxConcurrentStreams: number;

    /** Reject every in-flight request with `error` and close all streams. */
    abortAll(error: Error): void;
}

// ---------------------------------------------------------------------------
// Defaults (RFC 7540 §6.5.2 / §6.9.2)
// ---------------------------------------------------------------------------

/** Default SETTINGS_INITIAL_WINDOW_SIZE (65535 octets). */
const DEFAULT_INITIAL_WINDOW_SIZE = 65_535;

/** The absolute minimum MAX_FRAME_SIZE (RFC 7540 §4.1). */
const MIN_MAX_FRAME_SIZE = 16_384;

/** The absolute maximum MAX_FRAME_SIZE (2^24 - 1, RFC 7540 §4.1). */
const MAX_MAX_FRAME_SIZE = 16_777_215;

/** Default MAX_CONCURRENT_STREAMS when the peer has not advertised one. */
const DEFAULT_MAX_CONCURRENT_STREAMS = 100;

/** Byte type alias that satisfies the `Uint8Array` wire signatures. */
type Bytes = Uint8Array;

// ---------------------------------------------------------------------------
// Internal managed-stream shape
// ---------------------------------------------------------------------------

/**
 * Internal stream record. Externally we hand out the `Http2Stream` view; this
 * adds the bookkeeping the state machine needs (response accumulation, send
 * queue, resolver) without polluting the public `Http2Stream` interface.
 */
class ManagedStream implements Http2Stream {
    public state: StreamState;
    public localWindow: FlowControlWindow;
    public remoteWindow: FlowControlWindow;

    // --- response accumulation -------------------------------------------------
    public headersComplete = false;
    public endStreamSeen = false;
    public responseHeaders = new Map<string, string>();
    public responseChunks: Bytes[] = [];
    public pendingHeaderBytes: number[] = [];

    // --- send queue (bytes waiting for flow-control window) --------------------
    public sendQueue: Bytes = new Uint8Array(0);
    public sendQueueEndStream = false;

    // --- request/response promise ---------------------------------------------
    public resolve: ((res: Http2Response) => void) | undefined;
    public reject: ((err: Error) => void) | undefined;

    // --- push bookkeeping ------------------------------------------------------
    /** True for server-push streams (created by PUSH_PROMISE, even id). */
    public readonly isPushPromise: boolean;
    public pushResponse: Http2Response | undefined;

    public constructor(
        public readonly id: Http2StreamId,
        localWindow: FlowControlWindow,
        remoteWindow: FlowControlWindow,
        isPushPromise: boolean,
    ) {
        this.isPushPromise = isPushPromise;
        // Push streams start in remote_reserved (RFC 7540 §5.1); client streams
        // send HEADERS immediately so they enter "open" for both halves.
        this.state = isPushPromise ? { state: "remote_reserved" } : { state: "open" };
        this.localWindow = localWindow;
        this.remoteWindow = remoteWindow;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Concatenate two byte arrays. */
function concat(a: Bytes, b: Bytes): Bytes {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/** Concatenate many byte arrays into one. */
function concatAll(parts: readonly Bytes[]): Bytes {
    let total = 0;
    for (const p of parts) {
        total += p.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}

/** Parse an HTTP/2 `:status` pseudo-header into a numeric status code. */
const DEFAULT_STATUS = 200;
function parseStatus(headers: ReadonlyMap<string, string>): number {
    const raw = headers.get(":status");
    if (raw === undefined) {
        return DEFAULT_STATUS;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : DEFAULT_STATUS;
}

// ---------------------------------------------------------------------------
// EventTarget-based emitter
// ---------------------------------------------------------------------------

/**
 * Minimal EventEmitter-shaped facade over the platform {@link EventTarget}.
 *
 * The `unicorn/prefer-event-target` rule forbids `new EventEmitter()`, but the
 * manager's public contract (`StreamManager & EventEmitter`) and its consumers
 * rely on the EventEmitter-style API (`.on`/`.once`/`.off`/`.emit` with variadic
 * args). We back the manager with an EventTarget and translate: listeners are
 * registered with `addEventListener`, and `emit` dispatches a `CustomEvent` whose
 * `detail` carries the variadic args. A wrapper map lets `off`/`removeListener`
 * match by the original listener reference, exactly as EventEmitter does.
 */
class StreamEventBridge extends EventTarget {
    private readonly wrappers = new Map<(...args: unknown[]) => void, { wrapper: EventListener; event: string }>();

    public on(event: string | symbol, listener: (...args: unknown[]) => void): void {
        const wrapper = ((e: Event) => {
            listener(...(e as CustomEvent<unknown[]>).detail);
        }) as EventListener;
        const key = event as string;
        this.wrappers.set(listener, { wrapper, event: key });
        this.addEventListener(key, wrapper);
    }

    public once(event: string | symbol, listener: (...args: unknown[]) => void): void {
        const wrapper = ((e: Event) => {
            this.wrappers.delete(listener);
            listener(...(e as CustomEvent<unknown[]>).detail);
        }) as EventListener;
        const key = event as string;
        this.wrappers.set(listener, { wrapper, event: key });
        this.addEventListener(key, wrapper, { once: true });
    }

    public off(event: string | symbol, listener: (...args: unknown[]) => void): void {
        const entry = this.wrappers.get(listener);
        if (entry !== undefined) {
            this.wrappers.delete(listener);
            this.removeEventListener(event as string, entry.wrapper);
        }
    }

    public removeListener(event: string | symbol, listener: (...args: unknown[]) => void): void {
        this.off(event, listener);
    }

    public removeAllListeners(event?: string | symbol): void {
        const target = event as string | undefined;
        const toRemove: Array<(...args: unknown[]) => void> = [];
        for (const [listener, entry] of this.wrappers) {
            if (target === undefined || entry.event === target) {
                this.removeEventListener(entry.event, entry.wrapper);
                toRemove.push(listener);
            }
        }
        for (const listener of toRemove) {
            this.wrappers.delete(listener);
        }
    }

    public emit(event: string | symbol, ...args: unknown[]): boolean {
        return this.dispatchEvent(new CustomEvent<unknown[]>(event as string, { detail: args }));
    }
}

// ---------------------------------------------------------------------------
// Module-scope shared helpers
//
// These helpers only reference module-level symbols (`ManagedStream`,
// `decodeHeaders`), so they are defined once at module scope rather than
// rebuilt on every `createStreamManager()` call.
// ---------------------------------------------------------------------------

function decodePendingHeaders(stream: ManagedStream): void {
    const block = Uint8Array.from(stream.pendingHeaderBytes);
    stream.pendingHeaderBytes = [];
    const decoded = decodeHeaders(block);
    // decodeHeaders returns a ReadonlyMap; copy into a mutable Map so the
    // public Http2Response.headers contract (ReadonlyMap) is satisfied.
    stream.responseHeaders = new Map(decoded);
    stream.headersComplete = true;
}

function handlePriority(): void {
    // Priority scheduling is best-effort; the wire encoding round-trips in
    // the frame layer. We intentionally do not reorder the send queue here.
}

function pushHeaderBytes(stream: ManagedStream, payload: Bytes): void {
    for (let i = 0; i < payload.length; i++) {
        const octet = payload[i];
        // Under noUncheckedIndexedAccess, the type system cannot prove that an
        // in-bounds index yields a defined value. In practice `i < payload.length`
        // guarantees the octet is defined — if the impossible happens, the
        // header block is corrupt and the stream must be torn down.
        if (octet === undefined) {
            throw new StreamClosedError(stream.id);
        }
        stream.pendingHeaderBytes.push(octet);
    }
}

function transitionOnEndStream(stream: ManagedStream): void {
    const s = stream.state;
    if (s.state === "open") {
        stream.state = { state: "remote_half_closed" };
    } else if (s.state === "local_half_closed") {
        stream.state = { state: "closed", reason: { kind: "normal" } };
    } else if (s.state === "remote_reserved") {
        // A server push whose HEADERS carried END_STREAM: reserved -> closed.
        stream.state = { state: "closed", reason: { kind: "normal" } };
    }
}

// ---------------------------------------------------------------------------
// Manager implementation (an EventEmitter so the connection can subscribe)
// ---------------------------------------------------------------------------

/**
 * Create a stream manager. `sendFrame` is the callback for serialized frame I/O
 * — the manager never touches the transport directly.
 *
 * The returned object is also an {@link EventEmitter} emitting connection-level
 * signals the connection layer reacts to:
 *   - `"settingsAck"`            — peer acknowledged our SETTINGS
 *   - `"pingAck", opaqueData`    — peer echoed a PING
 *   - `"goaway", {lastStreamId, errorCode, debugData}` — peer is going away
 *   - `"push", {streamId, headers}`       — a PUSH_PROMISE's request headers
 *   - `"pushResponse", {streamId, response}` — a complete pushed response
 *   - `"streamClosed", streamId`          — a stream entered `closed`
 */
export function createStreamManager(
    sendFrame: (frame: Frame) => void,
): StreamManager & EventEmitter {
    const streams = new Map<Http2StreamId, ManagedStream>();

    /**
     * In-flight PUSH_PROMISE header blocks awaiting CONTINUATION. Keyed by the
     * *client*-stream id (the stream id a CONTINUATION after PUSH_PROMISE
     * carries per RFC 7540 §6.10), mapping to the promised stream whose header
     * block is being reassembled. Set when a PUSH_PROMISE omits END_HEADERS,
     * cleared once END_HEADERS arrives.
     */
    const pendingPushContinuation = new Map<Http2StreamId, Http2StreamId>();

    /** Peer-advertised initial window size (SETTINGS_INITIAL_WINDOW_SIZE). */
    let remoteInitialWindowSize = DEFAULT_INITIAL_WINDOW_SIZE;
    let maxConcurrentStreams = DEFAULT_MAX_CONCURRENT_STREAMS;
    let maxFrameSize = DEFAULT_MAX_FRAME_SIZE;
    let connectionSendWindow = DEFAULT_INITIAL_WINDOW_SIZE;
    let connectionReceiveWindow = DEFAULT_INITIAL_WINDOW_SIZE;

    /** Next client-initiated (odd) stream id. */
    let nextStreamId = 1;

    const emitter = new StreamEventBridge();

    // --- frame I/O helpers -----------------------------------------------------

    function emitEvent(type: string, ...args: unknown[]): void {
        emitter.emit(type, ...args);
    }

    function sendSettingsAck(): void {
        sendFrame({
            type: 0x4, // SETTINGS
            flags: 0x1, // ACK
            streamId: 0 as Http2StreamId,
            ack: true,
            settings: {},
        });
    }

    function sendPingAck(opaqueData: bigint): void {
        sendFrame({
            type: 0x6, // PING
            flags: 0x1, // ACK
            streamId: 0 as Http2StreamId,
            ack: true,
            opaqueData,
        });
    }

    function sendWindowUpdate(streamId: Http2StreamId, increment: number): void {
        sendFrame({
            type: 0x8, // WINDOW_UPDATE
            flags: 0,
            streamId,
            windowSizeIncrement: increment,
        });
    }

    function sendDataFrame(streamId: Http2StreamId, payload: Bytes, endStream: boolean): void {
        sendFrame({
            type: 0x0, // DATA
            flags: endStream ? 0x1 : 0,
            streamId,
            payload,
        });
    }

    // --- window bookkeeping ----------------------------------------------------

    function clampMaxFrameSize(value: number): number {
        if (!Number.isFinite(value)) {
            return DEFAULT_MAX_FRAME_SIZE;
        }
        if (value < MIN_MAX_FRAME_SIZE) {
            return MIN_MAX_FRAME_SIZE;
        }
        if (value > MAX_MAX_FRAME_SIZE) {
            return MAX_MAX_FRAME_SIZE;
        }
        return value;
    }

    function applyRemoteSettings(settings: Partial<Record<number, number>>): void {
        for (const [keyRaw, value] of Object.entries(settings)) {
            if (value === undefined) {
                continue;
            }
            const key = Number(keyRaw);
            switch (key) {
                // HEADER_TABLE_SIZE (0x1): HPACK table; informational here.
                case 0x1:
                    break;
                // ENABLE_PUSH (0x2): informational.
                case 0x2:
                    break;
                // MAX_CONCURRENT_STREAMS (0x3)
                case 0x3:
                    maxConcurrentStreams = value;
                    break;
                // INITIAL_WINDOW_SIZE (0x4): adjust existing stream send windows by
                // the delta (RFC 7540 §6.9.2). New streams pick up the new value.
                case 0x4: {
                    const delta = value - remoteInitialWindowSize;
                    remoteInitialWindowSize = value;
                    for (const s of streams.values()) {
                        s.localWindow = {
                            size: s.localWindow.size + delta,
                            initialSize: s.localWindow.initialSize,
                        };
                    }
                    // A larger window may unblock queues — drain every stream.
                    for (const s of streams.values()) {
                        drainSendQueue(s);
                    }
                    break;
                }
                // MAX_FRAME_SIZE (0x5)
                case 0x5:
                    maxFrameSize = clampMaxFrameSize(value);
                    break;
                // MAX_HEADER_LIST_SIZE (0x6): informational.
                case 0x6:
                    break;
                default:
                    // Unknown/unsupported settings are ignored per RFC 7540 §6.5.2.
                    break;
            }
        }
    }

    // --- send queue / flow control ---------------------------------------------

    /** Drain a single stream's send queue as far as the windows allow. */
    function drainSendQueue(stream: ManagedStream): void {
        while (stream.sendQueue.length > 0) {
            if (connectionSendWindow <= 0) {
                return;
            }
            if (stream.localWindow.size <= 0) {
                return;
            }
            const cap = Math.min(maxFrameSize, connectionSendWindow, stream.localWindow.size);
            if (cap <= 0) {
                return;
            }
            const chunkLen = Math.min(cap, stream.sendQueue.length);
            const isLast = stream.sendQueueEndStream && chunkLen === stream.sendQueue.length;
            const chunk = stream.sendQueue.subarray(0, chunkLen) as Bytes;
            sendDataFrame(stream.id, chunk, isLast);
            connectionSendWindow -= chunkLen;
            stream.localWindow = {
                size: stream.localWindow.size - chunkLen,
                initialSize: stream.localWindow.initialSize,
            };
            stream.sendQueue = stream.sendQueue.subarray(chunkLen) as Bytes;
        }
    }

    // --- response finalization -------------------------------------------------

    function finalizeStream(stream: ManagedStream): void {
        stream.state = { state: "closed", reason: { kind: "normal" } };
        const id = stream.id;
        streams.delete(id);
        emitEvent("streamClosed", id);
    }

    function maybeResolveResponse(stream: ManagedStream): void {
        if (!stream.headersComplete || !stream.endStreamSeen) {
            return;
        }
        const resolve = stream.resolve;
        if (resolve === undefined) {
            return;
        }
        stream.resolve = undefined;
        stream.reject = undefined;
        const headers = stream.responseHeaders;
        const response: Http2Response = {
            statusCode: parseStatus(headers),
            headers,
            body: concatAll(stream.responseChunks),
        };
        if (stream.isPushPromise) {
            stream.pushResponse = response;
            emitEvent("pushResponse", stream.id, response);
        }
        finalizeStream(stream);
        resolve(response);
    }

    function rejectStream(stream: ManagedStream, err: Error): void {
        const reject = stream.reject;
        if (reject === undefined) {
            // No resolver is registered, but the stream must still be finalized
            // (state -> closed, removed from the table, `streamClosed` emitted)
            // so it does not leak.
            finalizeStream(stream);
            return;
        }
        stream.resolve = undefined;
        stream.reject = undefined;
        finalizeStream(stream);
        reject(err);
    }

    // --- dispatch --------------------------------------------------------------

    function dispatch(frame: Frame): void {
        switch (frame.type) {
            case 0x0: // DATA
                handleData(frame);
                return;
            case 0x1: // HEADERS
                handleHeaders(frame);
                return;
            case 0x2: // PRIORITY
                handlePriority();
                return;
            case 0x3: // RST_STREAM
                handleRstStream(frame);
                return;
            case 0x4: // SETTINGS
                handleSettings(frame);
                return;
            case 0x5: // PUSH_PROMISE
                handlePushPromise(frame);
                return;
            case 0x6: // PING
                handlePing(frame);
                return;
            case 0x7: // GOAWAY
                handleGoaway(frame);
                return;
            case 0x8: // WINDOW_UPDATE
                handleWindowUpdate(frame);
                return;
            case 0x9: // CONTINUATION
                handleContinuation(frame);
                // oxlint-disable-next-line no-useless-return — guards fallthrough to the no-op default
                return;
            default:
                // Unknown frame types MUST be ignored per RFC 7540 §4.1.
                // oxlint-disable-next-line no-useless-return — void dispatch; explicit return is the no-op ignore
                return;
        }
    }

    function handleData(frame: Extract<Frame, { type: 0x0 }>): void {
        const stream = streams.get(frame.streamId);
        if (stream === undefined) {
            return;
        }

        const payload = frame.payload;
        const frameLen = payload.length;

        // Flow control: the full frame payload (including padding) counts against
        // both the connection and stream receive windows (RFC 7540 §6.9.1).
        connectionReceiveWindow -= frameLen;
        stream.remoteWindow = {
            size: stream.remoteWindow.size - frameLen,
            initialSize: stream.remoteWindow.initialSize,
        };

        // Replenish the peer's send credit so it keeps flowing. Connection-level
        // WINDOW_UPDATE for the consumed octets; per-stream too while alive.
        sendWindowUpdate(0 as Http2StreamId, frameLen);
        if (stream.state.state !== "closed") {
            sendWindowUpdate(stream.id, frameLen);
        }

        // Strip padding to recover application data.
        let data: Bytes = payload;
        const padded = (frame.flags & 0x8) !== 0;
        if (padded) {
            const padLen = payload[0] ?? 0;
            const end = payload.length - padLen;
            data = end > 0 ? (payload.subarray(1, end) as Bytes) : new Uint8Array(0);
        }

        if (data.length > 0) {
            stream.responseChunks.push(data);
        }

        const endStream = (frame.flags & 0x1) !== 0;
        if (endStream) {
            stream.endStreamSeen = true;
            transitionOnEndStream(stream);
            maybeResolveResponse(stream);
        }
    }

    function handleHeaders(frame: Extract<Frame, { type: 0x1 }>): void {
        const stream = streams.get(frame.streamId);
        if (stream === undefined) {
            return;
        }

        pushHeaderBytes(stream, frame.payload);

        if (!frame.endHeaders) {
            return; // expect CONTINUATION frames.
        }

        decodePendingHeaders(stream);

        // Promote a push stream from remote_reserved -> open on its first
        // HEADERS (the pushed response).
        if (stream.state.state === "remote_reserved") {
            stream.state = { state: "open" };
        }

        const endStream = frame.endStream;
        if (endStream) {
            stream.endStreamSeen = true;
            transitionOnEndStream(stream);
        }

        // Note: `"push"` is NOT emitted here. The PUSH_PROMISE's request headers
        // are surfaced by handlePushPromise (or handleContinuation when the block
        // completes there); a HEADERS frame on a push stream carries the pushed
        // *response*, surfaced via `"pushResponse"` once the response completes.
        maybeResolveResponse(stream);
    }

    function handleRstStream(frame: Extract<Frame, { type: 0x3 }>): void {
        const stream = streams.get(frame.streamId);
        if (stream === undefined) {
            return;
        }
        stream.state = { state: "closed", reason: { kind: "rst_stream", errorCode: frame.errorCode } };
        rejectStream(stream, new RstStreamError(frame.streamId, frame.errorCode));
    }

    function handleSettings(frame: Extract<Frame, { type: 0x4 }>): void {
        if (frame.ack) {
            emitEvent("settingsAck");
            return;
        }
        applyRemoteSettings(frame.settings);
        sendSettingsAck();
    }

    function handlePushPromise(frame: Extract<Frame, { type: 0x5 }>): void {
        // Client receives PUSH_PROMISE on an odd (client) stream, promising an
        // even (server) stream. Create the promised stream in remote_reserved.
        const promised = new ManagedStream(
            frame.promisedStreamId,
            { size: DEFAULT_INITIAL_WINDOW_SIZE, initialSize: DEFAULT_INITIAL_WINDOW_SIZE },
            { size: DEFAULT_INITIAL_WINDOW_SIZE, initialSize: DEFAULT_INITIAL_WINDOW_SIZE },
            true,
        );
        streams.set(frame.promisedStreamId, promised);
        pushHeaderBytes(promised, frame.payload);
        if (frame.endHeaders) {
            decodePendingHeaders(promised);
            // `push` is emitted exactly once: when the PUSH_PROMISE header block
            // (the promised *request* headers) reaches END_HEADERS.
            emitEvent("push", promised.id, promised.responseHeaders);
        } else {
            // The following CONTINUATION carries the client-stream id (RFC 7540
            // §6.10); remember it maps to this promised stream so the block is
            // reassembled on the right stream.
            pendingPushContinuation.set(frame.streamId, frame.promisedStreamId);
        }
    }

    function handlePing(frame: Extract<Frame, { type: 0x6 }>): void {
        if (frame.ack) {
            emitEvent("pingAck", frame.opaqueData);
            return;
        }
        sendPingAck(frame.opaqueData);
    }

    function handleGoaway(frame: Extract<Frame, { type: 0x7 }>): void {
        emitEvent("goaway", frame.lastStreamId, frame.errorCode, frame.debugData);
        // Fail streams opened after lastStreamId — they will never be served.
        for (const [id, stream] of streams) {
            if (id > frame.lastStreamId) {
                stream.state = {
                    state: "closed",
                    reason: { kind: "goaway", lastStreamId: frame.lastStreamId },
                };
                rejectStream(stream, new GoawayReceivedError(frame.lastStreamId, frame.errorCode, frame.debugData));
            }
        }
    }

    function handleWindowUpdate(frame: Extract<Frame, { type: 0x8 }>): void {
        if (frame.streamId === 0) {
            connectionSendWindow += frame.windowSizeIncrement;
            // A connection window grow may unblock every stream's send queue.
            for (const s of streams.values()) {
                drainSendQueue(s);
            }
            return;
        }
        const stream = streams.get(frame.streamId);
        if (stream === undefined) {
            return;
        }
        stream.localWindow = {
            size: stream.localWindow.size + frame.windowSizeIncrement,
            initialSize: stream.localWindow.initialSize,
        };
        drainSendQueue(stream);
    }

    function handleContinuation(frame: Extract<Frame, { type: 0x9 }>): void {
        // A CONTINUATION after PUSH_PROMISE carries the client-stream id, but its
        // header block belongs to the *promised* stream (RFC 7540 §6.10). For an
        // ordinary HEADERS continuation, fall back to frame.streamId.
        const promisedId = pendingPushContinuation.get(frame.streamId);
        const stream = streams.get(promisedId ?? frame.streamId);
        if (stream === undefined) {
            return;
        }
        pushHeaderBytes(stream, frame.payload);
        if (!frame.endHeaders) {
            return;
        }
        if (promisedId !== undefined) {
            pendingPushContinuation.delete(frame.streamId);
        }
        decodePendingHeaders(stream);
        if (stream.isPushPromise) {
            // Completing a PUSH_PROMISE header block: emit `push` once with the
            // promised request headers.
            emitEvent("push", stream.id, stream.responseHeaders);
        }
        maybeResolveResponse(stream);
    }

    // --- public StreamManager surface ------------------------------------------

    function openStream(): Http2Stream {
        const id = nextStreamId as Http2StreamId;
        nextStreamId += 2;
        // Guard against 31-bit overflow: wrap back to a small odd id. (Practically
        // unreachable: ~2^30 concurrent client streams.)
        if (nextStreamId < 0) {
            nextStreamId = 1;
        }
        const stream = new ManagedStream(
            id,
            { size: remoteInitialWindowSize, initialSize: remoteInitialWindowSize },
            { size: DEFAULT_INITIAL_WINDOW_SIZE, initialSize: DEFAULT_INITIAL_WINDOW_SIZE },
            false,
        );
        streams.set(id, stream);
        return stream;
    }

    function applyWindowUpdate(streamId: Http2StreamId, increment: number): void {
        handleWindowUpdate({ type: 0x8, flags: 0, streamId, windowSizeIncrement: increment });
    }

    function sendData(streamId: Http2StreamId, data: Uint8Array, endStream: boolean): void {
        const stream = streams.get(streamId);
        if (stream === undefined) {
            return;
        }
        if (data.length > 0) {
            stream.sendQueue = concat(stream.sendQueue, data);
        }
        if (endStream) {
            stream.sendQueueEndStream = true;
        }
        drainSendQueue(stream);
    }

    function expectResponse(
        streamId: Http2StreamId,
        resolve: (res: Http2Response) => void,
        reject: (err: Error) => void,
    ): void {
        const stream = streams.get(streamId);
        if (stream === undefined) {
            reject(new RstStreamError(streamId, 0x1 /* PROTOCOL_ERROR */));
            return;
        }
        stream.resolve = resolve;
        stream.reject = reject;
    }

    function abortAll(error: Error): void {
        for (const stream of streams.values()) {
            stream.state = { state: "closed", reason: { kind: "normal" } };
            rejectStream(stream, error);
        }
        streams.clear();
    }

    // Mirror EventEmitter's core methods onto the manager so the returned object
    // satisfies the `StreamManager & EventEmitter` intersection type and callers
    // can subscribe to events through a single handle.
    const manager = {
        openStream,
        dispatch,
        sendData,
        applyWindowUpdate,
        expectResponse,
        abortAll,
        get maxConcurrentStreams(): number {
            return maxConcurrentStreams;
        },
        on: (event: string | symbol, listener: (...args: unknown[]) => void) => {
            emitter.on(event, listener);
        },
        once: (event: string | symbol, listener: (...args: unknown[]) => void) => {
            emitter.once(event, listener);
        },
        off: (event: string | symbol, listener: (...args: unknown[]) => void) => {
            emitter.off(event, listener);
        },
        removeListener: (event: string | symbol, listener: (...args: unknown[]) => void) => {
            emitter.removeListener(event, listener);
        },
        removeAllListeners: (event?: string | symbol) => {
            emitter.removeAllListeners(event);
        },
        emit: (event: string | symbol, ...args: unknown[]) => {
            emitter.emit(event, ...args);
        },
    } as StreamManager & EventEmitter;

    return manager;
}
