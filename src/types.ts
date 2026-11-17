/**
 * Domain types for @browsercore/http2.
 *
 * HTTP/2 framing over any duplex byte stream. This package owns NO knowledge
 * of TLS, TCP, or DNS — it composes exclusively over `@browsercore/transport`.
 */

import type { Transport } from "@browsercore/transport";
import type { Clock, CryptoProvider, EventProvider, TimerHandle } from "@browsercore/contracts";

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

/**
 * The priority triple shared by PRIORITY frames and HEADERS frames carrying
 * the PRIORITY flag (RFC 7540 §6.2/§6.3): exclusive-dependency bit, 31-bit
 * stream dependency, 8-bit weight.
 *
 * `weight` is the on-wire byte (RFC 7540 §5.3.2: logical weight 1..256
 * encodes as wire 0..255 — the Chrome 131/140 oracle's logical weight 256 is
 * `0xff` here).
 */
export interface PriorityFields {
    readonly exclusive: boolean;
    readonly streamDependency: Http2StreamId;
    readonly weight: number;
}

export interface HeadersFrame extends BaseFrame {
    readonly type: typeof FrameType.HEADERS;
    /** `true` if the END_HEADERS flag (0x4) is set. */
    readonly endHeaders: boolean;
    /** `true` if the END_STREAM flag (0x1) is set. */
    readonly endStream: boolean;
    /** `true` if the PADDED flag (0x8) is set. */
    readonly padded: boolean;
    /**
     * Priority fields — present only when the PRIORITY flag (0x20) is set.
     * Serialized as the 5-byte block preceding the header block fragment
     * (RFC 7540 §6.2). Absent → the payload is the bare header block.
     */
    readonly priority?: PriorityFields;
    readonly payload: Uint8Array;
}

export interface PriorityFrame extends BaseFrame, PriorityFields {
    readonly type: typeof FrameType.PRIORITY;
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
    /**
     * Explicit serialization order for the SETTINGS payload (impersonation).
     * When present, ONLY the settings listed here are emitted, in this id
     * order — bypassing the ascending-sort that JavaScript applies to integer
     * object keys. IDs not present in the map are skipped, and IDs in the map
     * but not in this array are silently DROPPED: real browsers send a fixed
     * setting set (Chrome 131/140 oracle: exactly 1, 2, 4, 6), and appending
     * unlisted entries would produce a frame no real client ever sends.
     * Callers wanting a setting on the wire must list it. Absent → natural
     * (sorted) key order with every setting emitted.
     */
    readonly settingsOrder?: readonly number[];
    /**
     * When `true`, prepend a GREASE setting id (RFC 8701 0x?a?a pattern) with
     * value 0 as the FIRST setting. Chrome does this in its connection preface.
     */
    readonly grease?: boolean;
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

/**
 * Specification for a PRIORITY frame sent during the connection preface.
 *
 * Mirrors {@link PriorityFrame} without the wire discriminants (`type`/`flags`),
 * so callers can describe dependency-tree setup concisely in {@link Http2Options}.
 */
export interface PriorityFrameSpec extends PriorityFields {
    readonly streamId: Http2StreamId;
}

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

/** A single decoded header pair, in wire order (no HPACK indexing detail). */
export interface DecodedHeaderPair {
    readonly name: string;
    readonly value: string;
}

/**
 * Decoded HTTP/2 headers — the container handed to consumers after HPACK
 * decode (`Http2Response.headers`, pushed-response headers, the stream
 * manager's `"push"` event payload).
 *
 * Two views over the SAME wire data:
 *
 * - **Flat record (backward compatible):** the container IS a
 *   `ReadonlyMap<string, string>`. Its view keeps one entry per field name
 *   and is LAST-WINS for repeated fields — `get()`/`entries()` return only
 *   the last value a field carried. This is the historic behaviour, kept
 *   exactly for compatibility; RFC 9113 §8.2.3 allows a recipient to rebuild
 *   repeated fields into one comma-separated value, so consumers that only
 *   see the flat record never observe the earlier values.
 * - **Multi-value fidelity:** {@link DecodedHeaders.getHeaderValues} returns
 *   EVERY value a field carried, in wire order — the multi-`Set-Cookie` path
 *   (RFC 9113 §8.2.3: a sender MUST send multiple `Set-Cookie` fields as
 *   separate fields; they are NOT foldable into one comma-joined value).
 *
 * Pseudo-headers stay single-valued here: a block with a duplicate
 * pseudo-header field is malformed (RFC 9113 §8.3) and is rejected at
 * assembly (`MalformedHeadersError`), so this container never carries two
 * values for one pseudo-header name.
 */
export interface DecodedHeaders extends ReadonlyMap<string, string> {
    /**
     * All values for a field, in wire order. Empty array if the field is
     * absent.
     *
     * Lookup matches the field name case-insensitively (HTTP field names are
     * case-insensitive, RFC 9110 §5.1); on the HTTP/2 wire they are lowercase
     * (RFC 9113 §8.2), so passing the lowercase wire name is the norm.
     */
    getHeaderValues(name: string): readonly string[];
}

/**
 * The immutable {@link DecodedHeaders} implementation the stream manager
 * assembles after HPACK decode.
 *
 * The ordered pair list is the fidelity source, threaded from HPACK decode
 * WITHOUT deduplication; the flat record is derived from it (last-wins via
 * `Map.set`). One object, both views — no divergence is possible.
 */
export class DecodedHeadersImpl implements DecodedHeaders {
    /** Every decoded pair, in wire order — duplicates preserved. */
    private readonly orderedPairs: readonly DecodedHeaderPair[];
    /** Derived flat record: last-wins per name, first-occurrence iteration order. */
    private readonly flat: ReadonlyMap<string, string>;

