/**
 * Regression gate for issue #57 — duplicate header fields collapse last-wins.
 *
 * The HPACK decoder has always yielded the full ordered pair list; the collapse
 * happened in stream assembly (`decodePendingHeaders` built a `Map` from the
 * pairs, last-wins). The fix threads the ordered list into `DecodedHeadersImpl`:
 *
 *   - `getHeaderValues(name)` returns EVERY value in wire order — the
 *     multi-`Set-Cookie` fidelity path (RFC 9113 §8.2.3);
 *   - the flat record stays a `ReadonlyMap<string, string>` whose view is
 *     LAST-WINS per name (backward compatible);
 *   - duplicate pseudo-headers are malformed (RFC 9113 §8.3) and reject the
 *     stream with `MalformedHeadersError` — pseudo-headers stay single-valued.
 *
 * Two harnesses: direct stream-manager dispatch (no transport) and a full
 * connection over the fake transport pair, mirroring tests/hpack-reuse.test.ts.
 */

import { describe, expect, it } from "vitest";
import { createStreamManager } from "../src/stream/stream.js";
import { connectHttp2 } from "../src/connection.js";
import { DecodedHeadersImpl, FrameType } from "../src/types.js";
import type { DecodedHeaders, Frame, Http2Response, Http2StreamId } from "../src/types.js";
import { MalformedHeadersError } from "../src/errors.js";
import { HpackDecoder, HpackEncoder } from "../src/hpack/hpack.js";
import {
    serializeFrame,
    parseFrame,
    parseFrameHeader,
    FRAME_HEADER_LENGTH,
} from "../src/frame/frame.js";
import { testCrypto, createFakeTransportPair, type FakeTransport } from "./fake-transport.js";
import { createMockEventProvider } from "./test-helpers.js";

const ID = (n: number): Http2StreamId => n as Http2StreamId;
const text = new TextEncoder();

/**
 * Encode an ordered list of header pairs into an HPACK block. Unlike
 * `encodeHeaders` (map → block), this preserves duplicate names and wire
 * order — literals without indexing so the decode is stateless.
 */
function encodeBlock(pairs: readonly (readonly [string, string])[]): Uint8Array {
    const encoder = new HpackEncoder({ maxTableSize: 0, useHuffman: false });
    return encoder.encode(pairs.map(([name, value]) => ({ name, value, indexing: false })));
}

/** Capture every frame the manager emits via sendFrame. */
class FrameCapture {
    public readonly frames: Frame[] = [];
    public sendFrame(frame: Frame): void {
        this.frames.push(frame);
    }
}

/** Resolve/reject pair for a stream's pending response. */
function responseFor(
    mgr: ReturnType<typeof createStreamManager>,
    streamId: Http2StreamId,
): Promise<Http2Response> {
    return new Promise((resolve, reject) => {
        mgr.expectResponse(streamId, resolve, reject);
    });
}

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

describe("HPACK decode preserves ordered pairs (no dedup at the decode layer)", () => {
    it("HpackDecoder.decode yields duplicate fields in wire order", () => {
        const block = encodeBlock([
            [":status", "200"],
            ["set-cookie", "a=1"],
            ["set-cookie", "b=2"],
        ]);
        const decoded = new HpackDecoder().decode(block);
        expect(decoded.map((f) => [f.name, f.value] as const)).toEqual([
            [":status", "200"],
            ["set-cookie", "a=1"],
            ["set-cookie", "b=2"],
        ]);
    });
});

describe("DecodedHeadersImpl — flat record + multi-value fidelity", () => {
    it("returns every value for a repeated field in wire order", () => {
        const h = new DecodedHeadersImpl([
            { name: "set-cookie", value: "a=1" },
            { name: "x-single", value: "v" },
            { name: "set-cookie", value: "b=2" },
            { name: "set-cookie", value: "c=3" },
        ]);
        expect(h.getHeaderValues("set-cookie")).toEqual(["a=1", "b=2", "c=3"]);
        expect(h.getHeaderValues("x-single")).toEqual(["v"]);
        expect(h.getHeaderValues("x-absent")).toEqual([]);
    });

    it("matches field names case-insensitively (HTTP field names are case-insensitive)", () => {
        const h = new DecodedHeadersImpl([{ name: "set-cookie", value: "a=1" }]);
        expect(h.getHeaderValues("SET-COOKIE")).toEqual(["a=1"]);
        expect(h.getHeaderValues("Set-Cookie")).toEqual(["a=1"]);
    });

    it("flat record stays last-wins per name (backward compatible)", () => {
        const h = new DecodedHeadersImpl([
            { name: "set-cookie", value: "a=1" },
            { name: "x-single", value: "v" },
            { name: "set-cookie", value: "b=2" },
        ]);
        expect(h.get("set-cookie")).toBe("b=2");
        expect(h.has("x-single")).toBe(true);
        expect(h.size).toBe(2); // deduped: repeated names collapse in the flat view
        expect([...h.entries()]).toEqual([
            ["set-cookie", "b=2"],
            ["x-single", "v"],
        ]);
    });

    it("empty block yields an empty container with no values", () => {
        const h = new DecodedHeadersImpl([]);
        expect(h.size).toBe(0);
        expect(h.getHeaderValues("x")).toEqual([]);
    });

    it("delegates the remaining ReadonlyMap surface to the flat record", () => {
        const h = new DecodedHeadersImpl([
            { name: "a", value: "1" },
            { name: "b", value: "2" },
        ]);
        const visited: Array<readonly [string, string]> = [];
        h.forEach((value, key, map) => {
            // The map argument is the container itself — a working ReadonlyMap.
            expect(map.get(key)).toBe(value);
            visited.push([key, value]);
        });
        expect(visited).toEqual([
            ["a", "1"],
            ["b", "2"],
        ]);
        expect([...h.values()]).toEqual(["1", "2"]);
        expect([...h.keys()]).toEqual(["a", "b"]);
        // Symbol.iterator — the container spreads like any ReadonlyMap.
        expect([...h]).toEqual([
            ["a", "1"],
            ["b", "2"],
        ]);
    });
});

