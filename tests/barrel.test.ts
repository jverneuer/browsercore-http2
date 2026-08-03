/**
 * Public API smoke test: import the package barrel and assert the documented
 * surface is exported. Every other test file imports from specific submodules;
 * this one exercises src/index.ts itself so the re-export module is covered and
 * the public contract is pinned.
 */

import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

describe("public API barrel (src/index.ts)", () => {
    it("exports the connection surface", () => {
        expect(typeof api.connectHttp2).toBe("function");
        expect(typeof api.Http2ConnectionImpl).toBe("function");
    });

    it("exports the frame + HPACK primitives", () => {
        expect(typeof api.serializeFrame).toBe("function");
        expect(typeof api.parseFrame).toBe("function");
        expect(typeof api.parseFrameHeader).toBe("function");
        expect(typeof api.encodeHeaders).toBe("function");
        expect(typeof api.decodeHeaders).toBe("function");
        expect(typeof api.HpackEncoder).toBe("function");
        expect(typeof api.HpackDecoder).toBe("function");
    });

    it("exports the error classes and the stream manager", () => {
        for (const k of [
            "Http2Error",
            "FlowControlError",
            "FrameParseError",
            "GoawayReceivedError",
            "RstStreamError",
            "SettingsAckTimeoutError",
        ] as const) {
            expect(typeof api[k]).toBe("function");
        }
        expect(typeof api.createStreamManager).toBe("function");
    });

    it("exports the FrameType / Http2Settings constants", () => {
        expect(api.FrameType.DATA).toBe(0x0);
        expect(api.FrameType.CONTINUATION).toBe(0x9);
        expect(api.Http2Settings.INITIAL_WINDOW_SIZE).toBe(0x4);
    });

    it("exports assertNever", () => {
        expect(typeof api.assertNever).toBe("function");
    });
});
