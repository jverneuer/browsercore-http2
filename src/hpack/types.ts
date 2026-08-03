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
    /**
     * If true, emit a never-indexed literal (RFC 7541 §6.2.3) so the value is
     * never inserted into the dynamic table — for sensitive values (e.g.
     * credentials). Takes precedence over {@link indexing}.
     */
    readonly sensitive?: boolean;
}

/** A header block — ordered list of fields as they appear on the wire. */
export type HeaderBlock = readonly HeaderField[];