describe("stream assembly preserves duplicate response fields (issue #57)", () => {
    it("getHeaderValues('set-cookie') returns both values in wire order across one HEADERS block", async () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const stream = mgr.openStream();
        const done = responseFor(mgr, stream.id);

        mgr.dispatch({
            type: FrameType.HEADERS,
            flags: 0x4, // END_HEADERS
            streamId: stream.id,
            endHeaders: true,
            endStream: false,
            padded: false,
            payload: encodeBlock([
                [":status", "200"],
                ["set-cookie", "session=abc; Path=/"],
                ["set-cookie", "prefs=dark; Secure"],
            ]),
        });
        mgr.dispatch({
            type: FrameType.DATA,
            flags: 0x1, // END_STREAM
            streamId: stream.id,
            payload: new Uint8Array(0),
        });

        const res = await done;
        expect(res.headers.getHeaderValues("set-cookie")).toEqual([
            "session=abc; Path=/",
            "prefs=dark; Secure",
        ]);
        expect(res.statusCode).toBe(200);
    });

    it("preserves wire order across three duplicates interleaved with other fields", async () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const stream = mgr.openStream();
        const done = responseFor(mgr, stream.id);

        mgr.dispatch({
            type: FrameType.HEADERS,
            flags: 0x5, // END_HEADERS | END_STREAM
            streamId: stream.id,
            endHeaders: true,
            endStream: true,
            padded: false,
            payload: encodeBlock([
                [":status", "200"],
                ["x-a", "1"],
                ["set-cookie", "first=1"],
                ["x-b", "2"],
                ["set-cookie", "second=2"],
                ["set-cookie", "third=3"],
            ]),
        });

        const res = await done;
        expect(res.headers.getHeaderValues("set-cookie")).toEqual(["first=1", "second=2", "third=3"]);
        // Non-pseudo first-occurrence order is untouched in the flat view.
        expect([...res.headers.keys()]).toEqual([":status", "x-a", "set-cookie", "x-b"]);
    });

    it("flat record still collapses to last-wins (backward compatibility)", async () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const stream = mgr.openStream();
        const done = responseFor(mgr, stream.id);

        mgr.dispatch({
            type: FrameType.HEADERS,
            flags: 0x5,
            streamId: stream.id,
            endHeaders: true,
            endStream: true,
            padded: false,
            payload: encodeBlock([
                [":status", "200"],
                ["set-cookie", "stale=0"],
                ["set-cookie", "fresh=1"],
            ]),
        });

        const res = await done;
        // The flat ReadonlyMap view behaves exactly as before the fix.
        expect(res.headers.get("set-cookie")).toBe("fresh=1");
        expect([...res.headers.entries()].filter(([n]) => n === "set-cookie")).toEqual([
            ["set-cookie", "fresh=1"],
        ]);
        expect(res.headers.has("set-cookie")).toBe(true);
    });

    it("returns [] for absent fields and still resolves single-valued headers", async () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const stream = mgr.openStream();
        const done = responseFor(mgr, stream.id);

        mgr.dispatch({
            type: FrameType.HEADERS,
            flags: 0x5,
            streamId: stream.id,
            endHeaders: true,
            endStream: true,
            padded: false,
            payload: encodeBlock([
                [":status", "204"],
                ["content-type", "text/plain"],
            ]),
        });

        const res = await done;
        expect(res.headers.getHeaderValues("set-cookie")).toEqual([]);
        expect(res.headers.get("content-type")).toBe("text/plain");
    });
});

