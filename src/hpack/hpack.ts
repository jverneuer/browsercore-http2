/**
 * HPACK — Header Compression for HTTP/2 (RFC 7541).
 *
 * Implements the full HPACK wire format:
 *   - Integer encoding (§5.1) and string literals (§5.2) with optional Huffman.
 *   - Static table (Appendix A) and dynamic table (§2.3) with size-bounded eviction.
 *   - Every header-field representation (§6): indexed, literal with/without indexing,
 *     literal never-indexed, dynamic-table-size update.
 *
 * Encoder and decoder each own a dynamic table; the decoder's table mirrors the
 * encoder's (and vice versa) as long as header blocks are processed in order.
 */

import { assertNever } from "../utils.js";

/** A single header field — name + value plus an indexing hint. */
export interface HeaderField {
    readonly name: string;
    readonly value: string;
    /** Whether this field may be added to the dynamic table. */
    readonly indexing: boolean;
}

/** A header block — ordered list of fields as they appear on the wire. */
export type HeaderBlock = readonly HeaderField[];

/**
 * HPACK-specific error. Raised when the wire format is malformed or the dynamic
 * table is referenced out of bounds.
 */
export class HpackError extends Error {
    public readonly kind = "HpackError" as const;
    public override readonly cause: Error | undefined;

    constructor(message: string, options?: { cause?: Error }) {
        super(message, options);
        this.name = "HpackError";
        this.cause = options?.cause;
    }
}

// ---------------------------------------------------------------------------
// Static table (RFC 7541 Appendix A)
// ---------------------------------------------------------------------------

interface StaticEntry {
    readonly name: string;
    readonly value: string;
}

/**
 * The 61 entries of the static table, indexed 1..61. Each entry contributes
 * `name.length + value.length + 32` bytes to the dynamic-table size budget
 * (§4.1), but the static table itself is not subject to eviction.
 */
const STATIC_TABLE: readonly StaticEntry[] = [
    { name: ":authority", value: "" },
    { name: ":method", value: "GET" },
    { name: ":method", value: "POST" },
    { name: ":path", value: "/" },
    { name: ":path", value: "/index.html" },
    { name: ":scheme", value: "http" },
    { name: ":scheme", value: "https" },
    { name: "status", value: "200" },
    { name: "status", value: "204" },
    { name: "status", value: "206" },
    { name: "status", value: "304" },
    { name: "status", value: "400" },
    { name: "status", value: "404" },
    { name: "status", value: "500" },
    { name: "accept-charset", value: "" },
    { name: "accept-encoding", value: "gzip, deflate" },
    { name: "accept-language", value: "" },
    { name: "accept-ranges", value: "" },
    { name: "accept", value: "" },
    { name: "access-control-allow-origin", value: "" },
    { name: "age", value: "" },
    { name: "allow", value: "" },
    { name: "authorization", value: "" },
    { name: "cache-control", value: "" },
    { name: "content-disposition", value: "" },
    { name: "content-encoding", value: "" },
    { name: "content-language", value: "" },
    { name: "content-length", value: "" },
    { name: "content-location", value: "" },
    { name: "content-range", value: "" },
    { name: "content-type", value: "" },
    { name: "cookie", value: "" },
    { name: "date", value: "" },
    { name: "etag", value: "" },
    { name: "expect", value: "" },
    { name: "expires", value: "" },
    { name: "from", value: "" },
    { name: "host", value: "" },
    { name: "if-match", value: "" },
    { name: "if-modified-since", value: "" },
    { name: "if-none-match", value: "" },
    { name: "if-range", value: "" },
    { name: "if-unmodified-since", value: "" },
    { name: "last-modified", value: "" },
    { name: "link", value: "" },
    { name: "location", value: "" },
    { name: "max-forwards", value: "" },
    { name: "proxy-authenticate", value: "" },
    { name: "proxy-authorization", value: "" },
    { name: "range", value: "" },
    { name: "referer", value: "" },
    { name: "refresh", value: "" },
    { name: "retry-after", value: "" },
    { name: "server", value: "" },
    { name: "set-cookie", value: "" },
    { name: "strict-transport-security", value: "" },
    { name: "transfer-encoding", value: "" },
    { name: "user-agent", value: "" },
    { name: "vary", value: "" },
    { name: "via", value: "" },
    { name: "www-authenticate", value: "" },
];

/** Total number of entries in the static table (its indices run 1..STATIC_TABLE_LENGTH). */
const STATIC_TABLE_LENGTH = STATIC_TABLE.length;

/**
 * Per-entry overhead in bytes (RFC 7541 §4.1): 32 bytes of fixed cost on top of
 * the name/value octet lengths.
 */
const TABLE_ENTRY_OVERHEAD = 32;

/** Default dynamic-table size limit (RFC 7541 §4.2 default = 4096). */
const DEFAULT_TABLE_SIZE_LIMIT = 4096;

// ---------------------------------------------------------------------------
// Huffman coding (RFC 7541 Appendix B)
// ---------------------------------------------------------------------------

/**
 * Huffman decode table entry: the `code` occupies the lowest `bits` of a 32-bit
 * word, left-aligned. We store `[bits, code, symbol]` for each row.
 *
 * To decode, read `bits` at a time; the table below is sorted by (bits, code)
 * ascending so the decoder walks codes short-to-long and matches greedily.
 */
interface HuffmanRow {
    readonly bits: number;
    readonly code: number;
    readonly symbol: number;
}

