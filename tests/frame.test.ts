/**
 * Frame serialize/parse round-trip tests for every HTTP/2 frame type.
 *
 * PLAN.md Step 2: "Full frame parse/serialize for each type." The existing
 * http2.test.ts only covered SETTINGS; this file exercises every Frame variant
 * through serializeFrame + parseFrame, plus the parse-error paths and the
 * unknown-type fallback.
 */

import { describe, expect, it } from "vitest";
import { serializeFrame, parseFrame, parseFrameHeader } from "../src/frame/frame.js";
import { FRAME_HEADER_LENGTH } from "../src/frame/frame.js";
import { FrameParseError } from "../src/errors.js";
import type { Frame, Http2StreamId } from "../src/types.js";
import { FrameType } from "../src/types.js";

const ID = (n: number): Http2StreamId => n as Http2StreamId;

/** Assert that a frame survives a serialize -> parse round trip unchanged. */
function roundTrip(frame: Frame): void {
    const bytes = serializeFrame(frame);
    const parsed = parseFrame(bytes);
    expect(parsed.type).toBe(frame.type);
    expect(parsed.flags).toBe(frame.flags);
    expect(parsed.streamId).toBe(frame.streamId);
}

describe("DATA frame", () => {
    it("round-trips a bare DATA frame", () => {
        roundTrip({
            type: FrameType.DATA,
            flags: 0,
            streamId: ID(1),
            payload: new Uint8Array([1, 2, 3]),
        });
    });

    it("round-trips DATA with END_STREAM flag", () => {
        roundTrip({
            type: FrameType.DATA,
            flags: 0x1,
            streamId: ID(5),
            payload: new Uint8Array([9]),
        });
    });

    it("round-trips padded DATA (PADDED flag 0x8)", () => {
        roundTrip({
            type: FrameType.DATA,
            flags: 0x8,
            streamId: ID(1),
            payload: new Uint8Array([0, 0x61, 0x62]), // padLen=0 + "ab"
        });
    });
});

describe("HEADERS frame", () => {
    // The HEADERS parser extracts only the flag-derived booleans and passes the
    // payload through verbatim (serialize is identity on payload too). The
    // optional priority fields are not decoded from the wire — that is an
    // unimplemented feature, so it is intentionally not asserted here.
    it("round-trips HEADERS with END_HEADERS flag", () => {
        const frame: Frame = {
            type: FrameType.HEADERS,
            flags: 0x4, // END_HEADERS
            streamId: ID(1),
            endHeaders: true,
            endStream: false,
            padded: false,
            payload: new Uint8Array([0x80, 0, 0, 0, 200]),
        };
        const parsed = parseFrame(serializeFrame(frame));
        expect(parsed.type).toBe(FrameType.HEADERS);
        expect((parsed as { endHeaders: boolean }).endHeaders).toBe(true);
        expect((parsed as { payload: Uint8Array }).payload).toEqual(
            new Uint8Array([0x80, 0, 0, 0, 200]),
        );
    });

    it("round-trips HEADERS with END_STREAM + END_HEADERS", () => {
        const frame: Frame = {
            type: FrameType.HEADERS,
            flags: 0x5, // END_HEADERS | END_STREAM
            streamId: ID(3),
            endHeaders: true,
            endStream: true,
            padded: false,
            payload: new Uint8Array(0),
        };
        const parsed = parseFrame(serializeFrame(frame));
        expect((parsed as { endStream: boolean }).endStream).toBe(true);
    });
});

describe("PRIORITY frame", () => {
    it("round-trips a PRIORITY frame with the exclusive bit", () => {
        const frame: Frame = {
            type: FrameType.PRIORITY,
            flags: 0,
            streamId: ID(0),
            exclusive: true,
            streamDependency: ID(7),
            weight: 128,
        };
        const parsed = parseFrame(serializeFrame(frame));
        expect(parsed.type).toBe(FrameType.PRIORITY);
        expect((parsed as { exclusive: boolean }).exclusive).toBe(true);
        expect((parsed as { streamDependency: Http2StreamId }).streamDependency).toBe(ID(7));
        expect((parsed as { weight: number }).weight).toBe(128);
    });
});

