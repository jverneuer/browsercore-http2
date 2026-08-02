/**
 * Stream-manager unit tests (no transport).
 *
 * We construct a `StreamManager` with a `sendFrame` that records every frame it
 * emits, then drive frames through `dispatch()` and assert on the captured
 * frames + stream state. This exercises the state machine, flow control, and
 * frame-generation paths in isolation.
 */

import { describe, expect, it } from "vitest";
import { createStreamManager } from "../src/stream/stream.js";
import type { Frame, Http2StreamId } from "../src/types.js";
import { FrameType } from "../src/types.js";
import { RstStreamError } from "../src/errors.js";
import { encodeHeaders } from "../src/hpack/hpack.js";

const ID = (n: number): Http2StreamId => n as Http2StreamId;

/** Build a HEADERS frame payload for a response with `:status` + headers. */
function responseHeadersBlock(status: number, extra: Record<string, string> = {}): Uint8Array {
    const headers = new Map<string, string>();
    headers.set(":status", String(status));
    for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    return encodeHeaders(headers);
}

/** Capture every frame the manager emits via sendFrame. */
class FrameCapture {
    public readonly frames: Frame[] = [];
    public sendFrame(frame: Frame): void {
        this.frames.push(frame);
    }
    public last(): Frame {
        const f = this.frames[this.frames.length - 1];
        if (f === undefined) throw new Error("no frames captured");
        return f;
    }
    public count(type: number): number {
        return this.frames.filter((f) => f.type === type).length;
    }
    public find(type: number, streamId: number): Frame | undefined {
        return this.frames.find((f) => f.type === type && f.streamId === ID(streamId));
    }
}

describe("stream manager — open + response", () => {
    it("opens a stream with an odd id and reports it", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const s = mgr.openStream();
        expect(s.id).toBe(ID(1));
        expect(s.state).toEqual({ state: "open" });

        const s2 = mgr.openStream();
        expect(s2.id).toBe(ID(3));
    });

    it("resolves a request when response HEADERS + DATA END_STREAM arrive", async () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const stream = mgr.openStream();

        const resolved = new Promise<{
            status: number;
            body: Uint8Array;
            ct: string;
        }>((resolve, reject) => {
            mgr.expectResponse(stream.id, (res) => {
                resolve({
                    status: res.statusCode,
                    body: res.body,
                    ct: res.headers.get("content-type") ?? "",
                });
            }, reject);
        });

        // Response HEADERS (END_HEADERS set) on stream 1.
        mgr.dispatch({
            type: FrameType.HEADERS,
            flags: 0x4, // END_HEADERS
            streamId: stream.id,
            endHeaders: true,
            endStream: false,
            padded: false,
            payload: responseHeadersBlock(200, { "content-type": "text/plain" }),
        });

        // Response DATA with END_STREAM.
        mgr.dispatch({
            type: FrameType.DATA,
            flags: 0x1, // END_STREAM
            streamId: stream.id,
            payload: new TextEncoder().encode("hello"),
        });

        const res = await resolved;
        expect(res.status).toBe(200);
        expect(res.ct).toBe("text/plain");
        expect(new TextDecoder().decode(res.body)).toBe("hello");

        // Stream is now closed and gone.
        expect(stream.state.state).toBe("closed");
        expect(cap.count(FrameType.WINDOW_UPDATE)).toBeGreaterThan(0);
    });

    it("resolves on a HEADERS frame that itself carries END_STREAM (no body)", async () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const stream = mgr.openStream();

        const done = new Promise<number>((resolve, reject) => {
            mgr.expectResponse(stream.id, (res) => resolve(res.statusCode), reject);
        });

        mgr.dispatch({
            type: FrameType.HEADERS,
            flags: 0x5, // END_HEADERS | END_STREAM
            streamId: stream.id,
            endHeaders: true,
            endStream: true,
            padded: false,
            payload: responseHeadersBlock(204),
        });

        expect(await done).toBe(204);
    });

    it("rejects with RstStreamError on RST_STREAM", async () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const stream = mgr.openStream();

        const done = new Promise<Error>((resolve, reject) => {
            mgr.expectResponse(stream.id, () => reject(new Error("should not resolve")), (err) => resolve(err));
        });

        mgr.dispatch({
            type: FrameType.RST_STREAM,
            flags: 0,
            streamId: stream.id,
            errorCode: 0x2, // INTERNAL_ERROR
        });

        const err = await done;
        expect(err).toBeInstanceOf(RstStreamError);
        expect((err as RstStreamError).streamId).toBe(ID(1));
        expect((err as RstStreamError).errorCode).toBe(0x2);
    });
});

describe("stream manager — SETTINGS / PING", () => {
    it("emits a SETTINGS ACK when it receives a (non-ack) SETTINGS frame", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));

        mgr.dispatch({
            type: FrameType.SETTINGS,
            flags: 0,
            streamId: ID(0),
            ack: false,
            settings: { [0x3]: 50 }, // MAX_CONCURRENT_STREAMS = 50
        });

        const ack = cap.find(FrameType.SETTINGS, 0);
        expect(ack).toBeDefined();
        expect((ack as { ack: boolean }).ack).toBe(true);
        // And the peer setting is now applied.
        expect(mgr.maxConcurrentStreams).toBe(50);
    });

    it("emits a PING ACK echoing the opaque data", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const opaque = 0x0102030405060708n;

        mgr.dispatch({
            type: FrameType.PING,
            flags: 0,
            streamId: ID(0),
            ack: false,
            opaqueData: opaque,
        });

        const ack = cap.find(FrameType.PING, 0);
        expect(ack).toBeDefined();
        expect((ack as { ack: boolean }).ack).toBe(true);
        expect((ack as { opaqueData: bigint }).opaqueData).toBe(opaque);
    });

    it("emits a `settingsAck` event when the peer ACKs our SETTINGS", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        let acked = false;
        mgr.once("settingsAck", () => {
            acked = true;
        });

        mgr.dispatch({
            type: FrameType.SETTINGS,
            flags: 0x1, // ACK
            streamId: ID(0),
            ack: true,
            settings: {},
        });

        expect(acked).toBe(true);
    });

    it("emits a `pingAck` event with the echoed opaque data", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const opaque = 0xaaaaaaaaaaaaaaaan;
        let got: bigint | undefined;
        mgr.once("pingAck", (data: bigint) => {
            got = data;
        });

        mgr.dispatch({
            type: FrameType.PING,
            flags: 0x1, // ACK
            streamId: ID(0),
            ack: true,
            opaqueData: opaque,
        });

        expect(got).toBe(opaque);
    });
});