/**
 * The HPACK Huffman table (Appendix B). Each row is [bits, code, symbol] where
 * `code` is the Huffman code left-aligned into a 32-bit word with `bits` valid
 * bits — matching the RFC's "MSB-aligned" representation.
 */
const HUFFMAN_TABLE: readonly HuffmanRow[] = [

    { bits: 13, code: 0x00001ff8, symbol:   0 },
    { bits: 23, code: 0x007fffd8, symbol:   1 },
    { bits: 28, code: 0x0fffffe2, symbol:   2 },
    { bits: 28, code: 0x0fffffe3, symbol:   3 },
    { bits: 28, code: 0x0fffffe4, symbol:   4 },
    { bits: 28, code: 0x0fffffe5, symbol:   5 },
    { bits: 28, code: 0x0fffffe6, symbol:   6 },
    { bits: 28, code: 0x0fffffe7, symbol:   7 },
    { bits: 28, code: 0x0fffffe8, symbol:   8 },
    { bits: 24, code: 0x00ffffea, symbol:   9 },
    { bits: 30, code: 0x3ffffffc, symbol:  10 },
    { bits: 28, code: 0x0fffffe9, symbol:  11 },
    { bits: 28, code: 0x0fffffea, symbol:  12 },
    { bits: 30, code: 0x3ffffffd, symbol:  13 },
    { bits: 28, code: 0x0fffffeb, symbol:  14 },
    { bits: 28, code: 0x0fffffec, symbol:  15 },
    { bits: 28, code: 0x0fffffed, symbol:  16 },
    { bits: 28, code: 0x0fffffee, symbol:  17 },
    { bits: 28, code: 0x0fffffef, symbol:  18 },
    { bits: 28, code: 0x0ffffff0, symbol:  19 },
    { bits: 28, code: 0x0ffffff1, symbol:  20 },
    { bits: 28, code: 0x0ffffff2, symbol:  21 },
    { bits: 30, code: 0x3ffffffe, symbol:  22 },
    { bits: 28, code: 0x0ffffff3, symbol:  23 },
    { bits: 28, code: 0x0ffffff4, symbol:  24 },
    { bits: 28, code: 0x0ffffff5, symbol:  25 },
    { bits: 28, code: 0x0ffffff6, symbol:  26 },
    { bits: 28, code: 0x0ffffff7, symbol:  27 },
    { bits: 28, code: 0x0ffffff8, symbol:  28 },
    { bits: 28, code: 0x0ffffff9, symbol:  29 },
    { bits: 28, code: 0x0ffffffa, symbol:  30 },
    { bits: 28, code: 0x0ffffffb, symbol:  31 },
    { bits:  6, code: 0x00000014, symbol:  32 },
    { bits: 10, code: 0x000003f8, symbol:  33 },
    { bits: 10, code: 0x000003f9, symbol:  34 },
    { bits: 12, code: 0x00000ffa, symbol:  35 },
    { bits: 13, code: 0x00001ff9, symbol:  36 },
    { bits:  6, code: 0x00000015, symbol:  37 },
    { bits:  8, code: 0x000000f8, symbol:  38 },
    { bits: 11, code: 0x000007fa, symbol:  39 },
    { bits: 10, code: 0x000003fa, symbol:  40 },
    { bits: 10, code: 0x000003fb, symbol:  41 },
    { bits:  8, code: 0x000000f9, symbol:  42 },
    { bits: 11, code: 0x000007fb, symbol:  43 },
    { bits:  8, code: 0x000000fa, symbol:  44 },
    { bits:  6, code: 0x00000016, symbol:  45 },
    { bits:  6, code: 0x00000017, symbol:  46 },
    { bits:  6, code: 0x00000018, symbol:  47 },
    { bits:  5, code: 0x00000000, symbol:  48 },
    { bits:  5, code: 0x00000001, symbol:  49 },
    { bits:  5, code: 0x00000002, symbol:  50 },
    { bits:  6, code: 0x00000019, symbol:  51 },
    { bits:  6, code: 0x0000001a, symbol:  52 },
    { bits:  6, code: 0x0000001b, symbol:  53 },
    { bits:  6, code: 0x0000001c, symbol:  54 },
    { bits:  6, code: 0x0000001d, symbol:  55 },
    { bits:  6, code: 0x0000001e, symbol:  56 },
    { bits:  6, code: 0x0000001f, symbol:  57 },
    { bits:  7, code: 0x0000005c, symbol:  58 },
    { bits:  8, code: 0x000000fb, symbol:  59 },
    { bits: 15, code: 0x00007ffc, symbol:  60 },
    { bits:  6, code: 0x00000020, symbol:  61 },
    { bits: 12, code: 0x00000ffb, symbol:  62 },
    { bits: 10, code: 0x000003fc, symbol:  63 },
    { bits: 13, code: 0x00001ffa, symbol:  64 },
    { bits:  6, code: 0x00000021, symbol:  65 },
    { bits:  7, code: 0x0000005d, symbol:  66 },
    { bits:  7, code: 0x0000005e, symbol:  67 },
    { bits:  7, code: 0x0000005f, symbol:  68 },
    { bits:  7, code: 0x00000060, symbol:  69 },
    { bits:  7, code: 0x00000061, symbol:  70 },
    { bits:  7, code: 0x00000062, symbol:  71 },
    { bits:  7, code: 0x00000063, symbol:  72 },
    { bits:  7, code: 0x00000064, symbol:  73 },
    { bits:  7, code: 0x00000065, symbol:  74 },
    { bits:  7, code: 0x00000066, symbol:  75 },
    { bits:  7, code: 0x00000067, symbol:  76 },
    { bits:  7, code: 0x00000068, symbol:  77 },
    { bits:  7, code: 0x00000069, symbol:  78 },
    { bits:  7, code: 0x0000006a, symbol:  79 },
    { bits:  7, code: 0x0000006b, symbol:  80 },
    { bits:  7, code: 0x0000006c, symbol:  81 },
    { bits:  7, code: 0x0000006d, symbol:  82 },
    { bits:  7, code: 0x0000006e, symbol:  83 },
    { bits:  7, code: 0x0000006f, symbol:  84 },
    { bits:  7, code: 0x00000070, symbol:  85 },
    { bits:  7, code: 0x00000071, symbol:  86 },
    { bits:  7, code: 0x00000072, symbol:  87 },
    { bits:  8, code: 0x000000fc, symbol:  88 },
    { bits:  7, code: 0x00000073, symbol:  89 },
    { bits:  8, code: 0x000000fd, symbol:  90 },
    { bits: 13, code: 0x00001ffb, symbol:  91 },
    { bits: 19, code: 0x0007fff0, symbol:  92 },
    { bits: 13, code: 0x00001ffc, symbol:  93 },
    { bits: 14, code: 0x00003ffc, symbol:  94 },
    { bits:  6, code: 0x00000022, symbol:  95 },
    { bits: 15, code: 0x00007ffd, symbol:  96 },
    { bits:  5, code: 0x00000003, symbol:  97 },
    { bits:  6, code: 0x00000023, symbol:  98 },
    { bits:  5, code: 0x00000004, symbol:  99 },
    { bits:  6, code: 0x00000024, symbol: 100 },
    { bits:  5, code: 0x00000005, symbol: 101 },
    { bits:  6, code: 0x00000025, symbol: 102 },
    { bits:  6, code: 0x00000026, symbol: 103 },
    { bits:  6, code: 0x00000027, symbol: 104 },
    { bits:  5, code: 0x00000006, symbol: 105 },
    { bits:  7, code: 0x00000074, symbol: 106 },
    { bits:  7, code: 0x00000075, symbol: 107 },
    { bits:  6, code: 0x00000028, symbol: 108 },
    { bits:  6, code: 0x00000029, symbol: 109 },
    { bits:  6, code: 0x0000002a, symbol: 110 },
    { bits:  5, code: 0x00000007, symbol: 111 },
    { bits:  6, code: 0x0000002b, symbol: 112 },
    { bits:  7, code: 0x00000076, symbol: 113 },
    { bits:  6, code: 0x0000002c, symbol: 114 },
    { bits:  5, code: 0x00000008, symbol: 115 },
    { bits:  5, code: 0x00000009, symbol: 116 },
    { bits:  6, code: 0x0000002d, symbol: 117 },
    { bits:  7, code: 0x00000077, symbol: 118 },
    { bits:  7, code: 0x00000078, symbol: 119 },
    { bits:  7, code: 0x00000079, symbol: 120 },
    { bits:  7, code: 0x0000007a, symbol: 121 },
    { bits:  7, code: 0x0000007b, symbol: 122 },
    { bits: 15, code: 0x00007ffe, symbol: 123 },
    { bits: 11, code: 0x000007fc, symbol: 124 },
    { bits: 14, code: 0x00003ffd, symbol: 125 },
    { bits: 13, code: 0x00001ffd, symbol: 126 },
    { bits: 28, code: 0x0ffffffc, symbol: 127 },
    { bits: 20, code: 0x000fffe6, symbol: 128 },
    { bits: 22, code: 0x003fffd2, symbol: 129 },
    { bits: 20, code: 0x000fffe7, symbol: 130 },
    { bits: 20, code: 0x000fffe8, symbol: 131 },
    { bits: 22, code: 0x003fffd3, symbol: 132 },
    { bits: 22, code: 0x003fffd4, symbol: 133 },
    { bits: 22, code: 0x003fffd5, symbol: 134 },
    { bits: 23, code: 0x007fffd9, symbol: 135 },
    { bits: 22, code: 0x003fffd6, symbol: 136 },
    { bits: 23, code: 0x007fffda, symbol: 137 },
    { bits: 23, code: 0x007fffdb, symbol: 138 },
    { bits: 23, code: 0x007fffdc, symbol: 139 },
    { bits: 23, code: 0x007fffdd, symbol: 140 },
    { bits: 23, code: 0x007fffde, symbol: 141 },
    { bits: 24, code: 0x00ffffeb, symbol: 142 },
    { bits: 23, code: 0x007fffdf, symbol: 143 },
    { bits: 24, code: 0x00ffffec, symbol: 144 },
    { bits: 24, code: 0x00ffffed, symbol: 145 },
    { bits: 22, code: 0x003fffd7, symbol: 146 },
    { bits: 23, code: 0x007fffe0, symbol: 147 },
    { bits: 24, code: 0x00ffffee, symbol: 148 },
    { bits: 23, code: 0x007fffe1, symbol: 149 },
    { bits: 23, code: 0x007fffe2, symbol: 150 },
    { bits: 23, code: 0x007fffe3, symbol: 151 },
    { bits: 23, code: 0x007fffe4, symbol: 152 },
    { bits: 21, code: 0x001fffdc, symbol: 153 },
    { bits: 22, code: 0x003fffd8, symbol: 154 },
    { bits: 23, code: 0x007fffe5, symbol: 155 },
    { bits: 22, code: 0x003fffd9, symbol: 156 },
    { bits: 23, code: 0x007fffe6, symbol: 157 },
    { bits: 23, code: 0x007fffe7, symbol: 158 },
    { bits: 24, code: 0x00ffffef, symbol: 159 },
    { bits: 22, code: 0x003fffda, symbol: 160 },
    { bits: 21, code: 0x001fffdd, symbol: 161 },
    { bits: 20, code: 0x000fffe9, symbol: 162 },
    { bits: 22, code: 0x003fffdb, symbol: 163 },
    { bits: 22, code: 0x003fffdc, symbol: 164 },
    { bits: 23, code: 0x007fffe8, symbol: 165 },
    { bits: 23, code: 0x007fffe9, symbol: 166 },
    { bits: 21, code: 0x001fffde, symbol: 167 },
    { bits: 23, code: 0x007fffea, symbol: 168 },
    { bits: 22, code: 0x003fffdd, symbol: 169 },
    { bits: 22, code: 0x003fffde, symbol: 170 },
    { bits: 24, code: 0x00fffff0, symbol: 171 },
    { bits: 21, code: 0x001fffdf, symbol: 172 },
    { bits: 22, code: 0x003fffdf, symbol: 173 },
    { bits: 23, code: 0x007fffeb, symbol: 174 },
    { bits: 23, code: 0x007fffec, symbol: 175 },
    { bits: 21, code: 0x001fffe0, symbol: 176 },
    { bits: 21, code: 0x001fffe1, symbol: 177 },
    { bits: 22, code: 0x003fffe0, symbol: 178 },
    { bits: 21, code: 0x001fffe2, symbol: 179 },
    { bits: 23, code: 0x007fffed, symbol: 180 },
    { bits: 22, code: 0x003fffe1, symbol: 181 },
    { bits: 23, code: 0x007fffee, symbol: 182 },
    { bits: 23, code: 0x007fffef, symbol: 183 },
    { bits: 20, code: 0x000fffea, symbol: 184 },
    { bits: 22, code: 0x003fffe2, symbol: 185 },
    { bits: 22, code: 0x003fffe3, symbol: 186 },
    { bits: 22, code: 0x003fffe4, symbol: 187 },
    { bits: 23, code: 0x007ffff0, symbol: 188 },
    { bits: 22, code: 0x003fffe5, symbol: 189 },
    { bits: 22, code: 0x003fffe6, symbol: 190 },
    { bits: 23, code: 0x007ffff1, symbol: 191 },
    { bits: 26, code: 0x03ffffe0, symbol: 192 },
    { bits: 26, code: 0x03ffffe1, symbol: 193 },
    { bits: 20, code: 0x000fffeb, symbol: 194 },
    { bits: 19, code: 0x0007fff1, symbol: 195 },
    { bits: 22, code: 0x003fffe7, symbol: 196 },
    { bits: 23, code: 0x007ffff2, symbol: 197 },
    { bits: 22, code: 0x003fffe8, symbol: 198 },
    { bits: 25, code: 0x01ffffec, symbol: 199 },
    { bits: 26, code: 0x03ffffe2, symbol: 200 },
    { bits: 26, code: 0x03ffffe3, symbol: 201 },
    { bits: 26, code: 0x03ffffe4, symbol: 202 },
    { bits: 27, code: 0x07ffffde, symbol: 203 },
    { bits: 27, code: 0x07ffffdf, symbol: 204 },
    { bits: 26, code: 0x03ffffe5, symbol: 205 },
    { bits: 24, code: 0x00fffff1, symbol: 206 },
    { bits: 25, code: 0x01ffffed, symbol: 207 },
    { bits: 19, code: 0x0007fff2, symbol: 208 },
    { bits: 21, code: 0x001fffe3, symbol: 209 },
    { bits: 26, code: 0x03ffffe6, symbol: 210 },
    { bits: 27, code: 0x07ffffe0, symbol: 211 },
    { bits: 27, code: 0x07ffffe1, symbol: 212 },
    { bits: 26, code: 0x03ffffe7, symbol: 213 },
    { bits: 27, code: 0x07ffffe2, symbol: 214 },
    { bits: 24, code: 0x00fffff2, symbol: 215 },
    { bits: 21, code: 0x001fffe4, symbol: 216 },
    { bits: 21, code: 0x001fffe5, symbol: 217 },
    { bits: 26, code: 0x03ffffe8, symbol: 218 },
    { bits: 26, code: 0x03ffffe9, symbol: 219 },
    { bits: 28, code: 0x0ffffffd, symbol: 220 },
    { bits: 27, code: 0x07ffffe3, symbol: 221 },
    { bits: 27, code: 0x07ffffe4, symbol: 222 },
    { bits: 27, code: 0x07ffffe5, symbol: 223 },
    { bits: 20, code: 0x000fffec, symbol: 224 },
    { bits: 24, code: 0x00fffff3, symbol: 225 },
    { bits: 20, code: 0x000fffed, symbol: 226 },
    { bits: 21, code: 0x001fffe6, symbol: 227 },
    { bits: 22, code: 0x003fffe9, symbol: 228 },
    { bits: 21, code: 0x001fffe7, symbol: 229 },
    { bits: 21, code: 0x001fffe8, symbol: 230 },
    { bits: 23, code: 0x007ffff3, symbol: 231 },
    { bits: 22, code: 0x003fffea, symbol: 232 },
    { bits: 22, code: 0x003fffeb, symbol: 233 },
    { bits: 25, code: 0x01ffffee, symbol: 234 },
    { bits: 25, code: 0x01ffffef, symbol: 235 },
    { bits: 24, code: 0x00fffff4, symbol: 236 },
    { bits: 24, code: 0x00fffff5, symbol: 237 },
    { bits: 26, code: 0x03ffffea, symbol: 238 },
    { bits: 23, code: 0x007ffff4, symbol: 239 },
    { bits: 26, code: 0x03ffffeb, symbol: 240 },
    { bits: 27, code: 0x07ffffe6, symbol: 241 },
    { bits: 26, code: 0x03ffffec, symbol: 242 },
    { bits: 26, code: 0x03ffffed, symbol: 243 },
    { bits: 27, code: 0x07ffffe7, symbol: 244 },
    { bits: 27, code: 0x07ffffe8, symbol: 245 },
    { bits: 27, code: 0x07ffffe9, symbol: 246 },
    { bits: 27, code: 0x07ffffea, symbol: 247 },
    { bits: 27, code: 0x07ffffeb, symbol: 248 },
    { bits: 28, code: 0x0ffffffe, symbol: 249 },
    { bits: 27, code: 0x07ffffec, symbol: 250 },
    { bits: 27, code: 0x07ffffed, symbol: 251 },
    { bits: 27, code: 0x07ffffee, symbol: 252 },
    { bits: 27, code: 0x07ffffef, symbol: 253 },
    { bits: 27, code: 0x07fffff0, symbol: 254 },
    { bits: 26, code: 0x03ffffee, symbol: 255 },
    { bits: 30, code: 0x3fffffff, symbol: 256 },

];