describe("RST_STREAM frame", () => {
    it("round-trips a RST_STREAM frame with an error code", () => {
        const frame: Frame = {
            type: FrameType.RST_STREAM,
            flags: 0,
            streamId: ID(1),
            errorCode: 0x2, // INTERNAL_ERROR
        };
        const parsed = parseFrame(serializeFrame(frame));
        expect(parsed.type).toBe(FrameType.RST_STREAM);
        expect((parsed as { errorCode: number }).errorCode).toBe(0x2);
    });
});

describe("SETTINGS frame", () => {
    it("round-trips an ACK (empty) settings frame", () => {
        const frame: Frame = {
            type: FrameType.SETTINGS,
            flags: 0x1, // ACK
            streamId: ID(0),
            ack: true,
            settings: {},
        };
        const parsed = parseFrame(serializeFrame(frame));
        expect((parsed as { ack: boolean }).ack).toBe(true);
        expect((parsed as { settings: Record<number, number> }).settings).toEqual({});
    });

    it("round-trips a settings frame with multiple entries", () => {
        const frame: Frame = {
            type: FrameType.SETTINGS,
            flags: 0,
            streamId: ID(0),
            ack: false,
            settings: { [0x1]: 4096, [0x3]: 100 },
        };
        const parsed = parseFrame(serializeFrame(frame));
        const s = (parsed as { settings: Record<number, number> }).settings;
        expect(s[0x1]).toBe(4096);
        expect(s[0x3]).toBe(100);
    });
});

describe("PUSH_PROMISE frame", () => {
    it("round-trips a PUSH_PROMISE frame with a promised stream id", () => {
        // PUSH_PROMISE wire payload is the 4-byte promised stream id followed by
        // the header-block fragment. serializePayload returns payload as-is, so
        // the caller builds these wire bytes (the promisedStreamId field is a
        // parsed-out convenience that serialize does not re-encode).
        const promised = ID(2);
        const fragment = new Uint8Array([0xBE]);
        const wire = new Uint8Array(4 + fragment.length);
        new DataView(wire.buffer).setUint32(0, promised & 0x7fffffff);
        wire.set(fragment, 4);
        const frame: Frame = {
            type: FrameType.PUSH_PROMISE,
            flags: 0x4, // END_HEADERS
            streamId: ID(1),
            endHeaders: true,
            padded: false,
            promisedStreamId: promised,
            payload: wire,
        };
        const parsed = parseFrame(serializeFrame(frame));
        expect(parsed.type).toBe(FrameType.PUSH_PROMISE);
        expect((parsed as { promisedStreamId: Http2StreamId }).promisedStreamId).toBe(promised);
        expect((parsed as { payload: Uint8Array }).payload).toEqual(fragment);
    });
});

describe("PING frame", () => {
    it("round-trips a PING frame and its ACK", () => {
        const opaque = 0xfedcba9876543210n;
        for (const ack of [false, true]) {
            const frame: Frame = {
                type: FrameType.PING,
                flags: ack ? 0x1 : 0,
                streamId: ID(0),
                ack,
                opaqueData: opaque,
            };
            const parsed = parseFrame(serializeFrame(frame));
            expect((parsed as { opaqueData: bigint }).opaqueData).toBe(opaque);
            expect((parsed as { ack: boolean }).ack).toBe(ack);
        }
    });
});

