import { describe, expect, it } from "vitest";
import { FrameType, Http2Settings } from "../src/types.js";
import {
    FlowControlError,
    FrameParseError,
    GoawayReceivedError,
    RstStreamError,
    SettingsAckTimeoutError,
} from "../src/errors.js";
import { serializeFrame, parseFrame, parseFrameHeader, FRAME_HEADER_LENGTH } from "../src/frame/frame.js";

describe("frame header round trip", () => {
    it("serializes and parses a frame header back to the same fields", () => {
        const frame = {
            type: FrameType.SETTINGS,
            flags: 0,
            streamId: 0 as number & { __brand: "Http2StreamId" },
            ack: false,
            settings: { [Http2Settings.ENABLE_PUSH]: 0 },
        } as never;
        const bytes = serializeFrame(frame);
        expect(bytes.length).toBe(FRAME_HEADER_LENGTH + 6);
        const header = parseFrameHeader(bytes);
        expect(header.type).toBe(FrameType.SETTINGS);
        expect(header.flags).toBe(0);
        expect(header.streamId).toBe(0);
        expect(header.length).toBe(6);
    });

    it("round-trips a full frame through serialize + parse", () => {
        const frame = {
            type: FrameType.SETTINGS,
            flags: 0,
            streamId: 0 as number & { __brand: "Http2StreamId" },
            ack: false,
            settings: { [Http2Settings.HEADER_TABLE_SIZE]: 4096 },
        } as never;
        const bytes = serializeFrame(frame);
        const parsed = parseFrame(bytes);
        expect(parsed.type).toBe(FrameType.SETTINGS);
        expect(parsed.streamId).toBe(0);
    });
});

describe("SettingsFrame serialization", () => {
    it("serializes a SETTINGS frame with multiple entries", () => {
        const frame = {
            type: FrameType.SETTINGS,
            flags: 0,
            streamId: 0 as number & { __brand: "Http2StreamId" },
            ack: false,
            settings: {
                [Http2Settings.HEADER_TABLE_SIZE]: 4096,
                [Http2Settings.ENABLE_PUSH]: 1,
            },
        } as never;
        const bytes = serializeFrame(frame);
        expect(bytes.length).toBe(FRAME_HEADER_LENGTH + 12);
        const parsed = parseFrame(bytes) as { type: typeof FrameType.SETTINGS; settings: Record<number, number> };
        expect(parsed.settings[Http2Settings.HEADER_TABLE_SIZE]).toBe(4096);
        expect(parsed.settings[Http2Settings.ENABLE_PUSH]).toBe(1);
    });
});

describe("error classes", () => {
    it("instantiates GoawayReceivedError with fields", () => {
        const err = new GoawayReceivedError(7, 0x1, new Uint8Array([1, 2, 3]));
        expect(err.kind).toBe("GoawayReceivedError");
        expect(err.lastStreamId).toBe(7);
        expect(err.errorCode).toBe(0x1);
        expect(err.debugData).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("instantiates RstStreamError with fields", () => {
        const err = new RstStreamError(3, 0x2);
        expect(err.kind).toBe("RstStreamError");
        expect(err.streamId).toBe(3);
        expect(err.errorCode).toBe(0x2);
    });

    it("instantiates FlowControlError with streamId", () => {
        const err = new FlowControlError(100, 200, 5);
        expect(err.kind).toBe("FlowControlError");
        expect(err.windowSize).toBe(100);
        expect(err.attempted).toBe(200);
        expect(err.streamId).toBe(5);
    });

    it("instantiates FrameParseError and SettingsAckTimeoutError", () => {
        const fp = new FrameParseError(9);
        expect(fp.kind).toBe("FrameParseError");
        expect(fp.offset).toBe(9);

        const sa = new SettingsAckTimeoutError(5000);
        expect(sa.kind).toBe("SettingsAckTimeoutError");
        expect(sa.timeoutMs).toBe(5000);
    });
});
