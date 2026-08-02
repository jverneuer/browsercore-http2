/**
 * HPACK (RFC 7541) encode/decode tests.
 *
 * PLAN.md notes that HPACK coverage was previously "indirect via the
 * stream-manager tests that decode HEADERS frames" — i.e. it had no dedicated
 * test file. This file exercises the encoder and decoder directly: integer
 * encoding (incl. the >2^N-1 continuation rule and the negative-guard), literal
 * strings with and without Huffman, every header-field representation (indexed,
 * literal with incremental indexing, literal without indexing, literal
 * never-indexed, dynamic-table size update), the dynamic table's bounded
 * eviction, and the malformed-input error paths.
 */

import { describe, expect, it } from "vitest";
import {
    HpackEncoder,
    HpackDecoder,
    encodeHeaders,
    decodeHeaders,
    HpackError,
    type HeaderBlock,
} from "../src/hpack/hpack.js";

/** A convenience encoder/decoder pair. */
function pair(): { enc: HpackEncoder; dec: HpackDecoder } {
    return { enc: new HpackEncoder(), dec: new HpackDecoder() };
}

describe("integer encoding (RFC 7541 §5.1)", () => {
    it("encodes a value that fits in the prefix directly", () => {
        const { enc, dec } = pair();
        // A literal header exercises the string length prefix (7-bit) directly.
        const block = enc.encode([{ name: "x-a", value: "1", indexing: false }]);
        const decoded = dec.decode(block);
        expect(decoded[0]?.name).toBe("x-a");
    });

    it("encodes a size update larger than the 5-bit prefix via continuation octets", () => {
        const dec = new HpackDecoder();
        const enc = new HpackEncoder();
        // The size-update prefix is 5 bits (max 31). 100_000 forces the encoder
        // to emit continuation octets; the decoder must read them back.
        enc.setMaxTableSize(100_000);
        const block = enc.encode([{ name: "x-a", value: "1", indexing: true }]);
        // Decode must consume the multi-octet size update and the literal header.
        const decoded = dec.decode(block);
        expect(decoded[0]?.name).toBe("x-a");
        // The size update was honoured: the entry is stored and referenceable.
        expect(dec.decode(new Uint8Array([0x80 | 62]))[0]?.name).toBe("x-a");
    });

    it("throws HpackError on a negative integer", () => {
        const { enc } = pair();
        // A negative table-size limit reaches encodeInteger's negative guard
        // via the size-update path (the only public route to that check).
        enc.setMaxTableSize(-1);
        expect(() => enc.encode([{ name: "x", value: "v", indexing: false }])).toThrow(HpackError);
    });
});

describe("string literals (RFC 7541 §5.2)", () => {
    it("round-trips a header value containing high (non-ASCII) latin1 bytes", () => {
        const { enc, dec } = pair();
        const block = enc.encode([{ name: "x-bytes", value: "café", indexing: false }]);
        const decoded = dec.decode(block);
        expect(decoded[0]?.value).toBe("café");
    });

    it("round-trips a Huffman-encoded string", () => {
        // Longer ASCII strings almost always shrink under Huffman, exercising
        // the huffmanEncode + huffmanDecode path.
        const { enc, dec } = pair();
        const value = "the quick brown fox jumps over the lazy dog".repeat(4);
        const block = enc.encode([{ name: "x-long", value, indexing: false }]);
        const decoded = dec.decode(block);
        expect(decoded[0]?.value).toBe(value);
    });

    it("throws when a string carries a non-latin1 character", () => {
        const { enc } = pair();
        // U+2603 (snowman) does not fit in 8 bits.
        expect(() => enc.encode([{ name: "x", value: "☃", indexing: false }])).toThrow(HpackError);
    });
});

describe("indexed header field (RFC 7541 §6.1)", () => {
    it("resolves a static-table index", () => {
        const dec = new HpackDecoder();
        // 0x80 | 2 = indexed name 2 -> ":method" = "GET" (static table).
        const block = new Uint8Array([0x82]);
        const decoded = dec.decode(block);
        expect(decoded).toEqual([{ name: ":method", value: "GET", indexing: false }]);
    });

    it("throws when the indexed name is zero", () => {
        const dec = new HpackDecoder();
        // 0x80 = indexed index 0, which is not a valid entry.
        expect(() => dec.decode(new Uint8Array([0x80]))).toThrow(HpackError);
    });

    it("throws when the indexed name is out of range", () => {
        const dec = new HpackDecoder();
        // 0x80 | 99 -> index 99, beyond static (61) + empty dynamic table.
        const block = new Uint8Array([0x80 | 99]);
        expect(() => dec.decode(block)).toThrow(HpackError);
    });
});

