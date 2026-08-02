/**
 * A scriptable in-memory Transport for testing the HTTP/2 connection without a
 * real network. It implements the `Transport` interface from @browsercore/transport
 * over two internal byte queues so a test can push bytes the client "receives"
 * and inspect bytes the client "wrote".
 *
 * It is NOT a real transport — it exists only to drive connection.test.ts.
 */

import { EventEmitter } from "node:events";
import type { Transport } from "@browsercore/transport";
import type { CloseReason, TransportId, TransportState } from "@browsercore/transport";

/** A minimal stand-in for the branded transport id. */
type Id = TransportId;

/**
 * A pair of connected fake transports: everything written to one is readable
 * from the other. Used to connect a client to a scripted "peer".
 */
export function createFakeTransportPair(): {
    client: FakeTransport;
    server: FakeTransport;
} {
    const client = new FakeTransport("client");
    const server = new FakeTransport("server");
    client._peer = server;
    server._peer = client;
    return { client, server };
}

export class FakeTransport extends EventEmitter implements Transport {
    public readonly id: Id;
    private _state: TransportState = { state: "open" };
    /** Bytes written by this side, buffered for the peer to read. */
    private readonly _writeBuffer: number[] = [];
    /**
     * Leftover bytes from a previous read() that the consumer did not consume.
     * FakeTransport delivers all buffered bytes per read() (simulating TCP
     * coalescing), so a single read can contain more than one frame; consumers
     * that read frame-by-frame must hold the trailing bytes here for the next
     * read. This field is public so test helpers can drain it.
     */
    public readBuffer: Uint8Array = new Uint8Array(0);
    /** Waiters blocked on a read when the buffer was empty. */
    private _pendingRead: ((data: Uint8Array) => void) | undefined;
    private _pendingReadReject: ((err: Error) => void) | undefined;
    /** The connected peer, if any. */
    public _peer: FakeTransport | undefined;

    public constructor(id: string) {
        super();
        this.id = id as Id;
    }

    public get state(): TransportState {
        return this._state;
    }

    public write(data: Uint8Array): Promise<void> {
        if (this._state.state !== "open") {
            return Promise.reject(new Error(`transport ${this.id} is ${this._state.state}`));
        }
        // If there is a connected peer, route bytes to it; otherwise buffer.
        const peer = this._peer;
        if (peer !== undefined) {
            peer._deliver(data);
            return Promise.resolve();
        }
        for (let i = 0; i < data.length; i++) this._writeBuffer.push(data[i]!);
        return Promise.resolve();
    }

    public read(): Promise<Uint8Array> {
        if (this._state.state !== "open") {
            return Promise.reject(new Error(`transport ${this.id} is ${this._state.state}`));
        }
        if (this._writeBuffer.length > 0) {
            const data = Uint8Array.from(this._writeBuffer);
            this._writeBuffer.length = 0;
            return Promise.resolve(data);
        }
        return new Promise<Uint8Array>((resolve, reject) => {
            this._pendingRead = resolve;
            this._pendingReadReject = reject;
        });
    }

    public close(reason?: CloseReason): Promise<void> {
        if (this._state.state === "closed") return Promise.resolve();
        this._state = { state: "closed", reason: reason ?? { kind: "client_close" } };
        const rejecter = this._pendingReadReject;
        if (rejecter !== undefined) {
            this._pendingRead = undefined;
            this._pendingReadReject = undefined;
            rejecter(new Error("transport closed"));
        }
        // Closing one end of the duplex pair must signal the peer: a real
        // transport tears down both directions together, so the peer's pending
        // reads reject and any subsequent read() sees a closed transport.
        const peer = this._peer;
        if (peer !== undefined && peer._state.state !== "closed") {
            peer._state = { state: "closed", reason: { kind: "peer_close" } };
            const peerRejecter = peer._pendingReadReject;
            if (peerRejecter !== undefined) {
                peer._pendingRead = undefined;
                peer._pendingReadReject = undefined;
                peerRejecter(new Error("transport closed"));
            }
        }
        this.emit("close", false);
        return Promise.resolve();
    }

    /** Push bytes into this side's read buffer (simulating data arriving). */
    private _deliver(data: Uint8Array): void {
        for (let i = 0; i < data.length; i++) this._writeBuffer.push(data[i]!);
        const pending = this._pendingRead;
        if (pending !== undefined) {
            this._pendingRead = undefined;
            this._pendingReadReject = undefined;
            const buffered = Uint8Array.from(this._writeBuffer);
            this._writeBuffer.length = 0;
            pending(buffered);
        }
    }
}
