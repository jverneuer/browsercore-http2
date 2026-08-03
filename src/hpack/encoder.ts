/**
 * HPACK encoder (RFC 7541 §6).
 *
 * Maintains the representation decisions for each header field. This encoder
 * emits only literal representations (with incremental indexing, or without
 * indexing for the safe-default path) — it does not search the static/dynamic
 * tables for indexed matches. That keeps encoding deterministic and avoids
 * coupling the encoder to a dynamic table that is only meaningful when headers
 * are processed in order with the peer's decoder.
 */

import type { HeaderField } from "./types.js";
import { encodeStringHuffman, normalizeName } from "./string.js";
import { encodeInteger } from "./integer.js";
import { assertNever } from "../utils.js";

/** Header-field representations emitted by the encoder (§6). */
type EncodedHeader =
    | { readonly kind: "indexed"; readonly index: number }
    | { readonly kind: "literal_incremental"; readonly name: string; readonly value: string }
    | { readonly kind: "literal_never_indexed"; readonly name: string; readonly value: string }
    | { readonly kind: "literal_no_indexing"; readonly name: string; readonly value: string }
    | { readonly kind: "size_update"; readonly newLimit: number };

export class HpackEncoder {
    private nextSizeUpdate: number | undefined;

    constructor(_maxTableSize: number = 4096) {
        void _maxTableSize;
    }

    /** Encode a header block into HPACK bytes. */
    public encode(headers: readonly HeaderField[]): Uint8Array {
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
        // 01_000000 prefix (0x40) + 6-bit name index (0 = new name), then the
        // name string followed by the value string (RFC 7541 §6.2.1).
        return [0x40, ...encodeStringHuffman(name), ...encodeStringHuffman(value)];
    }

    private emitLiteralNoIndexing(name: string, value: string): number[] {
        // 0000_0000 prefix (0x00) + 4-bit name index (0) + value.
        return [0x00, ...encodeStringHuffman(name), ...encodeStringHuffman(value)];
    }

    private emitLiteralNeverIndexed(name: string, value: string): number[] {
        // 0001_0000 prefix (0x10) + 4-bit name index (0) + value.
        return [0x10, ...encodeStringHuffman(name), ...encodeStringHuffman(value)];
    }

    private encodeSizeUpdate(newLimit: number): number[] {
        // 001_ prefix (5 bits) + newLimit.
        return encodeInteger(newLimit, 5).map((o, i) => (i === 0 ? o | 0x20 : o));
    }
}
