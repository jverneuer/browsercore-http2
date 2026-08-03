/**
 * Convenience helpers for HPACK encode/decode.
 *
 * Thin wrappers over HpackEncoder / HpackDecoder for the common case of
 * encoding a headers map with no indexing (safe default) or decoding HPACK
 * bytes back into a headers map.
 */

import type { HeaderBlock } from "./types.js";
import { HpackEncoder } from "./encoder.js";
import { HpackDecoder } from "./decoder.js";

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
