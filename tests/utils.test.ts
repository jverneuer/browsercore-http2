/**
 * utils.ts coverage: assertNever.
 *
 * assertNever is the exhaustiveness guard thrown from the `default` branch of
 * discriminated-union switches. (createStreamId was refactored into the stream
 * manager's internal nextStreamId counter — see stream-manager.test.ts.)
 */

import { describe, expect, it } from "vitest";
import { assertNever } from "../src/utils.js";
import { systemClock } from "../src/types.js";

describe("assertNever", () => {
    it("throws an Error describing the unexpected value", () => {
        expect(() => assertNever("oops" as never)).toThrow(Error);
        expect(() => assertNever("oops" as never)).toThrow(/Unexpected value/);
    });

    it("serializes the value into the message via JSON", () => {
        // assertNever uses JSON.stringify — exercise it with a structured value.
        let caught: unknown;
        try {
            assertNever({ kind: "mystery" } as never);
        } catch (err) {
            caught = err;
        }
        expect(String(caught)).toContain('{"kind":"mystery"}');
    });
});

describe("systemClock (canonical Clock default)", () => {
    // The default clock implements the FULL canonical Clock from
    // @browsercore/contracts — the same seam http2's SETTINGS-ACK timeout and
    // id generation run on. These tests pin the whole surface (monotonic and
    // sleep have no protocol call site yet) so the contract cannot silently rot.
    it("now() is wall-clock epoch ms comparable with Date.now()", () => {
        const before = Date.now();
        const now = systemClock.now();
        expect(now).toBeGreaterThanOrEqual(before);
        expect(now).toBeLessThanOrEqual(Date.now());
    });

    it("monotonic() never goes backwards", () => {
        const first = systemClock.monotonic();
        const second = systemClock.monotonic();
        expect(second).toBeGreaterThanOrEqual(first);
    });

    it("sleep(ms) resolves no earlier than the delay", async () => {
        const start = systemClock.monotonic();
        await systemClock.sleep(5);
        // 1ms slack for timer granularity — the point is "not instant".
        expect(systemClock.monotonic() - start).toBeGreaterThanOrEqual(4);
    });

    it("setTimeout(ms, fn) fires once after the delay; clearTimeout cancels", async () => {
        let fired = false;
        systemClock.setTimeout(5, () => { fired = true; });
        await systemClock.sleep(15);
        expect(fired).toBe(true);

        let cancelled = false;
        const handle = systemClock.setTimeout(60_000, () => { cancelled = true; });
        systemClock.clearTimeout(handle);
        await systemClock.sleep(10);
        expect(cancelled).toBe(false);
    });
});
