/**
 * HPACK integer encoding (RFC 7541 §5.1).
 *
 * Integers are encoded with an N-bit prefix. When the value fits in N bits
 * directly (< 2^N - 1) it is emitted as a single octet; otherwise the prefix is
 * filled with the sentinel (all ones == "more octets follow") and the remainder
 * is emitted as one or more continuation octets, each carrying 7 bits of the
 * value, least-significant group first, with the high bit set on every octet
 * except the last.
 */

import { HpackError } from "./error.js";

/**
 * Encode `value` using an N-bit prefix. Throws on negative / non-integer input.
 * Returns the octets (the prefix octet carries no flag bits — callers OR those
 * in themselves).
 */
export function encodeInteger(value: number, prefixBits: number): number[] {
    if (value < 0 || !Number.isInteger(value)) {
        throw new HpackError(`integer encode: value must be a non-negative integer, got ${value}`);
    }
    const maxPrefix = (1 << prefixBits) - 1;
    const out: number[] = [];
    if (value < maxPrefix) {
        out.push(value);
        return out;
    }
    // Prefix filled with the sentinel. Per RFC 7541 §5.1 the remainder
    // (value - maxPrefix) is always encoded as one or more continuation octets —
    // even when it is zero.
    out.push(maxPrefix);
    let remaining = value - maxPrefix;
    while (true) {
        const octet = remaining % 128;
        remaining = Math.floor(remaining / 128);
        // Set the high bit if more octets follow.
        if (remaining > 0) {
            out.push(octet | 0x80);
        } else {
            out.push(octet);
            break;
        }
    }
    return out;
}

/** The result of decoding an integer: the value and the offset of the next byte. */
export interface DecodedInteger {
    readonly value: number;
    readonly nextOffset: number;
}

/** Read an integer starting at `buf[offset]` with an N-bit prefix. */
export function decodeInteger(buf: Uint8Array, offset: number, prefixBits: number): DecodedInteger {
    const maxPrefix = (1 << prefixBits) - 1;
    const firstOctet = buf[offset];
    if (firstOctet === undefined) {
        throw new HpackError("integer decode: buffer underflow reading first octet");
    }
    const first = firstOctet & maxPrefix;
    let position = offset + 1;
    if (first < maxPrefix) {
        return { value: first, nextOffset: position };
    }
    let value = maxPrefix;
    let shift = 0;
    while (position < buf.length) {
        const octet = buf[position];
        if (octet === undefined) {
            throw new HpackError("integer decode: buffer underflow in continuation octets");
        }
        value += (octet & 0x7f) * 2 ** shift;
        position++;
        shift += 7;
        if ((octet & 0x80) === 0) {
            return { value, nextOffset: position };
        }
    }
    throw new HpackError("integer decode: buffer underflow in continuation octets");
}
