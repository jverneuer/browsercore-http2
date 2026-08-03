/**
 * HPACK decoder (RFC 7541 §6).
 *
 * Maintains a dynamic table that mirrors the encoder's (updated reciprocally by
 * decoding the peer's headers in order). On the wire, every header-field
 * representation (§6) is one of: indexed, literal with incremental indexing,
 * literal without indexing, literal never-indexed, or a dynamic-table-size update.
 */

import type { HeaderBlock, HeaderField } from "./types.js";
import { HpackError } from "./error.js";
import { DynamicTable, DEFAULT_TABLE_SIZE_LIMIT, resolveIndex } from "./dynamic-table.js";
import { decodeInteger } from "./integer.js";
import { decodeString } from "./string.js";

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
            const octet = buf[offset];
            if (octet === undefined) {
                throw new HpackError("header decode: buffer underflow reading octet");
            }
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
            // §6.2.3 — Literal never indexed (0001xxxx). The five prefix patterns
            // above (indexed 1xxxxxxx, incremental 01xxxxxx, size update
            // 001xxxxx, no indexing 0000xxxx) exhaust the high-bit space, leaving
            // only 0001xxxx — so this is the final, unconditional case.
            offset = this.decodeLiteral(buf, offset, out, "never_indexed");
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
        const octet = buf[offset];
        if (octet === undefined) {
            throw new HpackError("literal decode: buffer underflow reading prefix octet");
        }
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
