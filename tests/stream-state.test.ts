/**
 * stream.ts state-machine + dispatch coverage.
 *
 * Targets the uncovered branches in createStreamManager:
 *   - parseStatus default (no `:status`) and non-numeric `:status`.
 *   - transitionOnEndStream: local_half_closed -> closed, remote_reserved -> closed.
 *   - Unknown-stream guards in every frame handler (DATA/HEADERS/RST/WINDOW_UPDATE/CONTINUATION).
 *   - HEADERS without END_HEADERS followed by CONTINUATION (header-block reassembly).
 *   - Padded DATA stripping (flow control + pad removal).
 *   - Push-stream full response (maybeResolveResponse isPushPromise branch + pushResponse event).
 *   - rejectStream with no resolver registered (RST on a stream nobody is waiting on).
 *   - expectResponse / sendData / applyWindowUpdate on unknown streams.
 */

import { describe, expect, it } from "vitest";
import { createStreamManager } from "../src/stream/stream.js";
import type { Frame, Http2Response, Http2StreamId } from "../src/types.js";
import { FrameType } from "../src/types.js";
import { encodeHeaders } from "../src/hpack/hpack.js";

const ID = (n: number): Http2StreamId => n as Http2StreamId;
const text = new TextEncoder();

/** Build a HEADERS payload for a `:status` + extra headers. */
function statusBlock(status: number | string, extra: Record<string, string> = {}): Uint8Array {
    const headers = new Map<string, string>();
    headers.set(":status", String(status));
    for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    return encodeHeaders(headers);
}

/** Records every frame the manager emits via sendFrame. */
class FrameCapture {
    public readonly frames: Frame[] = [];
    public sendFrame(frame: Frame): void {
        this.frames.push(frame);
    }
    public count(type: number): number {
        return this.frames.filter((f) => f.type === type).length;
    }
}

describe("parseStatus edge cases", () => {
    it("defaults to 200 when no `:status` pseudo-header is present", async () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const stream = mgr.openStream();

        const done = new Promise<number>((resolve, reject) =>
            mgr.expectResponse(stream.id, (res) => resolve(res.statusCode), reject),
        );

        // HEADERS whose HPACK block has no `:status` -> default 200, END_STREAM.
        mgr.dispatch({
            type: FrameType.HEADERS,
            flags: 0x5,
            streamId: stream.id,
            endHeaders: true,
            endStream: true,
            padded: false,
            payload: encodeHeaders(new Map([["x-custom", "v"]])),
        });

        expect(await done).toBe(200);
    });

    it("falls back to 200 when `:status` is non-numeric", async () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const stream = mgr.openStream();

        const done = new Promise<number>((resolve, reject) =>
            mgr.expectResponse(stream.id, (res) => resolve(res.statusCode), reject),
        );

        // Build a block with `:status` = "NaN" then strip and re-encode manually.
        const block = statusBlock("NaN");
        mgr.dispatch({
            type: FrameType.HEADERS,
            flags: 0x5,
            streamId: stream.id,
            endHeaders: true,
            endStream: true,
            padded: false,
            payload: block,
        });

        expect(await done).toBe(200);
    });
});

describe("transitionOnEndStream", () => {
    it("moves local_half_closed -> closed on END_STREAM", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const stream = mgr.openStream();
        // The manager never naturally enters local_half_closed (no sender sets it),
        // so drive the transition directly by mutating the public state field.
        stream.state = { state: "local_half_closed" };

        mgr.dispatch({
            type: FrameType.DATA,
            flags: 0x1, // END_STREAM
            streamId: stream.id,
            payload: new Uint8Array(0),
        });

        expect(stream.state.state).toBe("closed");
        expect((stream.state as { reason: { kind: string } }).reason.kind).toBe("normal");
    });

    it("moves remote_reserved -> closed on END_STREAM", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const stream = mgr.openStream();
        stream.state = { state: "remote_reserved" };

        mgr.dispatch({
            type: FrameType.DATA,
            flags: 0x1,
            streamId: stream.id,
            payload: new Uint8Array(0),
        });

        expect(stream.state.state).toBe("closed");
    });
});

