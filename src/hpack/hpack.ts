/**
 * HPACK — Header Compression for HTTP/2 (RFC 7541).
 *
 * Barrel module: re-exports the public surface from the focused submodules.
 * The implementation is split across:
 *   - types.ts        — shared HeaderField / HeaderBlock types
 *   - error.ts        — HpackError (typed, with a `kind` discriminator)
 *   - static-table.ts — the 61-entry static table (Appendix A)
 *   - huffman-table.ts— the Huffman code table (Appendix B)
 *   - integer.ts      — N-bit prefix integer encoding (§5.1)
 *   - string.ts       — length-prefixed string literals + Huffman (§5.2)
 *   - dynamic-table.ts— the bounded, evicting dynamic table (§2.3, §4)
 *   - encoder.ts      — HPACK encoder (§6)
 *   - decoder.ts      — HPACK decoder (§6)
 */

export { HpackEncoder } from "./encoder.js";
export { HpackDecoder } from "./decoder.js";
export { HpackError } from "./error.js";
export { encodeHeaders } from "./helpers.js";
export { decodeHeaders } from "./helpers.js";
export type { HeaderField, HeaderBlock } from "./types.js";