describe("literal header fields (RFC 7541 §6.2)", () => {
    it("round-trips a literal with incremental indexing", () => {
        const { enc, dec } = pair();
        const block: HeaderBlock = [{ name: "x-custom", value: "hello", indexing: true }];
        const bytes = enc.encode(block);
        const decoded = dec.decode(bytes);
        expect(decoded[0]).toMatchObject({ name: "x-custom", value: "hello" });
        // The entry was added to the dynamic table -> referenceable by index.
        expect(dec.decode(new Uint8Array([0x80 | 62]))[0]?.name).toBe("x-custom");
    });

    it("round-trips a literal without indexing", () => {
        const { enc, dec } = pair();
        const block: HeaderBlock = [{ name: "x-plain", value: "world", indexing: false }];
        const decoded = dec.decode(enc.encode(block));
        expect(decoded[0]).toMatchObject({ name: "x-plain", value: "world" });
    });

    it("round-trips a literal with a name reference into the static table", () => {
        const dec = new HpackDecoder();
        // 0x40 | 1 = literal-incremental, name index 1 = ":authority".
        // Followed by a literal value string "example.com" (11 bytes).
        const value = "example.com";
        const valueBytes = [0x0b, ...new TextEncoder().encode(value)];
        const block = new Uint8Array([0x40 | 1, ...valueBytes]);
        const decoded = dec.decode(block);
        expect(decoded[0]?.name).toBe(":authority");
        expect(decoded[0]?.value).toBe("example.com");
    });

    it("round-trips a literal with never-indexing", () => {
        const dec = new HpackDecoder();
        // 0x10 = literal never-indexed (0001xxxx), name index 0, then the
        // name string "x" and value string "y".
        const block = new Uint8Array([0x10, 0x01, 0x78, 0x01, 0x79]);
        const decoded = dec.decode(block);
        expect(decoded[0]).toMatchObject({ name: "x", value: "y" });
        // Never-indexed -> NOT added to the dynamic table.
        expect(() => dec.decode(new Uint8Array([0x80 | 62]))).toThrow(HpackError);
    });

    it("throws when a literal references an out-of-range name index", () => {
        const dec = new HpackDecoder();
        // 0x40 | 62 = incremental literal, name index 62. Static table has 61
        // entries and the dynamic table is empty, so 62 is out of range.
        const block = new Uint8Array([0x40 | 62]);
        expect(() => dec.decode(block)).toThrow(HpackError);
    });
});

describe("dynamic table size update (RFC 7541 §6.3)", () => {
    it("shrinks the table via a size update, evicting existing entries", () => {
        const dec = new HpackDecoder();
        const enc = new HpackEncoder();
        // Seed one entry under the default (large) limit.
        dec.decode(enc.encode([{ name: "x-first", value: "value-alpha", indexing: true }]));
        // It is referenceable at dynamic index 62.
        expect(dec.decode(new Uint8Array([0x80 | 62]))[0]?.name).toBe("x-first");
        // A size update to 12 (5-bit prefix, value 12 < 31) followed by a new
        // entry. The shrink evicts x-first (its size 56 exceeds 12).
        const follow = enc.encode([{ name: "x-second", value: "beta", indexing: true }]);
        dec.decode(new Uint8Array([0x20 | 12, ...follow]));
        // x-first is gone; x-second is now at index 62.
        expect(dec.decode(new Uint8Array([0x80 | 62]))[0]?.name).toBe("x-second");
        expect(() => dec.decode(new Uint8Array([0x80 | 63]))).toThrow(HpackError);
    });
});

describe("dynamic table eviction (RFC 7541 §4.3)", () => {
    it("evicts the oldest entry when the table exceeds its limit", () => {
        // Tiny table: each entry is name.length + value.length + 32 overhead.
        const dec = new HpackDecoder(64);
        const enc = new HpackEncoder(64);
        const block: HeaderBlock = [
            { name: "x-first", value: "aaaaaaaa", indexing: true }, // 7+8+32 = 47
            { name: "x-second", value: "bbbbbbbbb", indexing: true }, // 7+9+32 = 48
        ];
        const decoded = dec.decode(enc.encode(block));
        expect(decoded).toHaveLength(2);
        // 47 + 48 > 64, so x-first was evicted; only x-second remains at index 62.
        expect(dec.decode(new Uint8Array([0x80 | 62]))[0]?.name).toBe("x-second");
        expect(() => dec.decode(new Uint8Array([0x80 | 63]))).toThrow(HpackError);
    });

    it("decodes a reference to a dynamic-table entry", () => {
        const dec = new HpackDecoder();
        const enc = new HpackEncoder();
        // Add one entry to the dynamic table.
        const seed: HeaderBlock = [{ name: "x-dyn", value: "dynamic", indexing: true }];
        const seedBytes = enc.encode(seed);
        dec.decode(seedBytes);
        // The dynamic entry sits at static(61) + 1 = index 62.
        const ref = new Uint8Array([0x80 | 62]);
        const decoded = dec.decode(ref);
        expect(decoded[0]?.name).toBe("x-dyn");
        expect(decoded[0]?.value).toBe("dynamic");
    });
});

describe("convenience helpers", () => {
    it("encodeHeaders -> decodeHeaders round-trips a map", () => {
        const map = new Map([
            [":method", "POST"],
            [":path", "/submit"],
            ["content-type", "application/json"],
            ["x-empty", ""],
        ]);
        const decoded = decodeHeaders(encodeHeaders(map));
        for (const [k, v] of map) expect(decoded.get(k)).toBe(v);
    });

    it("decodeHeaders preserves the last value for duplicate names", () => {
        const { enc, dec } = pair();
        const block: HeaderBlock = [
            { name: "x-multi", value: "one", indexing: false },
            { name: "x-multi", value: "two", indexing: false },
        ];
        const map = new Map<string, string>();
        for (const f of dec.decode(enc.encode(block))) map.set(f.name, f.value);
        expect(map.get("x-multi")).toBe("two");
    });
});

describe("malformed input handling", () => {
    it("throws when a length-prefixed string overflows the buffer", () => {
        const dec = new HpackDecoder();
        // Literal no-indexing (0x00), name index 0, then a length prefix
        // claiming 10 bytes when only 2 follow.
        const block = new Uint8Array([0x00, 0x8a, 0x61, 0x62]); // 0x8a = huffman|len 10
        expect(() => dec.decode(block)).toThrow(HpackError);
    });

    it("throws when a literal header's value string is missing", () => {
        const dec = new HpackDecoder();
        // Incremental literal (0x40), name index 0, a 2-byte name "ab" that
        // consumes the entire buffer — leaving no value string to read.
        const block = new Uint8Array([0x40, 0x02, 0x61, 0x62]);
        expect(() => dec.decode(block)).toThrow(HpackError);
    });
});