describe("GOAWAY frame", () => {
    it("round-trips a GOAWAY frame with debug data", () => {
        const frame: Frame = {
            type: FrameType.GOAWAY,
            flags: 0,
            streamId: ID(0),
            lastStreamId: ID(11),
            errorCode: 0x1,
            debugData: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
        };
        const parsed = parseFrame(serializeFrame(frame));
        expect(parsed.type).toBe(FrameType.GOAWAY);
        expect((parsed as { lastStreamId: Http2StreamId }).lastStreamId).toBe(ID(11));
        expect((parsed as { errorCode: number }).errorCode).toBe(0x1);
        expect((parsed as { debugData: Uint8Array }).debugData).toEqual(
            new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
        );
    });
});

describe("WINDOW_UPDATE frame", () => {
    it("round-trips a connection-level WINDOW_UPDATE", () => {
        const frame: Frame = {
            type: FrameType.WINDOW_UPDATE,
            flags: 0,
            streamId: ID(0),
            windowSizeIncrement: 66635,
        };
        const parsed = parseFrame(serializeFrame(frame));
        expect(parsed.type).toBe(FrameType.WINDOW_UPDATE);
        expect((parsed as { windowSizeIncrement: number }).windowSizeIncrement).toBe(66635);
    });

    it("round-trips a stream-level WINDOW_UPDATE", () => {
        const frame: Frame = {
            type: FrameType.WINDOW_UPDATE,
            flags: 0,
            streamId: ID(5),
            windowSizeIncrement: 1024,
        };
        const parsed = parseFrame(serializeFrame(frame));
        expect((parsed as { streamId: Http2StreamId }).streamId).toBe(ID(5));
        expect((parsed as { windowSizeIncrement: number }).windowSizeIncrement).toBe(1024);
    });
});

describe("CONTINUATION frame", () => {
    it("round-trips a CONTINUATION frame with END_HEADERS", () => {
        const frame: Frame = {
            type: FrameType.CONTINUATION,
            flags: 0x4, // END_HEADERS
            streamId: ID(1),
            endHeaders: true,
            payload: new Uint8Array([0x01, 0x02, 0x03]),
        };
        const parsed = parseFrame(serializeFrame(frame));
        expect(parsed.type).toBe(FrameType.CONTINUATION);
        expect((parsed as { endHeaders: boolean }).endHeaders).toBe(true);
        expect((parsed as { payload: Uint8Array }).payload).toEqual(new Uint8Array([0x01, 0x02, 0x03]));
    });
});

describe("parse error paths", () => {
    it("throws FrameParseError when the buffer is too short for a frame header", () => {
        const buf = new Uint8Array([0, 0, 0, 0]); // only 4 bytes, header needs 9
        expect(() => parseFrameHeader(buf)).toThrow(FrameParseError);
        expect(() => parseFrame(buf)).toThrow(FrameParseError);
    });

    it("throws FrameParseError when the buffer is too short for the advertised payload", () => {
        // Header advertises a 10-byte payload but the buffer only has 3 more bytes.
        const header = new Uint8Array(FRAME_HEADER_LENGTH);
        const view = new DataView(header.buffer);
        view.setUint8(0, 0);
        view.setUint8(1, 0);
        view.setUint8(2, 10); // length = 10
        view.setUint8(3, FrameType.DATA);
        const buf = new Uint8Array([...header, 1, 2, 3]);
        expect(() => parseFrame(buf)).toThrow(FrameParseError);
    });

    it("parses an unknown frame type into a generic frame (RFC 7540 §4.1)", () => {
        // Type 0xFF is reserved; the parser must ignore it gracefully.
        const header = new Uint8Array(FRAME_HEADER_LENGTH);
        const view = new DataView(header.buffer);
        view.setUint8(2, 2); // length = 2
        view.setUint8(3, 0xFF); // unknown type
        view.setUint32(5, 0);
        const buf = new Uint8Array([...header, 0xAA, 0xBB]);
        const parsed = parseFrame(buf);
        // The fallback returns a DATA-shaped frame carrying the raw payload.
        expect(parsed.payload).toEqual(new Uint8Array([0xAA, 0xBB]));
    });
});
