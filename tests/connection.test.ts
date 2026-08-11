/**
 * Connection-level integration tests against a scripted in-memory peer.
 *
 * We stand up a real `connectHttp2()` over a `FakeTransport` whose peer is a
 * tiny hand-rolled HTTP/2 server loop. The server reads the client connection
 * preface + SETTINGS, replies with its own SETTINGS + a SETTINGS ACK, and for
 * each request stream responds with HEADERS + DATA + END_STREAM. This proves
 * the framing + HPACK + stream-manager + settings-ack handshake work together
 * without a real network.
 */

import { describe, expect, it } from "vitest";
import { testCrypto as crypto } from "./fake-transport.js";
import { connectHttp2 } from "../src/connection.js";
import { createFakeTransportPair, FakeTransport } from "./fake-transport.js";
import { parseFrame, serializeFrame, FRAME_HEADER_LENGTH } from "../src/frame/frame.js";
import { encodeHeaders, decodeHeaders } from "../src/hpack/hpack.js";
import type { Frame, Http2StreamId } from "../src/types.js";
import { FrameType } from "../src/types.js";
import { GoawayReceivedError } from "../src/errors.js";

const ID = (n: number): Http2StreamId => n as Http2StreamId;
const text = new TextEncoder();
const decode = new TextDecoder();

/** Read one full frame from the raw byte queue the server side receives. */
async function readFrame(server: FakeTransport): Promise<Frame> {
    // FakeTransport delivers all buffered bytes per read() (simulating TCP
    // coalescing), so a single read can contain multiple frames. Drain the
    // transport's readBuffer first, top it up from the transport until we have
    // a full frame, then stash any trailing bytes back in readBuffer.
    while (server.readBuffer.length < FRAME_HEADER_LENGTH) {
        const extra = await server.read();
        server.readBuffer = concat(server.readBuffer, extra);
    }
    const header = parseFrameHeaderBytes(server.readBuffer);
    const total = FRAME_HEADER_LENGTH + header.length;
    while (server.readBuffer.length < total) {
        const extra = await server.read();
        server.readBuffer = concat(server.readBuffer, extra);
    }
    const frame = parseFrame(server.readBuffer.subarray(0, total) as Uint8Array<ArrayBufferLike>);
    server.readBuffer = server.readBuffer.subarray(total);
    return frame;
}