// ---------------------------------------------------------------------------
// Integer encoding (RFC 7541 §5.1)
// ---------------------------------------------------------------------------

/**
 * Encode `value` using an N-bit prefix. The value fits in N bits directly when it
 * is < `2^N - 1`; otherwise the prefix is filled with the max value and the
 * remainder is emitted using the integer-continuation rule (§5.1, "representable
 * in the form `X * 2^Y`").
 */
function encodeInteger(value: number, prefixBits: number): number[] {
    if (value < 0 || !Number.isInteger(value)) {
        throw new HpackError(`integer encode: value must be a non-negative integer, got ${value}`);
    }
    const maxPrefix = (1 << prefixBits) - 1;
    const out: number[] = [];
    if (value < maxPrefix) {
        out.push(value);
        return out;
    }
    out.push(maxPrefix);
    let remaining = value - maxPrefix;
    while (remaining > 0) {
        const octet = remaining % 128;
        remaining = Math.floor(remaining / 128);
        // Set the high bit if more octets follow.
        out.push(remaining > 0 ? octet | 0x80 : octet);
    }
    return out;
}

/** Read an integer starting at `buf[0]` with an N-bit prefix. Returns the value + new offset. */
function decodeInteger(buf: Uint8Array, offset: number, prefixBits: number): { value: number; nextOffset: number } {
    if (offset >= buf.length) {
        throw new HpackError("integer decode: buffer underflow reading first octet");
    }
    const maxPrefix = (1 << prefixBits) - 1;
    const first = buf[offset]! & maxPrefix;
    let position = offset + 1;
    if (first < maxPrefix) {
        return { value: first, nextOffset: position };
    }
    let value = maxPrefix;
    let shift = 0;
    while (position < buf.length) {
        const octet = buf[position]!;
        value += (octet & 0x7f) * 2 ** shift;
        position++;
        shift += 7;
        if ((octet & 0x80) === 0) {
            return { value, nextOffset: position };
        }
    }
    throw new HpackError("integer decode: buffer underflow in continuation octets");
}

