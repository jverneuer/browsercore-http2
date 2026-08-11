/**
 * Regression test for HTTP/2 error masking.
 *
 * Bug: when a transport read fails during the settings exchange (e.g. TLS AEAD
 * decryption failure on the server's first post-handshake record), the read
 * loop's catch block called `handleFatal()` — which tore down the connection
 * WITHOUT rejecting the pending `waitForSettingsAck` promise. The caller hung
 * for the full 5-second timeout and saw `SettingsAckTimeoutError`, completely
 * hiding the real transport error.
 *
 * Fix: `handleFatal()` now rejects any pending SETTINGS-ACK promise with the
 * real error before tearing down, so the caller sees the actual failure
 * immediately instead of a masked timeout.
 */

import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { connectHttp2 } from "../src/connection.js";
import { testCrypto as crypto, createFakeTransportPair } from "./fake-transport.js";
import { createMockEventProvider } from "./test-helpers.js";
import type { Transport, TransportState, TransportId, CloseReason } from "@browsercore/transport";

/** Error message simulating a TLS AEAD decryption failure. */
const TLS_ERROR_MESSAGE = "TLS AEAD decryption failed: authentication tag mismatch";

/**
 * A standalone fake transport that accepts writes (the client connection
 * preface) but rejects every `read()` — simulating a TLS decryption failure on
 * the server's first post-handshake record (e.g. the HTTP/2 SETTINGS frame).
 */
class ReadFailingTransport extends EventEmitter implements Transport {
    public readonly id: TransportId;
    private _state: TransportState = { state: "open" };

    public constructor(id = "read-fail") {
        super();
        this.id = id as TransportId;
    }

    public get state(): TransportState {
        return this._state;
    }

    public write(_data: Uint8Array): Promise<void> {
        return Promise.resolve();
    }

    public read(): Promise<Uint8Array> {
        return Promise.reject(new Error(TLS_ERROR_MESSAGE));
    }

    public close(reason?: CloseReason): Promise<void> {
        this._state = { state: "closed", reason: reason ?? { kind: "client_close" } };
        this.emit("close", false);
        return Promise.resolve();
    }
}

describe("HTTP/2 error masking — transport failure during settings exchange", () => {
    it("propagates the real transport error immediately, not a masked SettingsAckTimeoutError", async () => {
        const transport = new ReadFailingTransport();
        const start = Date.now();

        const error = await connectHttp2({
            transport,
            crypto,
            events: createMockEventProvider(),
            // Long timeout so the test proves the real error arrives well
            // before the timer fires.
            settingsAckTimeoutMs: 5_000,
        }).catch((e: Error) => e);

        const elapsed = Date.now() - start;

        // The real error must arrive in under 1 second — not 5+ seconds.
        expect(elapsed).toBeLessThan(1_000);
        // The real error message is preserved — not a masked timeout.
        expect(error.message).toBe(TLS_ERROR_MESSAGE);
        // It is NOT a SettingsAckTimeoutError.
        expect(error.name).not.toBe("SettingsAckTimeoutError");

        await transport.close();
    });

    it("propagates an abrupt peer close during settings exchange before the timeout", async () => {
        // A realistic variant: the server reads the client's preface and then
        // tears down the connection without sending an ACK. Before the fix,
        // the read-loop rejection was masked by the SettingsAckTimeoutError.
        const { client, server } = createFakeTransportPair();

        const serverDone = (async () => {
            await server.read(); // drain the client preface + SETTINGS
            // Close without sending ACK — the client's pending read rejects.
            await server.close();
        })();

        const start = Date.now();
        const error = await connectHttp2({
            transport: client,
            crypto,
            events: createMockEventProvider(),
            settingsAckTimeoutMs: 5_000,
        }).catch((e: Error) => e);

        const elapsed = Date.now() - start;

        // The error must arrive in under 1 second — not 5+ seconds.
        expect(elapsed).toBeLessThan(1_000);
        // "transport closed" — not "SETTINGS ACK not received".
        expect(error.name).not.toBe("SettingsAckTimeoutError");

        await serverDone;
    });
});
