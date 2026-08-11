/**
 * Convenience helpers for HPACK encode/decode.
 *
 * Thin wrappers over HpackEncoder / HpackDecoder for the common case of
 * encoding a headers map with configurable indexing/Huffman, or decoding HPACK
 * bytes back into a headers map.
 */

import type { HeaderBlock } from "./types.js";
import { HpackEncoder } from "./encoder.js";
import { HpackDecoder } from "./decoder.js";

/**
 * Options for {@link encodeHeaders}.
 */
export interface EncodeHeadersOptions {
    /** Whether to use incremental indexing for emitted header fields. Default `false`. */
    readonly indexing?: boolean | undefined;
    /** Whether to Huffman-encode string literals. Default `true`. */
    readonly useHuffman?: boolean | undefined;
    /** Max HPACK dynamic table size. Default 4096. */
    readonly maxTableSize?: number | undefined;
}

/**
 * Convenience: encode a headers map into HPACK bytes.
 *
 * @param headers  Ordered name→value map.
 * @param options  Optional indexing / Huffman / table-size overrides.
 */
export function encodeHeaders(
    headers: ReadonlyMap<string, string>,
    options?: EncodeHeadersOptions,
): Uint8Array {
    const encoder = new HpackEncoder({
        maxTableSize: options?.maxTableSize,
        useHuffman: options?.useHuffman,
    });
    const indexing = options?.indexing ?? false;
    const block: HeaderBlock = [...headers].map(([name, value]) => ({
        name,
        value,
        indexing,
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