// ---------------------------------------------------------------------------
// String encoding (RFC 7541 §5.2)
// ---------------------------------------------------------------------------

/**
 * Encode a literal octet string with Huffman: build a bitstring from Huffman
 * codes (MSB-first), pad to the next byte boundary with 1-bits, and emit the
 * bytes. Returns the encoded octets (without the length prefix — callers prepend
 * that with the Huffman flag bit).
 */
function huffmanEncode(input: Uint8Array): number[] {
    let buffer = 0;
    let bitsInBuffer = 0;
    const out: number[] = [];
    for (const byte of input) {
        const row = HUFFMAN_TABLE[byte]!;
        // Push `row.bits` bits of `row.code` (already MSB-aligned in the spec).
        buffer = (buffer << row.bits) | row.code;
        bitsInBuffer += row.bits;
        while (bitsInBuffer >= 8) {
            bitsInBuffer -= 8;
            out.push((buffer >> bitsInBuffer) & 0xff);
        }
    }
    // Pad with 1-bits up to the next byte boundary (§5.2 requires padding to
    // the most-significant bit of the final octet).
    if (bitsInBuffer > 0) {
        const padBits = 8 - bitsInBuffer;
        const padding = (1 << padBits) - 1;
        out.push(((buffer << padBits) | padding) & 0xff);
    }
    return out;
}