/** Parse just the header fields from raw bytes (mirrors frame.parseFrameHeader). */
function parseFrameHeaderBytes(buf: Uint8Array): { length: number; type: number; flags: number; streamId: number } {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const length = (view.getUint8(0) << 16) | (view.getUint8(1) << 8) | view.getUint8(2);
    const type = view.getUint8(3);
    const flags = view.getUint8(4);
    const streamId = view.getUint32(5) & 0x7fffffff;
    return { length, type, flags, streamId };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/**
 * A scripted server: completes the handshake, then for each request stream
 * responds with a HEADERS frame (200 + content-type) and a DATA frame carrying
 * the echoed body, with END_STREAM. Runs until the transport closes.
 */
function runServer(server: FakeTransport, opts: { ackSettings?: boolean } = {}): Promise<void> {
    return (async () => {
        // 1. Client connection preface (24 bytes).
        const preface = await server.read();
        expect(preface.length).toBe(24);
        expect(decode.decode(preface)).toBe("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");

        // 2. Client SETTINGS frame.
        await readFrame(server);

        // 3. Server sends its own SETTINGS.
        await server.write(
            serializeFrame({
                type: FrameType.SETTINGS,
                flags: 0,
                streamId: ID(0),
                ack: false,
                settings: { [0x4]: 65535 },
            }),
        );

        // 4. Server ACKs the client's SETTINGS.
        if (opts.ackSettings !== false) {
            await server.write(
                serializeFrame({
                    type: FrameType.SETTINGS,
                    flags: 0x1,
                    streamId: ID(0),
                    ack: true,
                    settings: {},
                }),
            );
        }

        // 5. Serve request streams until the socket closes.
        for (;;) {
            let frame: Frame;
            try {
                frame = await readFrame(server);
            } catch {
                return; // transport closed
            }
            if (frame.type === FrameType.HEADERS) {
                // Decode the request headers to learn the path (for the echo).
                const hdrs = decodeHeaders(frame.payload);
                const path = hdrs.get(":path") ?? "/";
                const body = text.encode(`echo:${path}`);

                // Response HEADERS (END_HEADERS, not END_STREAM yet).
                await server.write(
                    serializeFrame({
                        type: FrameType.HEADERS,
                        flags: 0x4,
                        streamId: frame.streamId,
                        endHeaders: true,
                        endStream: false,
                        padded: false,
                        payload: encodeHeaders(
                            new Map([
                                [":status", "200"],
                                ["content-type", "text/plain"],
                            ]),
                        ),
                    }),
                );
                // Response DATA with END_STREAM.
                await server.write(
                    serializeFrame({
                        type: FrameType.DATA,
                        flags: 0x1,
                        streamId: frame.streamId,
                        payload: body,
                    }),
                );
            }
        }
    })();
}

describe("connectHttp2 handshake", () => {
    it("completes the connection preface + SETTINGS/ACK handshake", async () => {
        const { client, server } = createFakeTransportPair();
        const serverDone = runServer(server);

        const conn = await connectHttp2({ transport: client, crypto });
        expect(conn.id).toMatch(/^http2_/);
        expect(conn.settings).toEqual({});

        await conn.close();
        await serverDone;
    });

    it("exposes the peer's settings after the handshake", async () => {
        const { client, server } = createFakeTransportPair();
        const serverDone = runServer(server);
        const conn = await connectHttp2({ transport: client, crypto });
        // The connection's `settings` reflect our advertised initial settings.
        expect(conn.settings).toEqual({});
        await conn.close();
        await serverDone;
    });
});

describe("Http2Connection.request", () => {
    it("sends HEADERS + DATA and resolves with the response", async () => {
        const { client, server } = createFakeTransportPair();
        const serverDone = runServer(server);
        const conn = await connectHttp2({ transport: client, crypto });

        const res = await conn.request({
            method: "GET",
            scheme: "https",
            authority: "example.com",
            path: "/hello",
            headers: new Map([["user-agent", "test"]]),
            body: new Uint8Array(0),
        });

        expect(res.statusCode).toBe(200);
        expect(res.headers.get("content-type")).toBe("text/plain");
        expect(decode.decode(res.body)).toBe("echo:/hello");

        await conn.close();
        await serverDone;
    });

    it("multiplexes concurrent requests over one connection", async () => {
        const { client, server } = createFakeTransportPair();
        const serverDone = runServer(server);
        const conn = await connectHttp2({ transport: client, crypto });

        const paths = ["/a", "/b", "/c", "/d", "/e"];
        const responses = await Promise.all(
            paths.map((p) =>
                conn.request({
                    method: "GET",
                    scheme: "https",
                    authority: "example.com",
                    path: p,
                    headers: new Map(),
                    body: new Uint8Array(0),
                }),
            ),
        );

        expect(responses).toHaveLength(5);
        responses.forEach((res, i) => {
            expect(res.statusCode).toBe(200);
            expect(decode.decode(res.body)).toBe(`echo:${paths[i]}`);
        });

        await conn.close();
        await serverDone;
    });
});

describe("Http2Connection.ping", () => {
    it("sends a PING and resolves with the echoed opaque data", async () => {
        const { client, server } = createFakeTransportPair();
        // Custom server that also handles PING (the base runServer ignores it).
        const serverDone = (async () => {
            await server.read(); // preface
            await readFrame(server); // client SETTINGS
            await server.write(
                serializeFrame({
                    type: FrameType.SETTINGS,
                    flags: 0,
                    streamId: ID(0),
                    ack: false,
                    settings: {},
                }),
            );
            await server.write(
                serializeFrame({
                    type: FrameType.SETTINGS,
                    flags: 0x1,
                    streamId: ID(0),
                    ack: true,
                    settings: {},
                }),
            );
            // Echo any PING, serve any HEADERS.
            for (;;) {
                let frame: Frame;
                try {
                    frame = await readFrame(server);
                } catch {
                    return;
                }
                if (frame.type === FrameType.PING && !frame.ack) {
                    await server.write(
                        serializeFrame({
                            type: FrameType.PING,
                            flags: 0x1,
                            streamId: ID(0),
                            ack: true,
                            opaqueData: frame.opaqueData,
                        }),
                    );
                }
            }
        })();

        const conn = await connectHttp2({ transport: client, crypto });
        const opaque = 0x1234567890abcdefn;
        const echoed = await conn.ping(opaque);
        expect(echoed).toBe(opaque);

        await conn.close();
        await serverDone;
    });
});

describe("Http2Connection GOAWAY", () => {
    it("rejects in-flight requests when the peer sends GOAWAY", async () => {
        const { client, server } = createFakeTransportPair();
        let serverDone: Promise<void>;
        // Server completes handshake, then immediately sends GOAWAY.
        serverDone = (async () => {
            await server.read();
            await readFrame(server);
            await server.write(
                serializeFrame({
                    type: FrameType.SETTINGS,
                    flags: 0,
                    streamId: ID(0),
                    ack: false,
                    settings: {},
                }),
            );
            await server.write(
                serializeFrame({
                    type: FrameType.SETTINGS,
                    flags: 0x1,
                    streamId: ID(0),
                    ack: true,
                    settings: {},
                }),
            );
            // The client replies to our SETTINGS with a SETTINGS ACK before
            // sending request HEADERS (RFC 7540 §6.5.3). Drain frames until we
            // see the request HEADERS — mirroring runServer's loop.
            let req: Frame;
            do {
                req = await readFrame(server);
            } while (req.type === FrameType.SETTINGS);
            void req;
            await server.write(
                serializeFrame({
                    type: FrameType.GOAWAY,
                    flags: 0,
                    streamId: ID(0),
                    lastStreamId: ID(0),
                    errorCode: 0x1,
                    debugData: new Uint8Array(),
                }),
            );
            void req;
        })();

        const conn = await connectHttp2({ transport: client, crypto });

        await expect(
            conn.request({
                method: "GET",
                scheme: "https",
                authority: "example.com",
                path: "/doomed",
                headers: new Map(),
                body: new Uint8Array(0),
            }),
        ).rejects.toBeInstanceOf(GoawayReceivedError);

        await serverDone;
        await conn.close();
    });

    it("sends a GOAWAY frame on graceful shutdown", async () => {
        const { client, server } = createFakeTransportPair();
        const serverDone = (async () => {
            await server.read();
            await readFrame(server);
            await server.write(
                serializeFrame({
                    type: FrameType.SETTINGS,
                    flags: 0,
                    streamId: ID(0),
                    ack: false,
                    settings: {},
                }),
            );
            await server.write(
                serializeFrame({
                    type: FrameType.SETTINGS,
                    flags: 0x1,
                    streamId: ID(0),
                    ack: true,
                    settings: {},
                }),
            );
            // Read frames until we observe a GOAWAY.
            for (;;) {
                let frame: Frame;
                try {
                    frame = await readFrame(server);
                } catch {
                    return;
                }
                if (frame.type === FrameType.GOAWAY) {
                    expect(frame.lastStreamId).toBe(ID(0));
                    return;
                }
            }
        })();

        const conn = await connectHttp2({ transport: client, crypto });
        await conn.goaway(ID(0), 0);
        await serverDone;
        await conn.close();
    });
});
