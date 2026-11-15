/**
 * Regression gate for bugs/h2-hpack-reuse-desync (fixed 2026-11-15).
 *
 * HPACK dynamic-table state is per-CONNECTION (RFC 7541 §4): one encoder and
 * one decoder must survive every header block exchanged on a connection, in
 * arrival order. The 584 unit tests all passed while real pooled crawls
 * against docs.python.org / www.iana.org failed ~50% of requests ("indexed
 * header: index 76 out of range", GOAWAY(PROTOCOL_ERROR)) because every
 * test peer was itself stateless — the missing coverage is exactly a peer
 * that keeps HPACK state across responses, like every real server does.
 *
 * These tests stand up an in-process HTTP/2 peer built from the package's
 * own frame primitives over fake duplex transports. The peer:
 *   - decodes request header blocks with ONE persistent HpackDecoder
 *     (tracking dynamic-table inserts across requests);
 *   - reads SETTINGS_HEADER_TABLE_SIZE from the client's preface SETTINGS
 *     and validates every dynamic-table size update in request blocks
 *     against the cap IT advertised;
 *   - answers later responses with indexed references into ITS dynamic
 *     table (what nghttpx/nginx do on request #2 of a kept-alive h2
 *     connection).
 */

import { describe, expect, it } from "vitest";
import { testCrypto as crypto } from "./fake-transport.js";
import { connectHttp2 } from "../src/connection.js";
import { createFakeTransportPair, type FakeTransport } from "./fake-transport.js";
import { serializeFrame, parseFrame, parseFrameHeader, FRAME_HEADER_LENGTH } from "../src/frame/frame.js";
import { HpackDecoder, encodeHeaders } from "../src/hpack/hpack.js";
import { encodeInteger, decodeInteger } from "../src/hpack/integer.js";
import { FrameType, Http2Settings } from "../src/types.js";
import type { Frame, Http2SettingsMap, Http2StreamId } from "../src/types.js";
import { createMockEventProvider } from "./test-helpers.js";

const ID = (n: number): Http2StreamId => n as Http2StreamId;

/** Concatenate byte arrays. */
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}

/** Read one full frame from a FakeTransport's buffered byte queue. */
async function readFrame(t: FakeTransport): Promise<Frame> {
    while (t.readBuffer.length < FRAME_HEADER_LENGTH) {
        const extra = await t.read();
        t.readBuffer = concatBytes([t.readBuffer, extra]);
    }
    const header = parseFrameHeader(t.readBuffer);
    const total = FRAME_HEADER_LENGTH + header.length;
    while (t.readBuffer.length < total) {
        const extra = await t.read();
        t.readBuffer = concatBytes([t.readBuffer, extra]);
    }
    const frame = parseFrame(t.readBuffer.subarray(0, total));
    t.readBuffer = t.readBuffer.subarray(total);
    return frame;
}

/** Wire octets for an Indexed Header Field (§6.1) referencing absolute `index`. */
function indexedField(index: number): Uint8Array {
    const octets = encodeInteger(index, 7).map((o, i) => (i === 0 ? o | 0x80 : o));
    return Uint8Array.from(octets);
}

/**
 * Values of the dynamic table size updates (§6.3) that LEAD a header block.
 * The 001xxxxx pattern is unambiguous: no header-field representation starts
 * with 001, so this reliably detects (and only detects) leading updates.
 */
function leadingTableSizeUpdates(payload: Uint8Array): number[] {
    const values: number[] = [];
    let offset = 0;
    while (offset < payload.length) {
        const octet = payload[offset];
        if (octet === undefined || (octet & 0xe0) !== 0x20) {
            break;
        }
        const decoded = decodeInteger(payload, offset, 5);
        values.push(decoded.value);
        offset = decoded.nextOffset;
    }
    return values;
}

/** What the scripted peer observed while serving requests (before client close). */
interface PeerObservations {
    /** Decoded `:path` of each request block, in arrival order. */
    readonly requestPaths: string[];
    /** Per request block: the leading dynamic table size update values. */
    readonly requestSizeUpdates: number[][];
    /** Frame types the client sent while requests were being served. */
    readonly clientFrameTypes: number[];
    /** HEADER_TABLE_SIZE the client advertised in its preface SETTINGS. */
    clientAdvertisedTableSize: number | undefined;
}

interface StatefulPeerOptions {
    /** SETTINGS the peer advertises (HEADER_TABLE_SIZE caps the client's request encoder). */
    readonly settings?: Http2SettingsMap;
    /** Build the response HPACK block for the n-th request (1-based). */
    readonly responseBlock: (n: number) => Uint8Array;
    /** Observations filled in as the peer serves; read after the returned promise resolves. */
    readonly observations: PeerObservations;
}