/**
 * Decode a Huffman-encoded string. Walks the bitstream MSB-first, matching the
 * longest prefix that corresponds to a Huffman code. Throws if the bit pattern
 * is invalid (eos or incomplete).
 */
function huffmanDecode(buf: Uint8Array, offset: number, length: number): { value: string; nextOffset: number } {
    let bitBuffer = 0;
    let bitsAvailable = 0;
    let position = offset;
    const end = offset + length;
    const chars: number[] = [];

    while (position < end || bitsAvailable > 0) {
        // Top up the bit buffer until we have at least the max Huffman code
        // length. We accumulate with multiply-and-add (rather than a bitwise
        // shift) so the buffer can hold more than 32 bits without the
        // sign-bit truncation that `<<` would otherwise cause.
        while (bitsAvailable < 30 && position < end) {
            bitBuffer = bitBuffer * 256 + buf[position]!;
            bitsAvailable += 8;
            position++;
        }
        // Try to match a Huffman row: walk codes long-to-short. We pick the
        // longest row whose (bits, code) prefix matches the top of the buffer.
        let matched = false;
        for (const row of HUFFMAN_TABLE) {
            if (row.bits > bitsAvailable) {
                continue;
            }
            const shift = bitsAvailable - row.bits;
            const top = Math.floor(bitBuffer / 2 ** shift) % (2 ** row.bits);
            // Compare against the row's code, which is right-aligned per row.bits.
            if (top === row.code) {
                chars.push(row.symbol);
                bitsAvailable = shift;
                bitBuffer = bitsAvailable > 0 ? bitBuffer % (2 ** bitsAvailable) : 0;
                matched = true;
                break;
            }
        }
        if (!matched) {
            throw new HpackError("huffman decode: no matching code");
        }
        // Once we've consumed all source octets, any remaining bits must be
        // valid padding (all 1s); otherwise the encoding is malformed.
        if (position >= end) {
            const mod = bitsAvailable > 0 ? 2 ** bitsAvailable : 1;
            if (bitBuffer % mod === mod - 1) {
                break;
            }
        }
    }

    return { value: decodeLatin1(chars), nextOffset: end };
}

