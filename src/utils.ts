/**
 * Small shared helpers for @browsercore/http2.
 *
 * Kept dependency-free so every package can copy the pattern without pulling in
 * cross-package imports.
 */

import type { Http2StreamId } from "./types.js";

/**
 * Exhaustiveness check for `switch`/`if-else` over discriminated unions.
 * Call in the `default` branch: `default: assertNever(x)`.
 * Adding a new union member forces every handler to compile-error until handled.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function assertNever(x: never): never {
    throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}

/** Generate a fresh, odd-numbered, branded HTTP/2 stream id. */
export function createStreamId(): Http2StreamId {
    // Client-initiated streams use odd ids. Monotonic + odd = (n * 2) + 1.
    const next = (Math.floor(Math.random() * 0x3fffffff) * 2) + 1;
    return next as Http2StreamId;
}