    constructor(pairs: readonly DecodedHeaderPair[]) {
        this.orderedPairs = pairs;
        this.flat = new Map(pairs.map((pair) => [pair.name, pair.value] as const));
    }

    /** @inheritdoc */
    public getHeaderValues(name: string): readonly string[] {
        const needle = name.toLowerCase();
        const values: string[] = [];
        for (const pair of this.orderedPairs) {
            if (pair.name.toLowerCase() === needle) {
                values.push(pair.value);
            }
        }
        return values;
    }

    /** @inheritdoc */
    public get(key: string): string | undefined {
        return this.flat.get(key);
    }

    /** @inheritdoc */
    public has(key: string): boolean {
        return this.flat.has(key);
    }

    /** @inheritdoc */
    public get size(): number {
        return this.flat.size;
    }

    /** @inheritdoc */
    public keys(): MapIterator<string> {
        return this.flat.keys();
    }

    /** @inheritdoc */
    public values(): MapIterator<string> {
        return this.flat.values();
    }

    /** @inheritdoc */
    public entries(): MapIterator<[string, string]> {
        return this.flat.entries();
    }

    /** @inheritdoc */
    public [Symbol.iterator](): MapIterator<[string, string]> {
        return this.flat[Symbol.iterator]();
    }

    /** @inheritdoc */
    public forEach(
        callback: (value: string, key: string, map: ReadonlyMap<string, string>) => void,
        thisArg?: unknown,
    ): void {
        this.flat.forEach(callback, thisArg);
    }
}

/** A response on an HTTP/2 stream. */
export interface Http2Response {
    readonly statusCode: number;
    /**
     * Decoded response headers. Flat view is LAST-WINS for repeated fields
     * (backward compatible); `getHeaderValues(name)` returns every value in
     * wire order — see {@link DecodedHeaders}.
     */
    readonly headers: DecodedHeaders;
    readonly body: Uint8Array;
}

// ---------------------------------------------------------------------------
// Clock (canonical — declared once in @browsercore/contracts, never locally)
// ---------------------------------------------------------------------------

// The Clock interface is imported from @browsercore/contracts (0.2.6) — THE
// canonical time source for the entire stack (replaceability audit 2026-11-16,
// remediation item #6: five package-local Clock shapes collapsed onto one).
// http2 previously declared a local { now, setTimeout(cb, ms), clearTimeout }
// subset here with the runtime's timer token exposed; it now binds the full
// canonical shape — ms-first setTimeout returning an opaque TimerHandle, plus
// monotonic()/sleep() from the same seam.

/**
 * The default, platform-backed clock — the platform globals (`Date.now()`,
 * `performance.now()`, global timers), implementing the full canonical
 * {@link Clock} shape.
 */
export const systemClock: Clock = {
    now: () => Date.now(),
    monotonic: () => performance.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
    setTimeout: (ms: number, fn: () => void) => setTimeout(fn, ms),
    clearTimeout: (handle: TimerHandle) => {
        // TimerHandle is deliberately opaque; the default narrows it back to
        // the concrete runtime timer token so the global clearTimeout accepts it.
        clearTimeout(handle as NodeJS.Timeout);
    },
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
     * Clock for protocol timeouts + id generation — the canonical `Clock`
     * from `@browsercore/contracts` (ms-first `setTimeout(ms, fn)` returning
     * an opaque `TimerHandle`; `monotonic()`/`sleep()` share the seam).
     * Defaults to {@link systemClock} — the platform globals. Inject a
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

    // --- impersonation: connection preface shape ---------------------------

    /**
     * Explicit serialization order for the preface SETTINGS frame. Controls the
     * on-wire byte order of setting ids — critical for fingerprint fidelity.
     * Absent → natural (sorted) key order.
     */
    readonly settingsOrder?: readonly number[];
    /** Insert a GREASE setting id first in the preface SETTINGS frame. */
    readonly settingsGrease?: boolean;
    /**
     * Connection-level WINDOW_UPDATE increment to send after the preface
     * SETTINGS. Chrome advertises a larger connection window (e.g. 1 572 864
     * − 65 535) early to avoid flow-control stalls.
     */
    readonly connectionWindowUpdate?: number;
    /**
     * PRIORITY frames to send after the preface SETTINGS + WINDOW_UPDATE but
     * before the read loop starts. Chrome sends several to set up its
     * dependency tree (e.g. stream 0 weight 256, stream 3 dependent on 0).
     */
    readonly priorityFrames?: readonly PriorityFrameSpec[];

    // --- impersonation: header block shape --------------------------------

    /**
     * Order of pseudo-headers (`:method`, `:path`, `:scheme`, `:authority`) in
     * request HEADERS frames. Entries may be written with or without the
     * leading colon — profiles declare bare names (`"method"`), wire names are
     * colon-prefixed (`":method"`); both spellings reach the wire in the given
     * order. Absent → the RFC 7540 §8.1.2 default order
     * (`:method :scheme :authority :path`).
     */
    readonly pseudoHeaderOrder?: readonly string[];
    /**
     * Priority fields for request HEADERS frames. When present, every request
     * HEADERS frame sets the PRIORITY flag (0x20) and carries the 5-byte
     * priority block before the header block fragment (RFC 7540 §6.2) — the
     * Chrome 131/140 oracle sends flags 0x25 with
     * `{ exclusive: true, streamDependency: 0, weight: 0xff }` (logical weight
     * 256). Absent → HEADERS without the flag or block (backwards compatible).
     */
    readonly initialPriority?: PriorityFields;
    /**
     * Order of regular (non-pseudo) headers in request HEADERS frames. Headers
     * named here are emitted first (in this order); any remaining headers
     * follow in their original insertion order. Absent → insertion order.
     */
    readonly headerOrder?: readonly string[];

    // --- impersonation: HPACK encoder configuration -----------------------

    /** Max HPACK dynamic table size for the request encoder. Default 4096. */
    readonly hpackMaxTableSize?: number;
    /** Whether to Huffman-encode header string literals. Default true. */
    readonly hpackHuffman?: boolean;
    /**
     * Whether to use incremental indexing for regular (non-pseudo) headers.
     * Default false (safe default — no-indexing literals).
     */
    readonly hpackIndexing?: boolean;
    /**
     * Event provider for connection-level signals (SETTINGS ACK, PING ACK,
     * GOAWAY, stream lifecycle). Injected by the application entrypoint
     * (e.g. browsersmith passes the Node EventEmitter-backed provider).
     * Decouples the stream manager from `node:events`.
     *
     * Required — this package provides no fallback. Inject the runtime
     * EventProvider via the composition root (browsersmith).
     */
    readonly events: EventProvider;
}