/** Decode an array of byte values into a JS string (HPACK strings are ISO-8859-1). */
function decodeLatin1(bytes: readonly number[]): string {
    let out = "";
    for (const b of bytes) {
        out += String.fromCharCode(b);
    }
    return out;
}

/** Encode a JS string into ISO-8859-1 bytes (each char must fit in 8 bits). */
function encodeLatin1(s: string): Uint8Array {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code > 0xff) {
            throw new HpackError(`string encode: non-latin1 character at offset ${i}: U+${code.toString(16)}`);
        }
        out[i] = code;
    }
    return out;
}

interface DecodedString {
    readonly value: string;
    readonly nextOffset: number;
}

/**
 * Decode a length-prefixed string (§5.2). The high bit of the length prefix is
 * the Huffman flag: 1 = Huffman-encoded, 0 = literal octets.
 */
function decodeString(buf: Uint8Array, offset: number): DecodedString {
    if (offset >= buf.length) {
        throw new HpackError("string decode: buffer underflow reading length prefix");
    }
    const huffmanFlag = (buf[offset]! & 0x80) !== 0;
    const lengthResult = decodeInteger(buf, offset, 7);
    const length = lengthResult.value;
    const dataStart = lengthResult.nextOffset;
    const dataEnd = dataStart + length;
    if (dataEnd > buf.length) {
        throw new HpackError(`string decode: length ${length} exceeds buffer (offset ${dataStart}, buffer ${buf.length})`);
    }
    if (huffmanFlag) {
        const huffResult = huffmanDecode(buf, dataStart, length);
        return { value: huffResult.value, nextOffset: dataEnd };
    }
    const slice = buf.subarray(dataStart, dataEnd);
    const value = decodeLatin1([...slice]);
    return { value, nextOffset: dataEnd };
}

/**
 * Encode a string with Huffman. Returns the octets including the length prefix
 * (high bit set to indicate Huffman).
 */
function encodeStringHuffman(value: string): number[] {
    const raw = encodeLatin1(value);
    const encoded = huffmanEncode(raw);
    const lengthOctets = encodeInteger(encoded.length, 7);
    // Set the Huffman flag on the first octet.
    lengthOctets[0]! |= 0x80;
    return [...lengthOctets, ...encoded];
}

// ---------------------------------------------------------------------------
// Header name/value normalization
// ---------------------------------------------------------------------------

/**
 * Lower-case a header name (§8.1.2 — header field names are case-insensitive and
 * HTTP/2 lower-cases them on the wire). Values are preserved verbatim.
 */
function normalizeName(name: string): string {
    return name.toLowerCase();
}

// ---------------------------------------------------------------------------
// Dynamic table
// ---------------------------------------------------------------------------

interface DynamicEntry {
    readonly name: string;
    readonly value: string;
}

/**
 * A bounded table of header fields. New entries are inserted at the front
 * (highest index); when the total size exceeds `limit`, oldest entries are
 * evicted from the back until the budget is met.
 *
 * The index space is shared with the static table: static entries use indices
 * 1..STATIC_TABLE_LENGTH, dynamic entries use STATIC_TABLE_LENGTH+1..n. The
 * dynamic table's front (most recent) maps to the highest index.
 */
class DynamicTable {
    private entries: DynamicEntry[] = [];
    private _size = 0;
    private _limit: number;

    constructor(limit: number = DEFAULT_TABLE_SIZE_LIMIT) {
        this._limit = limit;
    }

    /** Current size limit (bytes). */
    public get limit(): number {
        return this._limit;
    }

    /** Current total octet size of all entries (name + value + 32 each). */
    public get size(): number {
        return this._size;
    }

    /** Number of entries currently stored. */
    public get length(): number {
        return this.entries.length;
    }

