/**
 * HTTP/2 frame parser and serializer.
 *
 * Pure wire-format logic — no I/O. The frame header is 9 bytes per RFC 7540
 * §4.1: length (24 bits), type (8 bits), flags (8 bits), reserved + stream id
 * (31 bits).
 */

import { FrameType, type Frame, type Http2StreamId } from "../types.js";
import { assertNever } from "../utils.js";

/** The fixed 9-byte HTTP/2 frame header length. */
export const FRAME_HEADER_LENGTH = 9;

/** The maximum payload length (2^14 = 16384 by default, negotiable via SETTINGS). */
export const DEFAULT_MAX_FRAME_SIZE = 16_384;

/** Parsed frame header fields. */
export interface FrameHeader {
    readonly type: number;
    readonly flags: number;
    readonly streamId: Http2StreamId;
    readonly length: number;
}

/**
 * Serialize a frame into wire bytes (header + payload).
 *
 * The caller is responsible for splitting oversized payloads across multiple
 * frames — this function writes one frame only.
 */
export function serializeFrame(frame: Frame): Uint8Array {
    const payload = serializePayload(frame);
    const length = payload.length;
    const header = new Uint8Array(FRAME_HEADER_LENGTH);
    const view = new DataView(header.buffer);
    // 24-bit length across bytes 0-2.
    view.setUint8(0, (length >>> 16) & 0xff);
    view.setUint8(1, (length >>> 8) & 0xff);
    view.setUint8(2, length & 0xff);
    view.setUint8(3, frame.type);
    view.setUint8(4, frame.flags);
    // Stream id — top bit is reserved.
    view.setUint32(5, frame.streamId & 0x7fffffff);
    const out = new Uint8Array(FRAME_HEADER_LENGTH + length);
    out.set(header, 0);
    out.set(payload, FRAME_HEADER_LENGTH);
    return out;
}

/** Serialize just the payload — dispatches on frame type. */
function serializePayload(frame: Frame): Uint8Array {
    switch (frame.type) {
        case FrameType.DATA:
        case FrameType.HEADERS:
        case FrameType.PUSH_PROMISE:
        case FrameType.CONTINUATION:
            return frame.payload;
        case FrameType.PRIORITY: {
            const out = new Uint8Array(5);
            const view = new DataView(out.buffer);
            const exclusive = frame.exclusive ? 0x80000000 : 0;
            view.setUint32(0, Math.trunc(exclusive | (frame.streamDependency & 0x7fffffff)));
            out[4] = frame.weight & 0xff;
            return out;
        }
        case FrameType.RST_STREAM: {
            const out = new Uint8Array(4);
            new DataView(out.buffer).setUint32(0, Math.trunc(frame.errorCode));
            return out;
        }
        case FrameType.SETTINGS: {
            // Each setting is 6 bytes: 2-byte id, 4-byte value.
            const entries = Object.entries(frame.settings) as [string, number][];
            const out = new Uint8Array(entries.length * 6);
            const view = new DataView(out.buffer);
            entries.forEach(([key, value], i) => {
                view.setUint16(i * 6, Number(key));
                view.setUint32(i * 6 + 2, Math.trunc(value));
            });
            return out;
        }
        case FrameType.PING: {
            const out = new Uint8Array(8);
            const view = new DataView(out.buffer);
            view.setBigUint64(0, frame.opaqueData);
            return out;
        }
        case FrameType.GOAWAY: {
            const out = new Uint8Array(8 + frame.debugData.length);
            const view = new DataView(out.buffer);
            view.setUint32(0, frame.lastStreamId & 0x7fffffff);
            view.setUint32(4, Math.trunc(frame.errorCode));
            out.set(frame.debugData, 8);
            return out;
        }
        case FrameType.WINDOW_UPDATE: {
            const out = new Uint8Array(4);
            new DataView(out.buffer).setUint32(0, frame.windowSizeIncrement & 0x7fffffff);
            return out;
        }
        default:
            return assertNever(frame);
    }
}

/**
 * Parse a 9-byte frame header. Returns the header fields so the caller knows
 * how many payload bytes to read next.
 */
