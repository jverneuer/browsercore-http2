/**
 * HPACK dynamic table (RFC 7541 §2.3, §4).
 *
 * A bounded table of header fields shared between encoder and decoder. New
 * entries are inserted at the front (highest index); when the total size exceeds
 * the limit, oldest entries are evicted from the back until the budget is met.
 *
 * The index space is shared with the static table: static entries use indices
 * 1..STATIC_TABLE_LENGTH, dynamic entries use STATIC_TABLE_LENGTH+1..n. The
 * dynamic table's front (most recent) maps to the highest index.
 */

import { STATIC_TABLE, STATIC_TABLE_LENGTH, TABLE_ENTRY_OVERHEAD } from "./static-table.js";

/** A single dynamic-table entry — name + value (the only fields that matter). */
interface DynamicEntry {
    readonly name: string;
    readonly value: string;
}

/** Default dynamic-table size limit (RFC 7541 §4.2 default = 4096). */
export const DEFAULT_TABLE_SIZE_LIMIT = 4096;

export class DynamicTable {
    private entries: DynamicEntry[] = [];
    private currentSize = 0;
    private maxSize: number;

    constructor(limit: number = DEFAULT_TABLE_SIZE_LIMIT) {
        this.maxSize = limit;
    }

    /** Current size limit (bytes). */
    public get limit(): number {
        return this.maxSize;
    }

    /** Current total octet size of all entries (name + value + 32 each). */
    public get size(): number {
        return this.currentSize;
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
        this.currentSize += entrySize;
        this.evictToFit(this.maxSize >= entrySize ? this.maxSize : entrySize);
    }

    /**
     * Resize the limit. Evicts entries if the new limit is smaller than the
     * current total size. RFC 7541 §4.2: a dynamic-table-size update at the
     * *beginning* of the first header block; we apply it immediately here.
     */
    public setLimit(newLimit: number): void {
        this.maxSize = newLimit;
        this.evictToFit(newLimit);
    }

    /** Evict oldest entries until the total size fits within `budget`. */
    private evictToFit(budget: number): void {
        while (this.currentSize > budget && this.entries.length > 0) {
            const removed = this.entries.pop();
            if (removed) {
                this.currentSize -= removed.name.length + removed.value.length + TABLE_ENTRY_OVERHEAD;
            }
        }
    }
}

/** Result of resolving an index: either a static entry or a dynamic one. */
export type ResolvedHeader =
    | { readonly source: "static"; readonly name: string; readonly value: string }
    | { readonly source: "dynamic"; readonly name: string; readonly value: string };

/**
 * Look up `index` across the static + dynamic tables. Returns `undefined` if
 * the index is out of bounds.
 */
export function resolveIndex(index: number, dynamic: DynamicTable): ResolvedHeader | undefined {
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