/**
 * Run a stateful HTTP/2 peer: full handshake, then serve each request with
 * `responseBlock(n)`. Request blocks are decoded with ONE persistent
 * HpackDecoder whose limit is the header-table cap this peer advertised —
 * the decode side of "state must live on the connection". Returns a promise
 * that resolves when the peer's frame loop ends (transport closed).
 */
function runStatefulPeer(server: FakeTransport, opts: StatefulPeerOptions): Promise<void> {
    const peerDecoder = new HpackDecoder(opts.settings?.[Http2Settings.HEADER_TABLE_SIZE]);
    return (async () => {
        const tryWrite = async (bytes: Uint8Array): Promise<void> => {
            try {
                await server.write(bytes);
            } catch {
                /* transport closed — end of script */
            }
        };
        // 1. Client connection preface (24 bytes).
        const preface = await server.read();
        if (preface.length !== 24) return;

        // 2. Client preface SETTINGS — honor HEADER_TABLE_SIZE if advertised.
        const clientSettings = await readFrame(server);
        opts.observations.clientAdvertisedTableSize = clientSettings.type === FrameType.SETTINGS
            ? clientSettings.settings[Http2Settings.HEADER_TABLE_SIZE]
            : undefined;

        // 3. Peer SETTINGS (may cap the client's encoder table) + 4. ACK.
        await tryWrite(
            serializeFrame({
                type: FrameType.SETTINGS,
                flags: 0,
                streamId: ID(0),
                ack: false,
                settings: opts.settings ?? {},
            }),
        );
        await tryWrite(
            serializeFrame({
                type: FrameType.SETTINGS,
                flags: 0x1,
                streamId: ID(0),
                ack: true,
                settings: {},
            }),
        );

        // 5. Serve requests until the transport closes.
        let requestCount = 0;
        for (;;) {
            let frame: Frame;
            try {
                frame = await readFrame(server);
            } catch {
                return; // transport closed
            }
            if (frame.type !== FrameType.HEADERS) {
                opts.observations.clientFrameTypes.push(frame.type);
                continue;
            }
            requestCount++;
            // Decode with the PERSISTENT decoder — inserts from earlier
            // requests shift indexes; a stateless decode would desync.
            const fields = peerDecoder.decode(frame.payload);
            const path = fields.find((f) => f.name === ":path")?.value ?? "(none)";
            opts.observations.requestPaths.push(path);
            opts.observations.requestSizeUpdates.push(leadingTableSizeUpdates(frame.payload));
            opts.observations.clientFrameTypes.push(frame.type);
            await tryWrite(
                serializeFrame({
                    type: FrameType.HEADERS,
                    flags: 0x4 | 0x1, // END_HEADERS | END_STREAM
                    streamId: frame.streamId,
                    endHeaders: true,
                    endStream: true,
                    padded: false,
                    payload: opts.responseBlock(requestCount),
                }),
            );
        }
    })();
}

/** A minimal request against the connection under test. */
function makeRequest(n: number) {
    return {
        method: "GET",
        scheme: "https",
        authority: "example.com",
        path: `/r/${n}`,
        headers: new Map<string, string>(),
        body: new Uint8Array(0),
    };
}

// ---------------------------------------------------------------------------
// Response-direction desync: the peer indexes into its dynamic table on
// later responses (this is the "index 76 out of range" failure mode).
// ---------------------------------------------------------------------------