describe("pseudo-header uniqueness (RFC 9113 §8.3)", () => {
    it("rejects the stream with MalformedHeadersError on a duplicate :status", async () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const stream = mgr.openStream();

        const outcome = new Promise<Error>((resolve) => {
            mgr.expectResponse(stream.id, () => resolve(new Error("must not resolve")), resolve);
        });

        mgr.dispatch({
            type: FrameType.HEADERS,
            flags: 0x5,
            streamId: stream.id,
            endHeaders: true,
            endStream: true,
            padded: false,
            payload: encodeBlock([
                [":status", "200"],
                [":status", "204"],
            ]),
        });

        const err = await outcome;
        expect(err).toBeInstanceOf(MalformedHeadersError);
        expect((err as MalformedHeadersError).field).toBe(":status");
        expect((err as MalformedHeadersError).streamId).toBe(stream.id);
        // The stream is torn down, but the connection is not: the manager
        // keeps serving new streams.
        expect(stream.state.state).toBe("closed");
    });

    it("rejects a duplicate :path and keeps the manager usable for the next stream", async () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const stream = mgr.openStream();

        const outcome = new Promise<Error>((resolve) => {
            mgr.expectResponse(stream.id, () => resolve(new Error("must not resolve")), resolve);
        });

        mgr.dispatch({
            type: FrameType.HEADERS,
            flags: 0x5,
            streamId: stream.id,
            endHeaders: true,
            endStream: true,
            padded: false,
            payload: encodeBlock([
                [":path", "/a"],
                [":path", "/b"],
            ]),
        });

        const err = await outcome;
        expect((err as MalformedHeadersError).field).toBe(":path");

        // A subsequent stream on the SAME manager decodes normally.
        const next = mgr.openStream();
        const done = responseFor(mgr, next.id);
        mgr.dispatch({
            type: FrameType.HEADERS,
            flags: 0x5,
            streamId: next.id,
            endHeaders: true,
            endStream: true,
            padded: false,
            payload: encodeBlock([[":status", "404"]]),
        });
        expect((await done).statusCode).toBe(404);
    });
});

describe("push path preserves duplicate fields", () => {
    it("the 'push' event carries every promised request-header value in wire order", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const client = mgr.openStream();

        let pushed: DecodedHeaders | undefined;
        mgr.on("push", (id: number, headers: unknown) => {
            expect(id).toBe(2);
            pushed = headers as DecodedHeaders;
        });

        mgr.dispatch({
            type: FrameType.PUSH_PROMISE,
            flags: 0x4, // END_HEADERS
            streamId: client.id,
            endHeaders: true,
            padded: false,
            promisedStreamId: ID(2),
            payload: encodeBlock([
                [":method", "GET"],
                [":scheme", "https"],
                [":authority", "example.test"],
                [":path", "/push.css"],
                ["set-cookie", "a=1"],
                ["set-cookie", "b=2"],
            ]),
        });

        expect(pushed).toBeDefined();
        expect(pushed!.getHeaderValues("set-cookie")).toEqual(["a=1", "b=2"]);
        // Flat view unaffected.
        expect(pushed!.get("set-cookie")).toBe("b=2");
    });
});

// ---------------------------------------------------------------------------
// Full-connection path: the container flows through connectHttp2 -> request()
// unchanged, with a scripted peer (mirrors tests/hpack-reuse.test.ts harness).
// ---------------------------------------------------------------------------

describe("end-to-end: multi-Set-Cookie response over a real connection", () => {
    it("request() resolves with a headers container exposing both set-cookie values", async () => {
        const { client, server } = createFakeTransportPair();

        // Scripted peer: handshake, then serve one request whose response
        // HEADERS carry two set-cookie literals (RFC 9113 §8.2.3 shape).
        void (async () => {
            await server.read(); // client preface (24 bytes)
            await readFrame(server); // client preface SETTINGS
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
                    flags: 0x1, // ACK
                    streamId: ID(0),
                    ack: true,
                    settings: {},
                }),
            );
            await readFrame(server); // the client's request HEADERS
            await server.write(
                serializeFrame({
                    type: FrameType.HEADERS,
                    flags: 0x4, // END_HEADERS
                    streamId: ID(1),
                    endHeaders: true,
                    endStream: false,
                    padded: false,
                    payload: encodeBlock([
                        [":status", "200"],
                        ["set-cookie", "session=abc; Path=/"],
                        ["set-cookie", "prefs=dark; Secure"],
                        ["content-type", "text/plain"],
                    ]),
                }),
            );
            await server.write(
                serializeFrame({
                    type: FrameType.DATA,
                    flags: 0x1, // END_STREAM
                    streamId: ID(1),
                    payload: text.encode("ok"),
                }),
            );
        })();

        const conn = await connectHttp2({
            transport: client,
            crypto: testCrypto,
            events: createMockEventProvider(),
        });

        const res = await conn.request({
            method: "GET",
            scheme: "https",
            authority: "example.test",
            path: "/",
            headers: new Map(),
            body: undefined,
        });

        expect(res.statusCode).toBe(200);
        expect(res.headers.getHeaderValues("set-cookie")).toEqual([
            "session=abc; Path=/",
            "prefs=dark; Secure",
        ]);
        expect(res.headers.get("set-cookie")).toBe("prefs=dark; Secure");
        expect(res.headers.get("content-type")).toBe("text/plain");

        await conn.close();
    });
});
