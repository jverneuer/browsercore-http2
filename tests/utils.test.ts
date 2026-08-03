/**
 * utils.ts coverage: assertNever + createStreamId.
 *
 * These were previously uncovered (0% functions). assertNever is the
 * exhaustiveness guard thrown from the `default` branch of discriminated-union
 * switches; createStreamId mints the odd 31-bit client stream id.
 */

import { describe, expect, it } from "vitest";
import { assertNever, createStreamId } from "../src/utils.js";

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

describe("createStreamId", () => {
    it("returns an odd, positive, 31-bit id", () => {
        for (let i = 0; i < 32; i++) {
            const id = createStreamId();
            expect(id % 2).toBe(1); // client streams are odd
            expect(id).toBeGreaterThan(0);
            expect(id).toBeLessThanOrEqual(0x7fffffff); // top bit reserved
        }
    });
});
