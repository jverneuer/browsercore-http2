/**
 * Shared HPACK types (RFC 7541).
 *
 * Kept in its own module so the wire-format modules (encoder, decoder, string)
 * and the barrel (hpack.ts) can both import them without creating a cycle.
 */

/** A single header field — name + value plus an indexing hint. */
export interface HeaderField {
    readonly name: string;
    readonly value: string;
    /** Whether this field may be added to the dynamic table. */
    readonly indexing: boolean;
}

/** A header block — ordered list of fields as they appear on the wire. */
export type HeaderBlock = readonly HeaderField[];
