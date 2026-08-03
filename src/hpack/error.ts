/**
 * HPACK-specific error (RFC 7541).
 *
 * Raised when the wire format is malformed or the dynamic table is referenced out
 * of bounds. Lives in its own module so the wire-format modules (integer, string,
 * decoder) and the barrel (hpack.ts) can both import it without a cycle.
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