describe("HPACK state reuse across sequential requests on one connection", () => {
    it("decodes dynamic-table-indexed response headers on requests 2 and 3", async () => {
        const { client, server } = createFakeTransportPair();
        const observations: PeerObservations = {
            requestPaths: [],
            requestSizeUpdates: [],
            clientFrameTypes: [],
            clientAdvertisedTableSize: undefined,
        };
        // Response 1 inserts :status/content-type/x-trace via incremental
        // literals. Dynamic table after block 1 (newest = 62):
        //   62 = x-trace "res-1", 63 = content-type, 64 = :status "200"
        // Response 2 references 64 and 63 as indexed fields, then inserts a
        // new x-trace (becomes 62). Response 3 references 65/64 after the
        // shift. Exactly what a real server's encoder does from request 2 on.
        const responseBlock = (n: number): Uint8Array => {
            if (n === 1) {
                return encodeHeaders(
                    new Map<string, string>([
                        [":status", "200"],
                        ["content-type", "text/html"],
                        ["x-trace", "res-1"],
                    ]),
                    { indexing: true },
                );
            }
            const statusIndex = n === 2 ? 64 : 65;
            const contentTypeIndex = n === 2 ? 63 : 64;
            return concatBytes([
                indexedField(statusIndex),
                indexedField(contentTypeIndex),
                encodeHeaders(new Map<string, string>([["x-trace", `res-${n}`]]), { indexing: true }),
            ]);
        };
        const serverDone = runStatefulPeer(server, { responseBlock, observations });

        const conn = await connectHttp2({
            transport: client,
            crypto,
            events: createMockEventProvider(),
            // Exercise the request direction too: the client's persistent
            // encoder emits incremental literals; the peer's persistent
            // decoder must track the inserts across requests.
            hpackIndexing: true,
        });

        const res1 = await conn.request(makeRequest(1));
        expect(res1.statusCode).toBe(200);
        expect(res1.headers.get("content-type")).toBe("text/html");
        expect(res1.headers.get("x-trace")).toBe("res-1");

        const res2 = await conn.request(makeRequest(2));
        expect(res2.statusCode).toBe(200);
        expect(res2.headers.get("content-type")).toBe("text/html");
        expect(res2.headers.get("x-trace")).toBe("res-2");

        const res3 = await conn.request(makeRequest(3));
        expect(res3.statusCode).toBe(200);
        expect(res3.headers.get("content-type")).toBe("text/html");
        expect(res3.headers.get("x-trace")).toBe("res-3");

        // Request direction: the peer decoded every request block (with
        // tracked inserts) to the right path.
        expect(observations.requestPaths).toEqual(["/r/1", "/r/2", "/r/3"]);
        // No GOAWAY / RST_STREAM left the client while requests were served.
        expect(observations.clientFrameTypes).not.toContain(FrameType.GOAWAY);
        expect(observations.clientFrameTypes).not.toContain(FrameType.RST_STREAM);

        await conn.close();
        await serverDone;
    });
});

// ---------------------------------------------------------------------------
// Encoder-direction lifetime: a dynamic table size update is announced once
// per CHANGE (RFC 7541 §4.2), not re-emitted by every request's header block.
// ---------------------------------------------------------------------------

describe("HPACK encoder table-size announcements on connection reuse", () => {
    it("announces a non-default table size once, not on every request block", async () => {
        const { client, server } = createFakeTransportPair();
        const observations: PeerObservations = {
            requestPaths: [],
            requestSizeUpdates: [],
            clientFrameTypes: [],
            clientAdvertisedTableSize: undefined,
        };
        runStatefulPeer(server, {
            settings: {},
            responseBlock: () => encodeHeaders(new Map<string, string>([["x-reply", "ok"]])),
            observations,
            done: Promise.resolve(),
        });

        const conn = await connectHttp2({
            transport: client,
            crypto,
            events: createMockEventProvider(),
            hpackMaxTableSize: 256,
        });

        for (let n = 1; n <= 3; n++) {
            const res = await conn.request(makeRequest(n));
            expect(res.headers.get("x-reply")).toBe("ok");
        }

        expect(observations.requestSizeUpdates.length).toBe(3);
        // First block announces the configured 256-byte table…
        expect(observations.requestSizeUpdates[0]?.length).toBe(1);
        expect(observations.requestSizeUpdates[0]?.[0]).toBe(256);
        // …and it is never re-announced on later blocks.
        expect(observations.requestSizeUpdates[1]).toEqual([]);
        expect(observations.requestSizeUpdates[2]).toEqual([]);

        await conn.close();
    });

    it("clamps the encoder table size to the peer's SETTINGS_HEADER_TABLE_SIZE", async () => {
        const { client, server } = createFakeTransportPair();
        const observations: PeerObservations = {
            requestPaths: [],
            requestSizeUpdates: [],
            clientFrameTypes: [],
            clientAdvertisedTableSize: undefined,
        };
        runStatefulPeer(server, {
            // The peer caps the client's request encoder at 256 bytes.
            settings: { [Http2Settings.HEADER_TABLE_SIZE]: 256 },
            responseBlock: () => encodeHeaders(new Map<string, string>([["x-reply", "ok"]])),
            observations,
            done: Promise.resolve(),
        });

        const conn = await connectHttp2({
            transport: client,
            crypto,
            events: createMockEventProvider(),
        });

        for (let n = 1; n <= 3; n++) {
            const res = await conn.request(makeRequest(n));
            expect(res.headers.get("x-reply")).toBe("ok");
        }

        const allUpdates = observations.requestSizeUpdates.flat();
        // The 4096 -> 256 clamp IS announced (a size update follows a change).
        expect(allUpdates.length).toBe(1);
        // The announcement respects the peer's cap — announcing more would be
        // a COMPRESSION_ERROR at the peer's decoder.
        expect(allUpdates[0]).toBeLessThanOrEqual(256);
        // Announced at most by block 2 (the peer's SETTINGS are processed
        // before request 1's response resolves), never on block 3.
        expect(observations.requestSizeUpdates[2]).toEqual([]);

        await conn.close();
    });
});