describe("stream manager — flow control", () => {
    it("sends only what the window allows and queues the rest, then drains on WINDOW_UPDATE", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));

        // Pin the stream-level send window tiny via INITIAL_WINDOW_SIZE so we can
        // observe queueing deterministically.
        mgr.dispatch({
            type: FrameType.SETTINGS,
            flags: 0,
            streamId: ID(0),
            ack: false,
            settings: { [0x4]: 100 }, // INITIAL_WINDOW_SIZE = 100
        });
        // consume the SETTINGS ACK the manager emitted
        cap.frames.length = 0;

        const stream = mgr.openStream(); // local window now = 100
        expect(stream.localWindow.size).toBe(100);

        // Send 250 bytes — only 100 should go out now.
        const body = new Uint8Array(250).fill(0x61);
        mgr.sendData(stream.id, body, true);

        const dataFrames = cap.frames.filter((f) => f.type === FrameType.DATA);
        const sentNow = dataFrames.reduce(
            (sum, f) => sum + (f as { payload: Uint8Array }).payload.length,
            0,
        );
        expect(sentNow).toBe(100);

        // The last frame sent must NOT carry END_STREAM — data remains queued.
        const lastData = dataFrames[dataFrames.length - 1]!;
        expect((lastData.flags & 0x1)).toBe(0);
        expect(stream.sendQueue.length).toBe(150);

        // A stream-level WINDOW_UPDATE of 200 drains the rest.
        mgr.applyWindowUpdate(stream.id, 200);
        const dataFrames2 = cap.frames.filter((f) => f.type === FrameType.DATA);
        const totalSent = dataFrames2.reduce(
            (sum, f) => sum + (f as { payload: Uint8Array }).payload.length,
            0,
        );
        expect(totalSent).toBe(250);
        // The final frame carries END_STREAM.
        expect((dataFrames2[dataFrames2.length - 1]!.flags & 0x1)).toBe(1);
        expect(stream.sendQueue.length).toBe(0);
    });

    it.skip("connection-level WINDOW_UPDATE drains queued sends across streams", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        // Shrink both connection + stream windows to 64.
        cap.frames.length = 0;

        const s1 = mgr.openStream();
        const big = new Uint8Array(200).fill(0x62);
        mgr.sendData(s1.id, big, false);
        const sentBefore = cap.frames.filter((f) => f.type === FrameType.DATA).length;

        // Connection window is exhausted; grow it via connection WINDOW_UPDATE.
        mgr.dispatch({
            type: FrameType.WINDOW_UPDATE,
            flags: 0,
            streamId: ID(0),
            windowSizeIncrement: 10_000,
        });
        mgr.applyWindowUpdate(s1.id, 10_000);

        const sentAfter = cap.frames.filter((f) => f.type === FrameType.DATA).length;
        expect(sentAfter).toBeGreaterThan(sentBefore);
        expect(s1.sendQueue.length).toBe(0);
    });
});

describe("stream manager — GOAWAY", () => {
    it("rejects in-flight streams opened after lastStreamId with GoawayReceivedError", async () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const s1 = mgr.openStream(); // id 1
        const s3 = mgr.openStream(); // id 3

        const done = new Promise<Error>((resolve, reject) => {
            mgr.expectResponse(s3.id, () => reject(new Error("should not resolve")), (err) => resolve(err));
        });

        mgr.dispatch({
            type: FrameType.GOAWAY,
            flags: 0,
            streamId: ID(0),
            lastStreamId: ID(1),
            errorCode: 0x1, // PROTOCOL_ERROR
            debugData: new Uint8Array([0xde, 0xad]),
        });

        const err = await done;
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toContain("GOAWAY");

        // The surviving stream (id 1) is unaffected.
        expect(s1.state.state).toBe("open");
    });
});

describe("stream manager — PUSH_PROMISE", () => {
    it("opens a remote-reserved push stream and decodes promised headers", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const client = mgr.openStream(); // id 1

        let pushedHeaders: Map<string, string> | undefined;
        mgr.once("push", (streamId: Http2StreamId, headers: unknown) => {
            expect(streamId).toBe(ID(2));
            pushedHeaders = headers as Map<string, string>;
        });

        mgr.dispatch({
            type: FrameType.PUSH_PROMISE,
            flags: 0x4, // END_HEADERS
            streamId: client.id,
            endHeaders: true,
            padded: false,
            promisedStreamId: ID(2),
            payload: encodeHeaders(
                new Map([
                    [":method", "GET"],
                    [":path", "/pushed.css"],
                    [":authority", "example.com"],
                    [":scheme", "https"],
                ]),
            ),
        });

        expect(pushedHeaders).toBeDefined();
        expect(pushedHeaders!.get(":path")).toBe("/pushed.css");
    });
});
