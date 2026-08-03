/**
 * HPACK static table (RFC 7541 Appendix A).
 *
 * The 61 canonical header entries, indexed 1..61. Each entry contributes
 * `name.length + value.length + 32` bytes to the dynamic-table size budget
 * (§4.1), but the static table itself is never evicted.
 */

/** A single static-table entry — name + optional value. */
export interface StaticEntry {
    readonly name: string;
    readonly value: string;
}

/** The 61 entries of the HPACK static table, indexed 1..STATIC_TABLE_LENGTH. */
export const STATIC_TABLE: readonly StaticEntry[] = [
    { name: ":authority", value: "" },
    { name: ":method", value: "GET" },
    { name: ":method", value: "POST" },
    { name: ":path", value: "/" },
    { name: ":path", value: "/index.html" },
    { name: ":scheme", value: "http" },
    { name: ":scheme", value: "https" },
    { name: "status", value: "200" },
    { name: "status", value: "204" },
    { name: "status", value: "206" },
    { name: "status", value: "304" },
    { name: "status", value: "400" },
    { name: "status", value: "404" },
    { name: "status", value: "500" },
    { name: "accept-charset", value: "" },
    { name: "accept-encoding", value: "gzip, deflate" },
    { name: "accept-language", value: "" },
    { name: "accept-ranges", value: "" },
    { name: "accept", value: "" },
    { name: "access-control-allow-origin", value: "" },
    { name: "age", value: "" },
    { name: "allow", value: "" },
    { name: "authorization", value: "" },
    { name: "cache-control", value: "" },
    { name: "content-disposition", value: "" },
    { name: "content-encoding", value: "" },
    { name: "content-language", value: "" },
    { name: "content-length", value: "" },
    { name: "content-location", value: "" },
    { name: "content-range", value: "" },
    { name: "content-type", value: "" },
    { name: "cookie", value: "" },
    { name: "date", value: "" },
    { name: "etag", value: "" },
    { name: "expect", value: "" },
    { name: "expires", value: "" },
    { name: "from", value: "" },
    { name: "host", value: "" },
    { name: "if-match", value: "" },
    { name: "if-modified-since", value: "" },
    { name: "if-none-match", value: "" },
    { name: "if-range", value: "" },
    { name: "if-unmodified-since", value: "" },
    { name: "last-modified", value: "" },
    { name: "link", value: "" },
    { name: "location", value: "" },
    { name: "max-forwards", value: "" },
    { name: "proxy-authenticate", value: "" },
    { name: "proxy-authorization", value: "" },
    { name: "range", value: "" },
    { name: "referer", value: "" },
    { name: "refresh", value: "" },
    { name: "retry-after", value: "" },
    { name: "server", value: "" },
    { name: "set-cookie", value: "" },
    { name: "strict-transport-security", value: "" },
    { name: "transfer-encoding", value: "" },
    { name: "user-agent", value: "" },
    { name: "vary", value: "" },
    { name: "via", value: "" },
    { name: "www-authenticate", value: "" },
];

/** Total number of entries in the static table (its indices run 1..STATIC_TABLE_LENGTH). */
export const STATIC_TABLE_LENGTH = STATIC_TABLE.length;

/**
 * Per-entry overhead in bytes (RFC 7541 §4.1): 32 bytes of fixed cost on top of
 * the name/value octet lengths.
 */
export const TABLE_ENTRY_OVERHEAD = 32;