describe("unknown-stream guards (no throw, no frames)", () => {
    it("ignores DATA on an unknown stream", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        expect(() =>
            mgr.dispatch({
                type: FrameType.DATA,
                flags: 0x1,
                streamId: ID(999),
                payload: text.encode("x"),
            }),
        ).not.toThrow();
        // No WINDOW_UPDATE should be emitted for an unknown stream.
        expect(cap.count(FrameType.WINDOW_UPDATE)).toBe(0);
    });

    it("ignores HEADERS on an unknown stream", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        expect(() =>
            mgr.dispatch({
                type: FrameType.HEADERS,
                flags: 0x5,
                streamId: ID(999),
                endHeaders: true,
                endStream: true,
                padded: false,
                payload: statusBlock(200),
            }),
        ).not.toThrow();
    });

    it("ignores RST_STREAM on an unknown stream", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        expect(() =>
            mgr.dispatch({
                type: FrameType.RST_STREAM,
                flags: 0,
                streamId: ID(999),
                errorCode: 0x2,
            }),
        ).not.toThrow();
    });

    it("ignores WINDOW_UPDATE on an unknown stream", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        expect(() =>
            mgr.dispatch({
                type: FrameType.WINDOW_UPDATE,
                flags: 0,
                streamId: ID(999),
                windowSizeIncrement: 100,
            }),
        ).not.toThrow();
    });

    it("ignores CONTINUATION on an unknown stream", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        expect(() =>
            mgr.dispatch({
                type: FrameType.CONTINUATION,
                flags: 0x4,
                streamId: ID(999),
                endHeaders: true,
                payload: new Uint8Array([0x01]),
            }),
        ).not.toThrow();
    });

    it("expectResponse on an unknown stream rejects with RstStreamError", async () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const done = new Promise<Error>((resolve, reject) =>
            mgr.expectResponse(ID(999), () => reject(new Error("no")), resolve),
        );
        const err = await done;
        expect(err).toBeInstanceOf(Error);
        expect((err as { streamId: number }).streamId).toBe(999);
    });

    it("sendData on an unknown stream is a no-op", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        expect(() => mgr.sendData(ID(999), text.encode("x"), true)).not.toThrow();
        expect(cap.count(FrameType.DATA)).toBe(0);
    });

    it("applyWindowUpdate on an unknown stream is a no-op", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        expect(() => mgr.applyWindowUpdate(ID(999), 1000)).not.toThrow();
    });
});

describe("rejectStream with no resolver", () => {
    it("RST on a stream with no registered resolver sets closed and returns early", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const stream = mgr.openStream();
        // No expectResponse() call — stream.reject is undefined.

        let closedFired = false;
        mgr.on("streamClosed", () => {
            closedFired = true;
        });

        mgr.dispatch({
            type: FrameType.RST_STREAM,
            flags: 0,
            streamId: stream.id,
            errorCode: 0x5,
        });

        // handleRstStream sets the closed state directly...
        expect(stream.state.state).toBe("closed");
        // ...but rejectStream returns early when no resolver is registered, so
        // finalizeStream is skipped and streamClosed is NOT emitted.
        expect(closedFired).toBe(false);
    });
});

