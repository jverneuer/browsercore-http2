/**
 * Small shared helpers for @browsercore/http2.
 *
 * Kept dependency-free so every package can copy the pattern without pulling in
 * cross-package imports.
 */

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
 * Monotonic-ish unique id generator (not cryptographically random).
 *
 * This is the single sanctioned home for `Date.now()` / `Math.random()` in
 * utils — other modules that need an opaque id must call this rather than
 * reaching for randomness directly.
 */
export function createId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}
