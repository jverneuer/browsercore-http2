/**
 * errors.ts coverage: the `cause` option branches.
 *
 * Every error class stores `this.cause = options?.cause`. The existing
 * http2.test.ts constructs each class *without* options, so only the
 * undefined branch was hit. This file exercises the defined-`cause` branch for
 * each class plus the previously-uninstantiated base `Http2Error`.
 */

import { describe, expect, it } from "vitest";
import {
    Http2Error,
    FlowControlError,
    FrameParseError,
    GoawayReceivedError,
    RstStreamError,
    SettingsAckTimeoutError,
} from "../src/errors.js";

describe("Http2Error (base)", () => {
    it("stores an optional cause and reports its class name", () => {
        const inner = new Error("root cause");
        const err = new Http2Error("something broke", { cause: inner });
        expect(err.message).toBe("something broke");
        expect(err.cause).toBe(inner);
        expect(err.name).toBe("Http2Error");
        expect(err.kind).toBe("Http2Error");
    });

    it("has undefined cause when no options are passed", () => {
        const err = new Http2Error("no cause");
        expect(err.cause).toBeUndefined();
    });
});

describe("error subclasses carry an optional cause", () => {
    it("GoawayReceivedError stores cause", () => {
        const inner = new Error("x");
        const err = new GoawayReceivedError(7, 0x1, new Uint8Array([1]), { cause: inner });
        expect(err.cause).toBe(inner);
        expect(err.lastStreamId).toBe(7);
    });

    it("RstStreamError stores cause", () => {
        const inner = new Error("x");
        const err = new RstStreamError(3, 0x2, { cause: inner });
        expect(err.cause).toBe(inner);
    });

    it("FlowControlError stores cause", () => {
        const inner = new Error("x");
        const err = new FlowControlError(100, 200, 5, { cause: inner });
        expect(err.cause).toBe(inner);
    });

    it("FrameParseError stores cause", () => {
        const inner = new Error("x");
        const err = new FrameParseError(9, { cause: inner });
        expect(err.cause).toBe(inner);
    });

    it("SettingsAckTimeoutError stores cause", () => {
        const inner = new Error("x");
        const err = new SettingsAckTimeoutError(5000, { cause: inner });
        expect(err.cause).toBe(inner);
    });

    it("subclasses have undefined cause without options", () => {
        // Exercises the `?.` undefined branch on each subclass.
        expect(new GoawayReceivedError(1, 0, new Uint8Array()).cause).toBeUndefined();
        expect(new RstStreamError(1, 0).cause).toBeUndefined();
        expect(new FlowControlError(1, 2).cause).toBeUndefined();
        expect(new FrameParseError(0).cause).toBeUndefined();
        expect(new SettingsAckTimeoutError(1).cause).toBeUndefined();
    });
});
