/**
 * HPACK string literals and Huffman coding (RFC 7541 §5.2).
 *
 * A length-prefixed string carries a Huffman flag in the high bit of the length
 * prefix: 1 = Huffman-encoded bitstring, 0 = literal octets. HPACK strings are
 * always ISO-8859-1 (Latin-1) — one byte per code point.
 */

import { HUFFMAN_TABLE } from "./huffman-table.js";
import { decodeInteger, encodeInteger } from "./integer.js";
import { HpackError } from "./error.js";

/**
 * Encode a literal octet string with Huffman: build a bitstring from Huffman
 * codes (MSB-first), pad to the next byte boundary with 1-bits, and emit the
 * bytes. Returns the encoded octets (without the length prefix — callers prepend
 * that with the Huffman flag bit).
 */
export function huffmanEncode(input: Uint8Array): number[] {
    let buffer = 0;
    let bitsInBuffer = 0;
    const out: number[] = [];
    for (const byte of input) {
        const row = HUFFMAN_TABLE[byte];
        if (row === undefined) {
            throw new HpackError("huffman encode: invalid byte value");
        }
        // Push `row.bits` bits of `row.code` (already MSB-aligned in the spec).
        buffer = (buffer << row.bits) | row.code;
        bitsInBuffer += row.bits;
        while (bitsInBuffer >= 8) {
            bitsInBuffer -= 8;
            out.push((buffer >> bitsInBuffer) & 0xff);
        }
    }
    // Pad with 1-bits up to the next byte boundary (§5.2 requires padding to
    // the most-significant bit of the final octet).
    if (bitsInBuffer > 0) {
        const padBits = 8 - bitsInBuffer;
        const padding = (1 << padBits) - 1;
        out.push(((buffer << padBits) | padding) & 0xff);
    }
    return out;
}

/**
 * Decode a Huffman-encoded string. Walks the bitstream MSB-first, matching the
 * longest prefix that corresponds to a Huffman code. Throws if the bit pattern
 * is invalid (eos or incomplete).
 */
export function huffmanDecode(buf: Uint8Array, offset: number, length: number): { value: string; nextOffset: number } {
    let bitBuffer = 0;
    let bitsAvailable = 0;
    let position = offset;
    const end = offset + length;
    const chars: number[] = [];

    while (position < end || bitsAvailable > 0) {
        // Top up the bit buffer until we have at least the max Huffman code
        // length. We accumulate with multiply-and-add (rather than a bitwise
        // shift) so the buffer can hold more than 32 bits without the
        // sign-bit truncation that `<<` would otherwise cause.
        while (bitsAvailable < 30 && position < end) {
            const octet = buf[position];
            if (octet === undefined) {
                throw new HpackError("huffman decode: buffer underflow reading octet");
            }
            bitBuffer = bitBuffer * 256 + octet;
            bitsAvailable += 8;
            position++;
        }
        // Try to match a Huffman row: walk codes long-to-short. We pick the
        // longest row whose (bits, code) prefix matches the top of the buffer.
        let matched = false;
        for (const row of HUFFMAN_TABLE) {
            if (row.bits > bitsAvailable) {
                continue;
            }
            const shift = bitsAvailable - row.bits;
            const top = Math.floor(bitBuffer / 2 ** shift) % (2 ** row.bits);
            // Compare against the row's code, which is right-aligned per row.bits.
            if (top === row.code) {
                chars.push(row.symbol);
                bitsAvailable = shift;
                bitBuffer = bitsAvailable > 0 ? bitBuffer % (2 ** bitsAvailable) : 0;
                matched = true;
                break;
            }
        }
        if (!matched) {
            throw new HpackError("huffman decode: no matching code");
        }
        // Once we've consumed all source octets, any remaining bits must be
        // valid padding (all 1s); otherwise the encoding is malformed.
        if (position >= end) {
            const mod = bitsAvailable > 0 ? 2 ** bitsAvailable : 1;
            if (bitBuffer % mod === mod - 1) {
                break;
            }
        }
    }

    return { value: decodeLatin1(chars), nextOffset: end };
}

/** Decode an array of byte values into a JS string (HPACK strings are ISO-8859-1). */
export function decodeLatin1(bytes: readonly number[]): string {
    let out = "";
    for (const b of bytes) {
        out += String.fromCodePoint(b);
    }
    return out;
}

/** Encode a JS string into ISO-8859-1 bytes (each char must fit in 8 bits). */
export function encodeLatin1(s: string): Uint8Array {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
        const code = s.codePointAt(i);
        if (code === undefined) {
            throw new HpackError(`string encode: missing character at offset ${i}`);
        }
        if (code > 0xff) {
            throw new HpackError(`string encode: non-latin1 character at offset ${i}: U+${code.toString(16)}`);
        }
        out[i] = code;
    }
    return out;
}

/** The result of decoding a length-prefixed string: value + next byte offset. */
export interface DecodedString {
    readonly value: string;
    readonly nextOffset: number;
}

/**
 * Decode a length-prefixed string (§5.2). The high bit of the length prefix is
 * the Huffman flag: 1 = Huffman-encoded, 0 = literal octets.
 */
export function decodeString(buf: Uint8Array, offset: number): DecodedString {
    const flagOctet = buf[offset];
    if (flagOctet === undefined) {
        throw new HpackError("string decode: buffer underflow reading length prefix");
    }
    const huffmanFlag = (flagOctet & 0x80) !== 0;
    const lengthResult = decodeInteger(buf, offset, 7);
    const length = lengthResult.value;
    const dataStart = lengthResult.nextOffset;
    const dataEnd = dataStart + length;
    if (dataEnd > buf.length) {
        throw new HpackError(`string decode: length ${length} exceeds buffer (offset ${dataStart}, buffer ${buf.length})`);
    }
    if (huffmanFlag) {
        const huffResult = huffmanDecode(buf, dataStart, length);
        return { value: huffResult.value, nextOffset: dataEnd };
    }
    const slice = buf.subarray(dataStart, dataEnd);
    const value = decodeLatin1([...slice]);
    return { value, nextOffset: dataEnd };
}

/**
 * Encode a string with Huffman. Returns the octets including the length prefix
 * (high bit set to indicate Huffman).
 */
export function encodeStringHuffman(value: string): number[] {
    const raw = encodeLatin1(value);
    const encoded = huffmanEncode(raw);
    const lengthOctets = encodeInteger(encoded.length, 7);
    const firstLengthOctet = lengthOctets[0];
    if (firstLengthOctet === undefined) {
        throw new HpackError("string encode: empty length prefix");
    }
    // Set the Huffman flag on the first octet.
    lengthOctets[0] = firstLengthOctet | 0x80;
    return [...lengthOctets, ...encoded];
}

/**
 * Lower-case a header name (§8.1.2 — header field names are case-insensitive and
 * HTTP/2 lower-cases them on the wire). Values are preserved verbatim.
 */
export function normalizeName(name: string): string {
    return name.toLowerCase();
}
