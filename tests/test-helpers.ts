/**
 * Shared test helpers for http2 tests — in-memory EventProvider + CryptoProvider mocks.
 *
 * Like the transport package, @browsercore/http2 provides NO fallback
 * EventProvider; every test must inject one. This mock implements the full
 * EventProvider interface so tests can construct the stream manager and the
 * connection without pulling in node:events.
 *
 * `createMockCryptoProvider()` provides a CryptoProvider whose `randomBytes`
 * is backed by the platform Web Crypto API (used by PING opaque-data
 * generation); every other method throws, since http2 uses crypto ONLY for
 * non-protocol randomness. The production singleton is assembled in
 * browsersmith from `@browsercore/crypto`'s Node backend — protocol packages
 * never import a runtime crypto instance.
 */

import type { CryptoProvider, EventProvider } from "@browsercore/contracts";

/**
 * Create a minimal in-memory EventProvider. Stand-in for the Node
 * EventEmitter-backed provider that browsersmith injects in production.
 *
 * @returns A fresh EventProvider backed by an in-memory listener map.
 */
export function createMockEventProvider(): EventProvider {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    return {
        on(event, listener) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(listener);
        },
        once(event, listener) {
            const wrapped = (...args: unknown[]) => {
                listeners.get(event)?.delete(wrapped);
                listener(...args);
            };
            this.on(event, wrapped);
        },
        off(event, listener) {
            listeners.get(event)?.delete(listener);
        },
        removeListener(event, listener) {
            listeners.get(event)?.delete(listener);
        },
        emit(event, ...args) {
            const set = listeners.get(event);
            if (!set || set.size === 0) return false;
            for (const l of [...set]) l(...args);
            return true;
        },
        listenerCount(event) {
            return listeners.get(event)?.size ?? 0;
        },
        removeAllListeners(event) {
            if (event) listeners.delete(event);
            else listeners.clear();
        },
    };
}

/**
 * A CryptoProvider stand-in for tests. `randomBytes` is backed by the platform
 * Web Crypto API (`globalThis.crypto.getRandomValues`) so PING opaque-data
 * generation behaves as in production; every other method throws, because
 * @browsercore/http2 touches crypto ONLY for non-protocol randomness (it never
 * performs AEAD, HKDF, key agreement, etc.). A throw surfaces accidental
 * coupling rather than masking it.
 *
 * @returns A CryptoProvider whose `randomBytes` is real and whose remaining
 *   surface is unimplemented.
 */
export function createMockCryptoProvider(): CryptoProvider {
    const notImplemented = (method: string): never => {
        throw new Error(
            `createMockCryptoProvider: '${method}' is not implemented — http2 uses crypto only for randomBytes()`,
        );
    };

    return {
        randomBytes(length: number): Uint8Array {
            const out = new Uint8Array(length);
            globalThis.crypto.getRandomValues(out);
            return out;
        },
        sha256: () => notImplemented("sha256"),
        sha384: () => notImplemented("sha384"),
        hkdf: () => notImplemented("hkdf"),
        hmac: () => notImplemented("hmac"),
        aes128GcmEncrypt: () => notImplemented("aes128GcmEncrypt"),
        aes128GcmDecrypt: () => notImplemented("aes128GcmDecrypt"),
        aes256GcmEncrypt: () => notImplemented("aes256GcmEncrypt"),
        aes256GcmDecrypt: () => notImplemented("aes256GcmDecrypt"),
        aes128CcmEncrypt: () => notImplemented("aes128CcmEncrypt"),
        aes128CcmDecrypt: () => notImplemented("aes128CcmDecrypt"),
        chacha20Poly1305Encrypt: () => notImplemented("chacha20Poly1305Encrypt"),
        chacha20Poly1305Decrypt: () => notImplemented("chacha20Poly1305Decrypt"),
        x25519GenerateKeyPair: () => notImplemented("x25519GenerateKeyPair"),
        x25519SharedSecret: () => notImplemented("x25519SharedSecret"),
        ecdhGenerateKeyPair: () => notImplemented("ecdhGenerateKeyPair"),
        ecdhSharedSecret: () => notImplemented("ecdhSharedSecret"),
        verifySignature: () => notImplemented("verifySignature"),
        aesEcbEncrypt: () => notImplemented("aesEcbEncrypt"),
    };
}