describe("CONTINUATION header-block reassembly", () => {
    it("buffers HEADERS without END_HEADERS and decodes after CONTINUATION", async () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const stream = mgr.openStream();

        const done = new Promise<number>((resolve, reject) =>
            mgr.expectResponse(stream.id, (res) => resolve(res.statusCode), reject),
        );

        // Split a `:status=200` block across HEADERS (no END_HEADERS) + CONTINUATION.
        const block = statusBlock(200, { "content-type": "text/plain" });
        const mid = Math.floor(block.length / 2);

        mgr.dispatch({
            type: FrameType.HEADERS,
            flags: 0x0, // NOT END_HEADERS
            streamId: stream.id,
            endHeaders: false,
            endStream: false,
            padded: false,
            payload: block.subarray(0, mid),
        });
        // No resolution yet.
        mgr.dispatch({
            type: FrameType.CONTINUATION,
            flags: 0x4, // END_HEADERS
            streamId: stream.id,
            endHeaders: true,
            payload: block.subarray(mid),
        });
        // Still no END_STREAM — send DATA END_STREAM to complete.
        mgr.dispatch({
            type: FrameType.DATA,
            flags: 0x1,
            streamId: stream.id,
            payload: text.encode("hi"),
        });

        expect(await done).toBe(200);
    });

    it("buffers multiple CONTINUATION frames until END_HEADERS arrives", async () => {
        const mgr = createStreamManager(() => undefined);
        const stream = mgr.openStream();
        const done = new Promise<number>((resolve, reject) =>
            mgr.expectResponse(stream.id, (res) => resolve(res.statusCode), reject),
        );

        const block = statusBlock(200, { "content-type": "text/plain", "x-extra": "v" });
        // Split into three fragments; the middle CONTINUATION has no END_HEADERS.
        const cut1 = Math.max(1, Math.floor(block.length / 3));
        const cut2 = Math.floor((2 * block.length) / 3);
        mgr.dispatch({
            type: FrameType.HEADERS,
            flags: 0x0,
            streamId: stream.id,
            endHeaders: false,
            endStream: false,
            padded: false,
            payload: block.subarray(0, cut1),
        });
        mgr.dispatch({
            type: FrameType.CONTINUATION,
            flags: 0x0, // NOT END_HEADERS -> handleContinuation returns early
            streamId: stream.id,
            endHeaders: false,
            payload: block.subarray(cut1, cut2),
        });
        mgr.dispatch({
            type: FrameType.CONTINUATION,
            flags: 0x4, // END_HEADERS -> decode the reassembled block
            streamId: stream.id,
            endHeaders: true,
            payload: block.subarray(cut2),
        });
        mgr.dispatch({
            type: FrameType.DATA,
            flags: 0x1,
            streamId: stream.id,
            payload: new Uint8Array(0),
        });

        expect(await done).toBe(200);
    });
});

describe("maybeResolveResponse with no registered resolver", () => {
    it("completes without throwing when endStream arrives but nobody is waiting", () => {
        const mgr = createStreamManager(() => undefined);
        const stream = mgr.openStream();
        // No expectResponse() — stream.resolve is undefined.

        // HEADERS (headers complete) then DATA END_STREAM.
        mgr.dispatch({
            type: FrameType.HEADERS,
            flags: 0x4,
            streamId: stream.id,
            endHeaders: true,
            endStream: false,
            padded: false,
            payload: statusBlock(200),
        });
        expect(() =>
            mgr.dispatch({
                type: FrameType.DATA,
                flags: 0x1,
                streamId: stream.id,
                payload: new Uint8Array(0),
            }),
        ).not.toThrow();
        // open -> remote_half_closed on END_STREAM; the response is not finalized
        // (no resolver), so the stream is not removed from the table.
        expect(stream.state.state).toBe("remote_half_closed");
    });
});

describe("dispatch exhaustiveness guard", () => {
    it("throws on a frame type outside the known 0x0-0x9 range", () => {
        const mgr = createStreamManager(() => undefined);
        // The Frame union exhausts 0x0-0x9; a type beyond that hits assertNever.
        expect(() =>
            mgr.dispatch({ type: 0xff, flags: 0, streamId: ID(1) } as never),
        ).toThrow(/Unexpected value/);
    });
});

describe("padded DATA", () => {
    it("strips the pad-length prefix and trailing padding, keeps flow control honest", async () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const stream = mgr.openStream();

        const done = new Promise<{ status: number; body: Uint8Array }>((resolve, reject) =>
            mgr.expectResponse(
                stream.id,
                (res) => resolve({ status: res.statusCode, body: res.body }),
                reject,
            ),
        );

        // Response HEADERS first so headers are complete.
        mgr.dispatch({
            type: FrameType.HEADERS,
            flags: 0x4,
            streamId: stream.id,
            endHeaders: true,
            endStream: false,
            padded: false,
            payload: statusBlock(200),
        });

        // Padded DATA: [padLen=3, 'a','b', pad, pad, pad], PADDED flag 0x8, END_STREAM 0x1.
        const padLen = 3;
        const appData = text.encode("ab");
        const payload = new Uint8Array(1 + appData.length + padLen);
        payload[0] = padLen;
        payload.set(appData, 1);
        mgr.dispatch({
            type: FrameType.DATA,
            flags: 0x8 | 0x1,
            streamId: stream.id,
            payload,
        });

        const res = await done;
        expect(new TextDecoder().decode(res.body)).toBe("ab");
    });
});