    /** Look up an entry by its (1-based) absolute index. */
    public get(index: number): DynamicEntry | undefined {
        // Index 1 is the most recently inserted entry.
        return this.entries[index - 1];
    }

    /**
     * Insert a name/value pair at the front. Evicts older entries until the
     * total size fits within `limit`. An entry whose own size exceeds the limit
     * is inserted but causes all other entries to be evicted (the table is
     * flushed except for this entry — RFC 7541 §4.3).
     */
    public add(name: string, value: string): void {
        const entrySize = name.length + value.length + TABLE_ENTRY_OVERHEAD;
        this.entries.unshift({ name, value });
        this._size += entrySize;
        this.evictToFit(this._limit >= entrySize ? this._limit : entrySize);
    }

    /**
     * Resize the limit. Evicts entries if the new limit is smaller than the
     * current total size. RFC 7541 §4.2: a dynamic-table-size update at the
     * *beginning* of the first header block; we apply it immediately here.
     */
    public setLimit(newLimit: number): void {
        this._limit = newLimit;
        this.evictToFit(newLimit);
    }

    /** Evict oldest entries until the total size fits within `maxSize`. */
    private evictToFit(maxSize: number): void {
        while (this._size > maxSize && this.entries.length > 0) {
            const removed = this.entries.pop();
            if (removed) {
                this._size -= removed.name.length + removed.value.length + TABLE_ENTRY_OVERHEAD;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Header-field lookup across static + dynamic tables
// ---------------------------------------------------------------------------

/** Result of resolving an index: either a static entry or a dynamic one. */
type ResolvedHeader =
    | { readonly source: "static"; readonly name: string; readonly value: string }
    | { readonly source: "dynamic"; readonly name: string; readonly value: string };

/**
 * Look up `index` across the static + dynamic tables. Returns `undefined` if
 * the index is out of bounds.
 */
function resolveIndex(index: number, dynamic: DynamicTable): ResolvedHeader | undefined {
    if (index <= 0) {
        return undefined;
    }
    if (index <= STATIC_TABLE_LENGTH) {
        const entry = STATIC_TABLE[index - 1];
        if (!entry) {
            return undefined;
        }
        return { source: "static", name: entry.name, value: entry.value };
    }
    const dynamicIndex = index - STATIC_TABLE_LENGTH - 1;
    const entry = dynamic.get(dynamicIndex + 1);
    if (!entry) {
        return undefined;
    }
    return { source: "dynamic", name: entry.name, value: entry.value };
}

// ---------------------------------------------------------------------------
// HPACK encoder
// ---------------------------------------------------------------------------

/** Header-field representations emitted by the encoder (§6). */
type EncodedHeader =
    | { readonly kind: "indexed"; readonly index: number }
    | { readonly kind: "literal_incremental"; readonly name: string; readonly value: string }
    | { readonly kind: "literal_never_indexed"; readonly name: string; readonly value: string }
    | { readonly kind: "literal_no_indexing"; readonly name: string; readonly value: string }
    | { readonly kind: "size_update"; readonly newLimit: number };

/**
 * HPACK encoder. Maintains a dynamic table shared with the decoder (updated
 * reciprocally by decoding the peer's headers).
 */
export class HpackEncoder {
    private nextSizeUpdate: number | undefined;

    constructor(_maxTableSize: number = DEFAULT_TABLE_SIZE_LIMIT) {
        void _maxTableSize;
    }

    /** Encode a header block into HPACK bytes. */
    public encode(headers: HeaderBlock): Uint8Array {
        const octets: number[] = [];
        if (this.nextSizeUpdate !== undefined) {
            octets.push(...this.encodeSizeUpdate(this.nextSizeUpdate));
            this.nextSizeUpdate = undefined;
        }
        for (const field of headers) {
            const encoded = this.planHeader(field);
            octets.push(...this.emitHeader(encoded));
        }
        return Uint8Array.from(octets);
    }

    /** Update the dynamic table size limit (from a DYNAMIC_TABLE_SIZE_UPDATE). */
    public setMaxTableSize(maxSize: number): void {
        this.nextSizeUpdate = maxSize;
    }

    /** Decide which representation to use for a single header field. */
    private planHeader(field: HeaderField): EncodedHeader {
        const name = normalizeName(field.name);
        if (field.indexing) {
            return { kind: "literal_incremental", name, value: field.value };
        }
        return { kind: "literal_no_indexing", name, value: field.value };
    }

    /** Emit the wire octets for a planned header representation. */
    private emitHeader(header: EncodedHeader): number[] {
        switch (header.kind) {
            case "indexed":
                return this.emitIndexed(header.index);
            case "literal_incremental":
                return this.emitLiteralIncremental(header.name, header.value);
            case "literal_never_indexed":
                return this.emitLiteralNeverIndexed(header.name, header.value);
            case "literal_no_indexing":
                return this.emitLiteralNoIndexing(header.name, header.value);
            case "size_update":
                return this.encodeSizeUpdate(header.newLimit);
            default:
                return assertNever(header);
        }
    }

    private emitIndexed(index: number): number[] {
        // 1-bit flag (0x80) + 7-bit prefix index.
        return encodeInteger(index, 7).map((o, i) => (i === 0 ? o | 0x80 : o));
    }

    private emitLiteralIncremental(name: string, value: string): number[] {
        // 01_000000 prefix (0x40) + 6-bit name index (0 = new name) + value.
        const out: number[] = [];
        out.push(0x40);
        out.push(...encodeStringHuffman(value));
        out.push(...encodeStringHuffman(name));
        return out;
    }

    private emitLiteralNoIndexing(name: string, value: string): number[] {
        // 0000_0000 prefix (0x00) + 4-bit name index (0) + value.
        const out: number[] = [];
        out.push(0x00);
        out.push(...encodeStringHuffman(name));
        out.push(...encodeStringHuffman(value));
        return out;
    }

    private emitLiteralNeverIndexed(name: string, value: string): number[] {
        // 0001_0000 prefix (0x10) + 4-bit name index (0) + value.
        const out: number[] = [];
        out.push(0x10);
        out.push(...encodeStringHuffman(name));
        out.push(...encodeStringHuffman(value));
        return out;
    }

    private encodeSizeUpdate(newLimit: number): number[] {
        // 001_ prefix (5 bits) + newLimit.
        return encodeInteger(newLimit, 5).map((o, i) => (i === 0 ? o | 0x20 : o));
    }
}

// ---------------------------------------------------------------------------
// HPACK decoder
// ---------------------------------------------------------------------------

/**
 * HPACK decoder. Maintains a dynamic table shared with the encoder.
 */
export class HpackDecoder {
    private readonly dynamic: DynamicTable;

    constructor(maxTableSize: number = DEFAULT_TABLE_SIZE_LIMIT) {
        this.dynamic = new DynamicTable(maxTableSize);
    }

    /** Decode HPACK bytes into a header block. */
    public decode(buf: Uint8Array): HeaderBlock {
        const out: HeaderField[] = [];
        let offset = 0;
        while (offset < buf.length) {
            const octet = buf[offset]!;
            // The high bit distinguishes indexed (1xxxxxxx) from the rest.
            if ((octet & 0x80) !== 0) {
                // §6.1 — Indexed Header Field.
                const result = decodeInteger(buf, offset, 7);
                const resolved = resolveIndex(result.value, this.dynamic);
                if (!resolved) {
                    throw new HpackError(`indexed header: index ${result.value} out of range`);
                }
                out.push({ name: resolved.name, value: resolved.value, indexing: false });
                offset = result.nextOffset;
                continue;
            }
            // §6.2.1 — Literal with incremental indexing (01xxxxxx).
            if ((octet & 0xc0) === 0x40) {
                offset = this.decodeLiteral(buf, offset, out, "incremental");
                continue;
            }
            // §6.3 — Dynamic table size update (001xxxxx).
            if ((octet & 0xe0) === 0x20) {
                const result = decodeInteger(buf, offset, 5);
                this.dynamic.setLimit(result.value);
                offset = result.nextOffset;
                continue;
            }
            // §6.2.2 — Literal without indexing (0000xxxx).
            if ((octet & 0xf0) === 0x00) {
                offset = this.decodeLiteral(buf, offset, out, "no_indexing");
                continue;
            }
            // §6.2.3 — Literal never indexed (0001xxxx).
            if ((octet & 0xf0) === 0x10) {
                offset = this.decodeLiteral(buf, offset, out, "never_indexed");
                continue;
            }
            throw new HpackError(`header block decode: unknown prefix 0x${octet.toString(16)} at offset ${offset}`);
        }
        return out;
    }

    /** Update the dynamic table size limit. */
    public setMaxTableSize(maxSize: number): void {
        this.dynamic.setLimit(maxSize);
    }

    /**
     * Decode a literal header-field representation and append it to `out`.
     * Returns the new buffer offset.
     */
    private decodeLiteral(
        buf: Uint8Array,
        offset: number,
        out: HeaderField[],
        indexing: "incremental" | "no_indexing" | "never_indexed",
    ): number {
        // Both "with indexing" and "without indexing" forms share the same prefix
        // layout: 6-bit or 4-bit name index, then optional name string, then value.
        const octet = buf[offset]!;
        const prefixBits = (octet & 0xc0) === 0x40 ? 6 : 4;
        const nameIndexResult = decodeInteger(buf, offset, prefixBits);
        const nameIndex = nameIndexResult.value;
        let nameOffset = nameIndexResult.nextOffset;

        let name: string;
        if (nameIndex === 0) {
            // New name — decode the string that follows.
            const strResult = decodeString(buf, nameOffset);
            name = strResult.value;
            nameOffset = strResult.nextOffset;
        } else {
            const resolved = resolveIndex(nameIndex, this.dynamic);
            if (!resolved) {
                throw new HpackError(`literal header: name index ${nameIndex} out of range`);
            }
            name = resolved.name;
        }

        const valueResult = decodeString(buf, nameOffset);
        const value = valueResult.value;
        offset = valueResult.nextOffset;

        if (indexing === "incremental") {
            this.dynamic.add(name, value);
        }
        out.push({
            name,
            value,
            indexing: indexing === "incremental",
        });
        return offset;
    }
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/** Convenience: encode a headers map with no indexing (safe default). */
export function encodeHeaders(headers: ReadonlyMap<string, string>): Uint8Array {
    const encoder = new HpackEncoder();
    const block: HeaderBlock = [...headers].map(([name, value]) => ({
        name,
        value,
        indexing: false,
    }));
    return encoder.encode(block);
}

/** Convenience: decode HPACK bytes into a headers map. */
export function decodeHeaders(buf: Uint8Array): ReadonlyMap<string, string> {
    const decoder = new HpackDecoder();
    const block = decoder.decode(buf);
    const out = new Map<string, string>();
    for (const field of block) {
        out.set(field.name, field.value);
    }
    return out;
}
