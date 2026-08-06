/**
 * Typed errors for @browsercore/http2.
 *
 * Errors are part of the API — every failure mode is an explicit type so callers
 * can match on `kind` instead of parsing messages.
 */

import type { Http2StreamId } from "./types.js";

/** Discriminator union for all HTTP/2 error kinds. */
export type Http2ErrorKind =
    | "Http2Error"
    | "GoawayReceivedError"
    | "RstStreamError"
    | "FlowControlError"
    | "FrameParseError"
    | "SettingsAckTimeoutError"
    | "ConnectionClosedError"
    | "StreamClosedError";

/** Base class for all HTTP/2 errors. */
export class Http2Error extends Error {
    public readonly kind: Http2ErrorKind = "Http2Error";
    public override readonly cause: Error | undefined;

    constructor(message: string, options?: { cause?: Error }) {
        super(message, options);
        this.name = new.target.name;
        this.cause = options?.cause;
    }
}

/** The peer sent a GOAWAY — the connection is going down. */
export class GoawayReceivedError extends Http2Error {
    public override readonly kind = "GoawayReceivedError" as const;
    public readonly lastStreamId: Http2StreamId;
    public readonly errorCode: number;
    public readonly debugData: Uint8Array;
    public override readonly cause: Error | undefined;

    constructor(
        lastStreamId: Http2StreamId,
        errorCode: number,
        debugData: Uint8Array,
        options?: { cause?: Error },
    ) {
        super(`GOAWAY received: lastStreamId=${lastStreamId}, errorCode=${errorCode}`);
        this.name = "GoawayReceivedError";
        this.lastStreamId = lastStreamId;
        this.errorCode = errorCode;
        this.debugData = debugData;
        this.cause = options?.cause;
    }
}

/** The peer reset a specific stream with RST_STREAM. */
export class RstStreamError extends Http2Error {
    public override readonly kind = "RstStreamError" as const;
    public readonly streamId: Http2StreamId;
    public readonly errorCode: number;
    public override readonly cause: Error | undefined;

    constructor(streamId: Http2StreamId, errorCode: number, options?: { cause?: Error }) {
        super(`RST_STREAM on stream ${streamId}: errorCode=${errorCode}`);
        this.name = "RstStreamError";
        this.streamId = streamId;
        this.errorCode = errorCode;
        this.cause = options?.cause;
    }
}

/** A flow-control window was violated (send exceeded the peer's window). */
export class FlowControlError extends Http2Error {
    public override readonly kind = "FlowControlError" as const;
    public readonly streamId: number | undefined;
    public readonly windowSize: number;
    public readonly attempted: number;
    public override readonly cause: Error | undefined;

    constructor(
        windowSize: number,
        attempted: number,
        streamId?: number,
        options?: { cause?: Error },
    ) {
        super(
            `Flow control violation: attempted ${attempted} bytes against window ${windowSize} (stream ${streamId ?? "connection"})`,
        );
        this.name = "FlowControlError";
        this.streamId = streamId;
        this.windowSize = windowSize;
        this.attempted = attempted;
        this.cause = options?.cause;
    }
}

/** A frame could not be parsed from the wire. */
export class FrameParseError extends Http2Error {
    public override readonly kind = "FrameParseError" as const;
    public readonly offset: number;
    public override readonly cause: Error | undefined;

    constructor(offset: number, options?: { cause?: Error }) {
        super(`Frame parse error at offset ${offset}`);
        this.name = "FrameParseError";
        this.offset = offset;
        this.cause = options?.cause;
    }
}

/** The peer acknowledged our SETTINGS frame never arrived within the timeout. */
export class SettingsAckTimeoutError extends Http2Error {
    public override readonly kind = "SettingsAckTimeoutError" as const;
    public readonly timeoutMs: number;
    public override readonly cause: Error | undefined;

    constructor(timeoutMs: number, options?: { cause?: Error }) {
        super(`SETTINGS ACK not received within ${timeoutMs}ms`);
        this.name = "SettingsAckTimeoutError";
        this.timeoutMs = timeoutMs;
        this.cause = options?.cause;
    }
}

/**
 * The connection is closed (or closing) and cannot accept new work.
 * Raised by `request()` / `ping()` when the connection has been shut down.
 */
export class ConnectionClosedError extends Http2Error {
    public override readonly kind = "ConnectionClosedError" as const;
    public override readonly cause: Error | undefined;

    constructor(options?: { cause?: Error }) {
        super("connection is closed");
        this.name = "ConnectionClosedError";
        this.cause = options?.cause;
    }
}

/**
 * A stream is closed (or closing) and cannot accept further frames.
 * Raised when the local side attempts to write to or expects a response from
 * a stream that has already been torn down.
 */
export class StreamClosedError extends Http2Error {
    public override readonly kind = "StreamClosedError" as const;
    public readonly streamId: Http2StreamId;
    public override readonly cause: Error | undefined;

    constructor(streamId: Http2StreamId, options?: { cause?: Error }) {
        super(`stream ${streamId} is closed`);
        this.name = "StreamClosedError";
        this.streamId = streamId;
        this.cause = options?.cause;
    }
}
