/**
 * utils.ts coverage: assertNever.
 *
 * assertNever is the exhaustiveness guard thrown from the `default` branch of
 * discriminated-union switches. (createStreamId was refactored into the stream
 * manager's internal nextStreamId counter — see stream-manager.test.ts.)
 */

import { describe, expect, it } from "vitest";
import { assertNever } from "../src/utils.js";

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