export function parseFrameHeader(buf: Uint8Array): FrameHeader {
    if (buf.length < FRAME_HEADER_LENGTH) {
        throw new RangeError(`Buffer too short for frame header: ${buf.length}`);
    }
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const length = (view.getUint8(0) << 16) | (view.getUint8(1) << 8) | view.getUint8(2);
    const type = view.getUint8(3);
    const flags = view.getUint8(4);
    const streamId = (view.getUint32(5) & 0x7fffffff) as Http2StreamId;
    return { type, flags, streamId, length };
}

/**
 * Parse a full frame (header + payload) from a buffer.
 *
 * The buffer must contain at least `FRAME_HEADER_LENGTH + header.length` bytes.
 *
 * @throws {RangeError} if the buffer is too short.
 */
export function parseFrame(buf: Uint8Array): Frame {
    const header = parseFrameHeader(buf);
    const payloadStart = FRAME_HEADER_LENGTH;
    const payloadEnd = payloadStart + header.length;
    if (buf.length < payloadEnd) {
        throw new RangeError(`Buffer too short for frame payload: ${buf.length} < ${payloadEnd}`);
    }
    const payload = buf.slice(payloadStart, payloadEnd);
    return decodeFrame(header.type, header.flags, header.streamId, payload);
}

/** Decode a frame body given its header fields and payload bytes. */
function decodeFrame(type: number, flags: number, streamId: Http2StreamId, payload: Uint8Array): Frame {
    switch (type as typeof FrameType[keyof typeof FrameType]) {
        case FrameType.DATA:
            return { type, flags, streamId, payload } as Frame;
        case FrameType.HEADERS:
            return {
                type,
                flags,
                streamId,
                endHeaders: (flags & 0x4) !== 0,
                endStream: (flags & 0x1) !== 0,
                padded: (flags & 0x8) !== 0,
                payload,
            } as Frame;
        case FrameType.PRIORITY: {
            const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            const depRaw = view.getUint32(0);
            return {
                type,
                flags,
                streamId,
                exclusive: (depRaw & 0x80000000) !== 0,
                streamDependency: (depRaw & 0x7fffffff) as Http2StreamId,
                weight: payload[4] ?? 0,
            } as Frame;
        }
        case FrameType.RST_STREAM:
            return {
                type,
                flags,
                streamId,
                errorCode: new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0),
            } as Frame;
        case FrameType.SETTINGS: {
            const settings: Record<number, number> = {};
            const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            for (let i = 0; i + 6 <= payload.length; i += 6) {
                const id = view.getUint16(i);
                const value = view.getUint32(i + 2);
                settings[id] = value;
            }
            return {
                type,
                flags,
                streamId: 0 as Http2StreamId,
                ack: (flags & 0x1) !== 0,
                settings,
            } as Frame;
        }
        case FrameType.PUSH_PROMISE:
            return {
                type,
                flags,
                streamId,
                endHeaders: (flags & 0x4) !== 0,
                padded: (flags & 0x8) !== 0,
                promisedStreamId: (new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0) &
                    0x7fffffff) as Http2StreamId,
                payload: payload.slice(4),
            } as Frame;
        case FrameType.PING:
            return {
                type,
                flags,
                streamId: 0 as Http2StreamId,
                ack: (flags & 0x1) !== 0,
                opaqueData: new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getBigUint64(0),
            } as Frame;
        case FrameType.GOAWAY: {
            const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            return {
                type,
                flags,
                streamId: 0 as Http2StreamId,
                lastStreamId: (view.getUint32(0) & 0x7fffffff) as Http2StreamId,
                errorCode: view.getUint32(4),
                debugData: payload.slice(8),
            } as Frame;
        }
        case FrameType.WINDOW_UPDATE:
            return {
                type,
                flags,
                streamId,
                windowSizeIncrement: new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0) &
                    0x7fffffff,
            } as Frame;
        case FrameType.CONTINUATION:
            return {
                type,
                flags,
                streamId,
                endHeaders: (flags & 0x4) !== 0,
                payload,
            } as Frame;
        default:
            // Unknown frame types MUST be ignored per RFC 7540 §4.1 — return a
            // generic frame so callers can still observe the type.
            return { type: type as typeof FrameType.DATA, flags, streamId, payload } as Frame;
    }
}

void assertNever;
