/**
 * Domain types for @browsercore/http2.
 *
 * HTTP/2 framing over any duplex byte stream. This package owns NO knowledge
 * of TLS, TCP, or DNS — it composes exclusively over `@browsercore/transport`.
 */

import type { Transport } from "@browsercore/transport";
import type { CryptoProvider } from "@browsercore/crypto";

/** Branded HTTP/2 connection identifier (opaque correlation id). */
export type Http2ConnectionId = string & { __brand: "Http2ConnectionId" };

/** Branded HTTP/2 stream identifier (must be a 31-bit unsigned integer). */
export type Http2StreamId = number & { __brand: "Http2StreamId" };

/** RFC 7540 frame types — const object + value union. */
export const FrameType = {
    DATA: 0x0,
    HEADERS: 0x1,
    PRIORITY: 0x2,
    RST_STREAM: 0x3,
    SETTINGS: 0x4,
    PUSH_PROMISE: 0x5,
    PING: 0x6,
    GOAWAY: 0x7,
    WINDOW_UPDATE: 0x8,
    CONTINUATION: 0x9,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

/** RFC 7540 SETTINGS identifiers. */
export const Http2Settings = {
    HEADER_TABLE_SIZE: 0x1,
    ENABLE_PUSH: 0x2,
    MAX_CONCURRENT_STREAMS: 0x3,
    INITIAL_WINDOW_SIZE: 0x4,
    MAX_FRAME_SIZE: 0x5,
    MAX_HEADER_LIST_SIZE: 0x6,
} as const;

export type Http2SettingsKey = (typeof Http2Settings)[keyof typeof Http2Settings];

/** A resolved settings map. */
export type Http2SettingsMap = Partial<Record<Http2SettingsKey, number>>;

/** The common HTTP/2 frame header shape — discriminated by `type`. */
export interface BaseFrame {
    readonly type: FrameTypeValue;
    readonly flags: number;
    readonly streamId: Http2StreamId;
}

export interface DataFrame extends BaseFrame {
    readonly type: typeof FrameType.DATA;
    readonly payload: Uint8Array;
}

export interface HeadersFrame extends BaseFrame {
    readonly type: typeof FrameType.HEADERS;
    /** `true` if the END_HEADERS flag (0x4) is set. */
    readonly endHeaders: boolean;
    /** `true` if the END_STREAM flag (0x1) is set. */
    readonly endStream: boolean;
    /** `true` if the PADDED flag (0x8) is set. */
    readonly padded: boolean;
    /** Optional priority fields (present when the PRIORITY flag 0x20 is set). */
    readonly exclusive?: boolean;
    readonly streamDependency?: Http2StreamId;
    readonly weight?: number;
    readonly payload: Uint8Array;
}

export interface PriorityFrame extends BaseFrame {
    readonly type: typeof FrameType.PRIORITY;
    readonly exclusive: boolean;
    readonly streamDependency: Http2StreamId;
    readonly weight: number;
}

export interface RstStreamFrame extends BaseFrame {
    readonly type: typeof FrameType.RST_STREAM;
    readonly errorCode: number;
}

export interface SettingsFrame extends BaseFrame {
    readonly type: typeof FrameType.SETTINGS;
    /** `true` if the ACK flag (0x1) is set — payload must be empty. */
    readonly ack: boolean;
    readonly settings: Http2SettingsMap;
}

export interface PushPromiseFrame extends BaseFrame {
    readonly type: typeof FrameType.PUSH_PROMISE;
    readonly endHeaders: boolean;
    readonly padded: boolean;
    readonly promisedStreamId: Http2StreamId;
    readonly payload: Uint8Array;
}

export interface PingFrame extends BaseFrame {
    readonly type: typeof FrameType.PING;
    /** `true` if the ACK flag (0x1) is set. */
    readonly ack: boolean;
    readonly opaqueData: bigint;
}

export interface GoawayFrame extends BaseFrame {
    readonly type: typeof FrameType.GOAWAY;
    readonly lastStreamId: Http2StreamId;
    readonly errorCode: number;
    readonly debugData: Uint8Array;
}

export interface WindowUpdateFrame extends BaseFrame {
    readonly type: typeof FrameType.WINDOW_UPDATE;
    readonly windowSizeIncrement: number;
}

export interface ContinuationFrame extends BaseFrame {
    readonly type: typeof FrameType.CONTINUATION;
    readonly endHeaders: boolean;
    readonly payload: Uint8Array;
}

/** Every HTTP/2 frame variant — exhaustive discriminated union. */
export type Frame =
    | DataFrame
    | HeadersFrame
    | PriorityFrame
    | RstStreamFrame
    | SettingsFrame
    | PushPromiseFrame
    | PingFrame
    | GoawayFrame
    | WindowUpdateFrame
    | ContinuationFrame;

/** Lifecycle state of an HTTP/2 stream. */
export type StreamState =
    | { readonly state: "idle" }
    | { readonly state: "local_reserved" }
    | { readonly state: "remote_reserved" }
    | { readonly state: "open" }
    | { readonly state: "local_half_closed" }
    | { readonly state: "remote_half_closed" }
    | { readonly state: "closed"; readonly reason: StreamCloseReason };

/** Why a stream entered the `closed` state. */
export type StreamCloseReason =
    | { readonly kind: "rst_stream"; readonly errorCode: number }
    | { readonly kind: "normal" }
    | { readonly kind: "goaway"; readonly lastStreamId: Http2StreamId };

/** A flow-control window — tracks the remaining credit for sends/receives. */
export interface FlowControlWindow {
    /** Current window size in bytes (may be negative after a WINDOW_UPDATE error). */
    readonly size: number;
    /** The initial window size agreed during SETTINGS exchange. */
    readonly initialSize: number;
}

/** Public contract for an HTTP/2 connection. */
export interface Http2Connection {
    /** Opaque identifier for logging / correlation. */
    readonly id: Http2ConnectionId;
    /** Current locally-applied settings (after the peer's SETTINGS ACK). */
    readonly settings: Http2SettingsMap;

    /**
     * Open a new stream, send request headers, and await the full response.
     * Multiplexes concurrently with other in-flight streams.
     */
    request(req: Http2Request): Promise<Http2Response>;

    /** Send a GOAWAY frame, gracefully shutting down the connection. */
    goaway(lastStreamId: Http2StreamId, errorCode: number, debugData?: Uint8Array): Promise<void>;

    /** Send a PING and await the peer's PING ACK. */
    ping(opaqueData?: bigint): Promise<bigint>;

    /** Gracefully close the connection. */
    close(): Promise<void>;
}

/** A request on an HTTP/2 stream. */
export interface Http2Request {
    readonly method: string;
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly headers: ReadonlyMap<string, string>;
    readonly body: Uint8Array | undefined;
}

/** A response on an HTTP/2 stream. */
export interface Http2Response {
    readonly statusCode: number;
    readonly headers: ReadonlyMap<string, string>;
    readonly body: Uint8Array;
}

// ---------------------------------------------------------------------------
// Clock abstraction (injected — decouples protocol code from the platform clock)
// ---------------------------------------------------------------------------

/**
 * Time + timer abstraction for HTTP/2 internals. Injected via {@link Http2Options}
 * so callers control the clock — keeps the package testable (deterministic,
 * virtualizable timeouts) and decouples protocol logic from the platform
 * `Date.now()` / `setTimeout`.
 *
 * The default ({@link systemClock}) delegates to the platform globals, so
 * behavior is identical unless the caller opts in. All three methods map
 * directly onto the globals they replace.
 */
export interface Clock {
    /** Current epoch milliseconds — replaces `Date.now()`. */
    now(): number;
    /** Schedule a one-shot timer — replaces `setTimeout`. */
    setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
    /** Cancel a pending timer — replaces `clearTimeout`. */
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

/** The default, platform-backed clock. Delegates to `Date.now()` / `setTimeout`. */
export const systemClock: Clock = {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => { clearTimeout(timer); },
};

/** Options for {@link connectHttp2}. */
export interface Http2Options {
    /** The underlying byte-stream transport (already connected). */
    readonly transport: Transport;
    /** Initial local settings to advertise in the connection preface. */
    readonly initialSettings?: Http2SettingsMap;
    /** Maximum concurrent outbound streams (from peer's SETTINGS). Default 100. */
    readonly maxConcurrentStreams?: number;
    /** Timeout for receiving the peer's SETTINGS ACK. Default 5000ms. */
    readonly settingsAckTimeoutMs?: number;
    /**
     * Clock for protocol timeouts + id generation. Defaults to
     * {@link systemClock} — the platform `Date.now()` / `setTimeout`. Inject a
     * deterministic clock in tests.
     */
    readonly clock?: Clock;
    /**
     * Crypto provider for non-protocol randomness (e.g. PING opaque data).
     * Required for dependency injection — the package performs zero runtime
     * imports of `@browsercore/crypto`, so the caller must supply a concrete
     * `CryptoProvider` (e.g. the singleton exported by that package).
     */
    readonly crypto: CryptoProvider;
}