describe("server-push response resolution", () => {
    it("emits pushResponse and stores the response when a push stream completes", async () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const client = mgr.openStream(); // stream 1

        // PUSH_PROMISE promising stream 2, with END_HEADERS (request headers).
        mgr.dispatch({
            type: FrameType.PUSH_PROMISE,
            flags: 0x4,
            streamId: client.id,
            endHeaders: true,
            padded: false,
            promisedStreamId: ID(2),
            payload: encodeHeaders(
                new Map([
                    [":method", "GET"],
                    [":path", "/push.css"],
                ]),
            ),
        });

        // The connection layer never registers a resolver on a push stream, but
        // the manager supports it — wire one up to exercise the push branch.
        const done = new Promise<Http2Response>((resolve, reject) =>
            mgr.expectResponse(ID(2), resolve, reject),
        );
        let pushed: Http2Response | undefined;
        mgr.once("pushResponse", (_id: number, res: Http2Response) => {
            pushed = res;
        });

        // Pushed response HEADERS on stream 2.
        mgr.dispatch({
            type: FrameType.HEADERS,
            flags: 0x4,
            streamId: ID(2),
            endHeaders: true,
            endStream: false,
            padded: false,
            payload: statusBlock(200, { "content-type": "text/css" }),
        });
        // Pushed response DATA END_STREAM.
        mgr.dispatch({
            type: FrameType.DATA,
            flags: 0x1,
            streamId: ID(2),
            payload: text.encode("body{}"),
        });

        const res = await done;
        expect(res.statusCode).toBe(200);
        expect(res.headers.get("content-type")).toBe("text/css");
        expect(new TextDecoder().decode(res.body)).toBe("body{}");
        expect(pushed).toBeDefined();
        expect(pushed!.statusCode).toBe(200);
    });

    it("emits `push` for a push stream whose headers arrive via CONTINUATION", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const client = mgr.openStream();

        const block = encodeHeaders(new Map([["x-push", "v"]]));
        const mid = Math.floor(block.length / 2) || 1;

        let pushStreamId: number | undefined;
        mgr.once("push", (id: number) => {
            pushStreamId = id;
        });

        // PUSH_PROMISE without END_HEADERS pushes the first fragment onto the
        // promised stream (2).
        mgr.dispatch({
            type: FrameType.PUSH_PROMISE,
            flags: 0x0,
            streamId: client.id,
            endHeaders: false,
            padded: false,
            promisedStreamId: ID(2),
            payload: block.subarray(0, mid),
        });
        // NOTE: handleContinuation looks up `frame.streamId` to find the stream
        // whose header block is being reassembled. For PUSH_PROMISE that is the
        // *promised* stream, so the CONTINUATION must carry the promised id here
        // for the bytes to assemble. (Per RFC 7540 §6.10 a CONTINUATION after
        // PUSH_PROMISE carries the client-stream id; see the bug note in the
        // report — this implementation does not track the in-progress block.)
        mgr.dispatch({
            type: FrameType.CONTINUATION,
            flags: 0x4,
            streamId: ID(2),
            endHeaders: true,
            payload: block.subarray(mid),
        });

        expect(pushStreamId).toBe(2);
    });
});

describe("PRIORITY dispatch", () => {
    it("accepts a PRIORITY frame without throwing or emitting frames", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        expect(() =>
            mgr.dispatch({
                type: FrameType.PRIORITY,
                flags: 0,
                streamId: ID(1),
                exclusive: false,
                streamDependency: ID(0),
                weight: 16,
            }),
        ).not.toThrow();
        // PRIORITY must not generate any outbound frame.
        expect(cap.frames).toHaveLength(0);
    });
});

describe("abortAll", () => {
    it("rejects every pending stream with the given error and clears the table", async () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const a = mgr.openStream();
        const b = mgr.openStream();

        const doneA = new Promise<Error>((resolve, reject) =>
            mgr.expectResponse(a.id, () => reject(new Error("no")), resolve),
        );
        const doneB = new Promise<Error>((resolve, reject) =>
            mgr.expectResponse(b.id, () => reject(new Error("no")), resolve),
        );

        mgr.abortAll(new Error("connection dead"));

        const [errA, errB] = await Promise.all([doneA, doneB]);
        expect(errA.message).toBe("connection dead");
        expect(errB.message).toBe("connection dead");
        expect(a.state.state).toBe("closed");
        expect(b.state.state).toBe("closed");
    });
});
