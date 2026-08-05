/**
 * @browsercore/http2 — public API surface.
 *
 * HTTP/2 framing over any duplex byte stream. No knowledge of TLS or TCP.
 * Higher layers (fetch, profiles) compose exclusively through these exports.
 */

export { connectHttp2, Http2ConnectionImpl } from "./connection.js";

export {
    ConnectionClosedError,
    FlowControlError,
    FrameParseError,
    GoawayReceivedError,
    Http2Error,
    RstStreamError,
    SettingsAckTimeoutError,
    StreamClosedError,
} from "./errors.js";

export {
    FRAME_HEADER_LENGTH,
    DEFAULT_MAX_FRAME_SIZE,
    type FrameHeader,
    parseFrame,
    parseFrameHeader,
    serializeFrame,
} from "./frame/frame.js";

export {
    HpackDecoder,
    HpackEncoder,
    decodeHeaders,
    encodeHeaders,
} from "./hpack/hpack.js";
export type { HeaderField, HeaderBlock } from "./hpack/hpack.js";

export { createStreamManager } from "./stream/stream.js";
export type { Http2Stream, StreamManager } from "./stream/stream.js";

export {
    FrameType,
    Http2Settings,
    silentLogger,
    devLogger,
    systemClock,
    type BaseFrame,
    type Clock,
    type ContinuationFrame,
    type DataFrame,
    type FlowControlWindow,
    type Frame,
    type GoawayFrame,
    type HeadersFrame,
    type Http2Connection,
    type Http2ConnectionId,
    type Http2Options,
    type Http2Request,
    type Http2Response,
    type Http2SettingsKey,
    type Http2SettingsMap,
    type Http2StreamId,
    type Logger,
    type PingFrame,
    type PriorityFrame,
    type PushPromiseFrame,
    type RstStreamFrame,
    type SettingsFrame,
    type StreamCloseReason,
    type StreamState,
    type WindowUpdateFrame,
} from "./types.js";

export { assertNever, createId } from "./utils.js";
