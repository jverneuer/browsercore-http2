/**
 * Targeted coverage for the three lowest-coverage files:
 *   - src/utils.ts          (50% lines  — createId uncovered)
 *   - src/hpack/dynamic-table.ts (86.7% — setLimit/resolveIndex paths)
 *   - src/hpack/integer.ts  (91.9%  — decodeInteger underflow paths)
 */

import { describe, expect, it } from "vitest";
import { createId } from "../src/utils.js";
import { DynamicTable, resolveIndex } from "../src/hpack/dynamic-table.js";
import { encodeInteger, decodeInteger } from "../src/hpack/integer.js";
import { HpackError } from "../src/hpack/error.js";

describe("utils.createId", () => {
    it("produces a unique, prefixed id containing timestamp + random suffix", () => {
        const id = createId("stream");
        expect(id.startsWith("stream_")).toBe(true);
        expect(id.length).toBeGreaterThan("stream_".length);
    });

    it("generates distinct ids on successive calls", () => {
        const a = createId("s");
        const b = createId("s");
        expect(a).not.toBe(b);
    });
});

describe("DynamicTable.setLimit + eviction", () => {
    it("setLimit evicts entries when shrinking below current size", () => {
        const tbl = new DynamicTable(200);
        tbl.add("name1", "value1-entry-a"); // evicted once limit drops
        tbl.add("name2", "value2-entry-b");
        expect(tbl.length).toBe(2);
        tbl.setLimit(0); // both entries exceed 0 -> evicted
        expect(tbl.length).toBe(0);
        expect(tbl.size).toBe(0);
    });

    it("setLimit with no eviction needed keeps all entries", () => {
        const tbl = new DynamicTable(500);
        tbl.add("k", "v");
        tbl.setLimit(500); // same limit, no eviction
        expect(tbl.length).toBe(1);
        expect(tbl.get(1)).toEqual({ name: "k", value: "v" });
    });

    it("add of an entry larger than the limit flushes the table except itself", () => {
        const tbl = new DynamicTable(64);
        tbl.add("small", "a");
        tbl.add("x-big-name", "big-value-that-exceeds-limit-200"); // > 64
        // Only the oversized entry remains (RFC 7541 §4.3).
        expect(tbl.length).toBe(1);
        expect(tbl.get(1)?.name).toBe("x-big-name");
    });
});

describe("resolveIndex", () => {
    it("returns undefined for index 0", () => {
        const tbl = new DynamicTable();
        expect(resolveIndex(0, tbl)).toBeUndefined();
    });

    it("returns undefined for an out-of-range dynamic index", () => {
        const tbl = new DynamicTable();
        // Static table has 61 entries; with empty dynamic, index 62 is invalid.
        expect(resolveIndex(62, tbl)).toBeUndefined();
    });

    it("resolves a dynamic-table entry by its absolute index", () => {
        const tbl = new DynamicTable();
        tbl.add("x-dyn", "dynamic");
        // Static(61) + 1 = index 62.
        const resolved = resolveIndex(62, tbl);
        expect(resolved).toEqual({ source: "dynamic", name: "x-dyn", value: "dynamic" });
    });
});

describe("integer decode error paths", () => {
    it("throws HpackError on buffer underflow at first octet (empty buffer)", () => {
        expect(() => decodeInteger(new Uint8Array(0), 0, 5)).toThrow(HpackError);
    });

    it("throws HpackError on buffer underflow in continuation octets", () => {
        // 5-bit prefix, maxPrefix = 31. First octet 0x1f = 31 -> sentinel,
        // expects continuation octet but buffer ends.
        expect(() => decodeInteger(new Uint8Array([0x1f]), 0, 5)).toThrow(HpackError);
    });

    it("throws HpackError when continuation octets never terminate (high bit always set)", () => {
        // 0x08 with 4-bit prefix -> prefix 8, maxPrefix = 15. 0x08 < 15 so it's
        // direct — build a real continuation that never terminates instead:
        // 7-bit prefix (max 127), first octet 127 -> sentinel, then 0x80 (high
        // bit set, no end) followed by end-of-buffer.
        const buf = new Uint8Array([0x7f, 0x80]);
        expect(() => decodeInteger(buf, 0, 7)).toThrow(HpackError);
    });

    it("encodes and decodes a value requiring multiple continuation octets", () => {
        // 5-bit prefix (maxPrefix 31). Value 1000 needs 2 continuation octets.
        const encoded = encodeInteger(1000, 5);
        const decoded = decodeInteger(new Uint8Array(encoded), 0, 5);
        expect(decoded.value).toBe(1000);
    });
});
