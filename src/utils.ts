/**
 * Small shared helpers for @browsercore/http2.
 *
 * Kept dependency-free so every package can copy the pattern without pulling in
 * cross-package imports.
 */

import { systemClock, type Clock } from "./types.js";

/**
 * Exhaustiveness check for `switch`/`if-else` over discriminated unions.
 * Call in the `default` branch: `default: assertNever(x)`.
 * Adding a new union member forces every handler to compile-error until handled.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function assertNever(x: never): never {
    throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}

/**
 * Unique id generator (not cryptographically random).
 *
 * This is the single sanctioned home for id generation in utils — other modules
 * that need an opaque id must call this rather than reaching for the clock or
 * randomness directly. The clock is injectable (defaults to {@link systemClock})
 * so callers can supply a deterministic source under test.
 */
export function createId(prefix: string, clock: Clock = systemClock): string {
    return `${prefix}_${clock.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}
