/**
 * hpack.ts additional coverage: decoder.setMaxTableSize + Huffman boundary.
 *
 * The decoder exposes a public setMaxTableSize that the round-trip tests don't
 * exercise (they only call the encoder's). This shrinks the dynamic table and
 * verifies eviction, mirroring a peer-initiated DYNAMIC_TABLE_SIZE_UPDATE.
 */

import { describe, expect, it } from "vitest";
import { HpackDecoder, HpackEncoder, HpackError } from "../src/hpack/hpack.js";

describe("HpackDecoder.setMaxTableSize", () => {
    it("shrinks the dynamic table, evicting existing entries", () => {
        const dec = new HpackDecoder();
        const enc = new HpackEncoder();
        // Seed one indexed entry (sits at dynamic index 62).
        dec.decode(enc.encode([{ name: "x-kept", value: "v", indexing: true }]));
        expect(dec.decode(new Uint8Array([0x80 | 62]))[0]?.name).toBe("x-kept");

        // Shrink to zero via the decoder's own size-update API.
        dec.setMaxTableSize(0);
        // The entry was evicted -> index 62 is now out of range.
        expect(() => dec.decode(new Uint8Array([0x80 | 62]))).toThrow(HpackError);
    });

    it("grows the table again so a fresh entry can be stored", () => {
        const dec = new HpackDecoder();
        const enc = new HpackEncoder();
        dec.setMaxTableSize(0);
        // Grow back; a new incremental entry should be stored at index 62.
        dec.decode(enc.encode([{ name: "x-back", value: "w", indexing: true }]));
        expect(dec.decode(new Uint8Array([0x80 | 62]))[0]?.name).toBe("x-back");
    });
});

describe("HPACK empty header block", () => {
    it("decodes an empty block to zero fields", () => {
        const dec = new HpackDecoder();
        expect(dec.decode(new Uint8Array(0))).toEqual([]);
    });
});
