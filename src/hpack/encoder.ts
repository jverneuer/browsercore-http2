/**
 * HPACK encoder (RFC 7541 §6).
 *
 * Selects a wire representation for each header field:
 *   - exact static-table match (name + value) → Indexed Header Field (§6.1);
 *   - name-only static-table match → a literal referencing the name index;
 *   - otherwise → a literal carrying a new name.
 *
 * The literal flavor is chosen from the field's hints: {@link HeaderField.sensitive}
 * forces never-indexed (§6.2.3); {@link HeaderField.indexing} selects incremental
 * indexing (§6.2.1); the default is without indexing (§6.2.2). The encoder does
 * not consult the dynamic table — that keeps encoding deterministic and decoupled
 * from a table that is only meaningful when headers are processed in order with
 * the peer's decoder.
 */

import type { HeaderField } from "./types.js";
import { STATIC_TABLE } from "./static-table.js";
import { encodeStringHuffman, normalizeName } from "./string.js";
import { encodeInteger } from "./integer.js";
import { assertNever } from "../utils.js";

/** Header-field representations emitted by the encoder (§6). */
type EncodedHeader =
    | { readonly kind: "indexed"; readonly index: number }
    | { readonly kind: "literal_incremental"; readonly nameIndex: number; readonly name: string | undefined; readonly value: string }
    | { readonly kind: "literal_never_indexed"; readonly nameIndex: number; readonly name: string | undefined; readonly value: string }
    | { readonly kind: "literal_no_indexing"; readonly nameIndex: number; readonly name: string | undefined; readonly value: string }
    | { readonly kind: "size_update"; readonly newLimit: number };

/**
 * Find the static-table index (1-based) of an exact name+value match, or
 * `undefined` if none exists.
 */
function findStaticExactIndex(name: string, value: string): number | undefined {
    let index = 1;
    for (const entry of STATIC_TABLE) {
        if (entry.name === name && entry.value === value) {
            return index;
        }
        index++;
    }
    return undefined;
}

/**
 * Find the static-table index (1-based) of the first entry sharing this name, or
 * `undefined` if the name is not in the table.
 */
function findStaticNameIndex(name: string): number | undefined {
    let index = 1;
    for (const entry of STATIC_TABLE) {
        if (entry.name === name) {
            return index;
        }
        index++;
    }
    return undefined;
}

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
        const value = field.value;

        // Sensitive values are never indexed (§6.2.3), regardless of `indexing`.
        if (field.sensitive === true) {
            const nameIndex = findStaticNameIndex(name);
            return {
                kind: "literal_never_indexed",
                nameIndex: nameIndex ?? 0,
                name: nameIndex === undefined ? name : undefined,
                value,
            };
        }

        // Exact static-table match → Indexed Header Field (§6.1).
        const exact = findStaticExactIndex(name, value);
        if (exact !== undefined) {
            return { kind: "indexed", index: exact };
        }

        // Name-only static match → reference the index; else carry a new name.
        const nameIndex = findStaticNameIndex(name);
        const resolvedName = nameIndex === undefined ? name : undefined;
        const resolvedIndex = nameIndex ?? 0;

        if (field.indexing) {
            return { kind: "literal_incremental", nameIndex: resolvedIndex, name: resolvedName, value };
        }
        return { kind: "literal_no_indexing", nameIndex: resolvedIndex, name: resolvedName, value };
    }

    /** Emit the wire octets for a planned header representation. */
    private emitHeader(header: EncodedHeader): number[] {
        switch (header.kind) {
            case "indexed":
                return this.emitIndexed(header.index);
            case "literal_incremental":
                return this.emitLiteralIncremental(header.nameIndex, header.name, header.value);
            case "literal_never_indexed":
                return this.emitLiteralNeverIndexed(header.nameIndex, header.name, header.value);
            case "literal_no_indexing":
                return this.emitLiteralNoIndexing(header.nameIndex, header.name, header.value);
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

    private emitLiteralIncremental(nameIndex: number, name: string | undefined, value: string): number[] {
        // 01_000000 prefix (0x40) + 6-bit name index (0 = new name). When the
        // name is new, the name string follows; the value string always does
        // (RFC 7541 §6.2.1).
        const indexOctets = encodeInteger(nameIndex, 6).map((o, i) => (i === 0 ? o | 0x40 : o));
        const nameOctets = nameIndex === 0 && name !== undefined ? encodeStringHuffman(name) : [];
        return [...indexOctets, ...nameOctets, ...encodeStringHuffman(value)];
    }

    private emitLiteralNoIndexing(nameIndex: number, name: string | undefined, value: string): number[] {
        // 0000_0000 prefix (0x00) + 4-bit name index (0 = new name) (§6.2.2). The
        // high flag bits are already zero in encodeInteger's output, so no OR.
        const indexOctets = encodeInteger(nameIndex, 4);
        const nameOctets = nameIndex === 0 && name !== undefined ? encodeStringHuffman(name) : [];
        return [...indexOctets, ...nameOctets, ...encodeStringHuffman(value)];
    }

    private emitLiteralNeverIndexed(nameIndex: number, name: string | undefined, value: string): number[] {
        // 0001_0000 prefix (0x10) + 4-bit name index (0 = new name) (§6.2.3).
        const indexOctets = encodeInteger(nameIndex, 4).map((o, i) => (i === 0 ? o | 0x10 : o));
        const nameOctets = nameIndex === 0 && name !== undefined ? encodeStringHuffman(name) : [];
        return [...indexOctets, ...nameOctets, ...encodeStringHuffman(value)];
    }

    private encodeSizeUpdate(newLimit: number): number[] {
        // 001_ prefix (5 bits) + newLimit.
        return encodeInteger(newLimit, 5).map((o, i) => (i === 0 ? o | 0x20 : o));
    }
}
