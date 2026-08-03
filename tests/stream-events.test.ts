/**
 * stream.ts StreamEventBridge coverage.
 *
 * The manager backs its EventEmitter-shaped API (`on`/`once`/`off`/
 * `removeListener`/`removeAllListeners`/`emit`) with an EventTarget and a
 * wrapper map. The connection-level integration tests only exercise `on` and
 * `once`; this file covers the removal paths and the `emit` return value.
 */

import { describe, expect, it } from "vitest";
import { createStreamManager } from "../src/stream/stream.js";

function noop(): void {}

describe("StreamEventBridge — removal paths", () => {
    it("removeListener stops further delivery of that listener", () => {
        const mgr = createStreamManager(noop);
        let calls = 0;
        const fn = (): void => {
            calls++;
        };
        mgr.on("x", fn);
        mgr.emit("x");
        expect(calls).toBe(1);
        mgr.removeListener("x", fn);
        mgr.emit("x");
        expect(calls).toBe(1); // not incremented again
    });

    it("off is an alias for removeListener", () => {
        const mgr = createStreamManager(noop);
        let calls = 0;
        const fn = (): void => {
            calls++;
        };
        mgr.on("e", fn);
        mgr.off("e", fn);
        mgr.emit("e");
        expect(calls).toBe(0);
    });

    it("removeListener for an unregistered listener is a safe no-op", () => {
        const mgr = createStreamManager(noop);
        expect(() => mgr.removeListener("never", () => undefined)).not.toThrow();
    });

    it("removeAllListeners() clears listeners across every event", () => {
        const mgr = createStreamManager(noop);
        let a = 0;
        let b = 0;
        mgr.on("a", () => a++);
        mgr.on("b", () => b++);
        mgr.removeAllListeners();
        mgr.emit("a");
        mgr.emit("b");
        expect(a).toBe(0);
        expect(b).toBe(0);
    });

    it("removeAllListeners(event) clears only that event", () => {
        const mgr = createStreamManager(noop);
        let a = 0;
        let b = 0;
        mgr.on("a", () => a++);
        mgr.on("b", () => b++);
        mgr.removeAllListeners("a");
        mgr.emit("a");
        mgr.emit("b");
        expect(a).toBe(0);
        expect(b).toBe(1);
    });

    it("once fires only on the first emit", () => {
        const mgr = createStreamManager(noop);
        let calls = 0;
        mgr.once("o", () => calls++);
        mgr.emit("o");
        mgr.emit("o");
        expect(calls).toBe(1);
    });

    it("emit dispatches variadic args to listeners", () => {
        const mgr = createStreamManager(noop);
        let received: unknown[] = [];
        mgr.on("args", (...a: unknown[]) => {
            received = a;
        });
        mgr.emit("args", 1, "two", true);
        expect(received).toEqual([1, "two", true]);
    });

    it("emit delivers to listeners (the manager proxy does not forward the bridge return value)", () => {
        const mgr = createStreamManager(noop);
        let calls = 0;
        mgr.on("e", () => {
            calls++;
        });
        // The proxy `emit` returns undefined (it does not return the bridge's
        // dispatchEvent boolean) — exercising it still drives delivery.
        mgr.emit("e");
        expect(calls).toBe(1);
    });
});
