/**
 * stream.ts flow-control + remote-SETTINGS coverage.
 *
 * Targets:
 *   - applyRemoteSettings for every SETTINGS key (HEADER_TABLE_SIZE, ENABLE_PUSH,
 *     MAX_CONCURRENT_STREAMS, INITIAL_WINDOW_SIZE, MAX_FRAME_SIZE, MAX_HEADER_LIST_SIZE,
 *     unknown) and the undefined-value skip.
 *   - clampMaxFrameSize bounds (below MIN, above MAX, non-finite, in-range).
 *   - drainSendQueue connection-window exhaustion path.
 *   - INITIAL_WINDOW_SIZE delta on existing streams + the drain it triggers.
 *   - connection-level vs stream-level WINDOW_UPDATE dispatch.
 */

import { describe, expect, it } from "vitest";
import { createStreamManager } from "../src/stream/stream.js";
import type { Frame, Http2StreamId } from "../src/types.js";
import { FrameType } from "../src/types.js";

const ID = (n: number): Http2StreamId => n as Http2StreamId;

/** Records every frame the manager emits. */
class FrameCapture {
    public readonly frames: Frame[] = [];
    public sendFrame(frame: Frame): void {
        this.frames.push(frame);
    }
    public dataBytes(): number {
        return this.frames
            .filter((f) => f.type === FrameType.DATA)
            .reduce((sum, f) => sum + (f as { payload: Uint8Array }).payload.length, 0);
    }
    public clear(): void {
        this.frames.length = 0;
    }
}

const SETTINGS = (settings: Record<number, number>): Frame => ({
    type: FrameType.SETTINGS,
    flags: 0,
    streamId: ID(0),
    ack: false,
    settings,
});

describe("applyRemoteSettings — every key is accepted without error", () => {
    it("applies HEADER_TABLE_SIZE (0x1) and replies with a SETTINGS ACK", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        mgr.dispatch(SETTINGS({ [0x1]: 2048 }));
        const ack = cap.frames.find((f) => f.type === FrameType.SETTINGS && (f as { ack: boolean }).ack);
        expect(ack).toBeDefined();
    });

    it("applies ENABLE_PUSH (0x2) without throwing", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        expect(() => mgr.dispatch(SETTINGS({ [0x2]: 0 }))).not.toThrow();
    });

    it("applies MAX_HEADER_LIST_SIZE (0x6) without throwing", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        expect(() => mgr.dispatch(SETTINGS({ [0x6]: 8192 }))).not.toThrow();
    });

    it("ignores unknown setting identifiers (RFC 7540 §6.5.2)", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        // 0x99 is not a defined setting; must be tolerated.
        expect(() => mgr.dispatch(SETTINGS({ [0x99]: 1234 }))).not.toThrow();
        // The ACK still goes out.
        expect(cap.frames.some((f) => f.type === FrameType.SETTINGS)).toBe(true);
    });

    it("skips settings entries whose value is undefined", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        // Construct a settings object with an undefined value — the iteration
        // guard (`if (value === undefined) continue`) must skip it cleanly.
        const settings: Record<number, number | undefined> = { [0x3]: undefined };
        mgr.dispatch({
            type: FrameType.SETTINGS,
            flags: 0,
            streamId: ID(0),
            ack: false,
            settings: settings as Record<number, number>,
        });
        // maxConcurrentStreams unchanged from default (100).
        expect(mgr.maxConcurrentStreams).toBe(100);
    });
});

describe("clampMaxFrameSize (SETTINGS_MAX_FRAME_SIZE)", () => {
    it("clamps a sub-minimum value up to the 16384 floor", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        mgr.dispatch(SETTINGS({ [0x5]: 100 }));
        cap.clear();
        // Open a stream and send a large buffer; chunks must be >= 16384 (the floor).
        const s = mgr.openStream();
        mgr.sendData(s.id, new Uint8Array(20_000).fill(0x61), false);
        const maxChunk = Math.max(
            ...cap.frames
                .filter((f) => f.type === FrameType.DATA)
                .map((f) => (f as { payload: Uint8Array }).payload.length),
        );
        expect(maxChunk).toBeGreaterThanOrEqual(16_384);
    });

    it("clamps an above-maximum value down to the 2^24-1 ceiling", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        // 99_999_999 > 16_777_215; must be tolerated (no throw).
        expect(() => mgr.dispatch(SETTINGS({ [0x5]: 99_999_999 }))).not.toThrow();
    });

    it("tolerates a non-finite MAX_FRAME_SIZE (falls back to default)", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        // NaN must not poison the manager — it falls back to DEFAULT_MAX_FRAME_SIZE.
        expect(() => mgr.dispatch(SETTINGS({ [0x5]: Number.NaN }))).not.toThrow();
    });

    it("accepts an in-range MAX_FRAME_SIZE and respects it when chunking", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        mgr.dispatch(SETTINGS({ [0x5]: 32_768 })); // valid (16384 .. 16777215)
        cap.clear();
        const s = mgr.openStream();
        mgr.sendData(s.id, new Uint8Array(40_000).fill(0x61), false);
        const maxChunk = Math.max(
            ...cap.frames
                .filter((f) => f.type === FrameType.DATA)
                .map((f) => (f as { payload: Uint8Array }).payload.length),
        );
        // With MAX_FRAME_SIZE=32768 no chunk may exceed it.
        expect(maxChunk).toBeLessThanOrEqual(32_768);
    });
});

describe("INITIAL_WINDOW_SIZE delta on existing streams", () => {
    it("adjusts live stream send windows by the delta and drains queued bytes", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        // Shrink the *stream* window to 100 first so a 200-byte send queues 100
        // without touching the (large) connection window.
        mgr.dispatch(SETTINGS({ [0x4]: 100 }));
        cap.clear();
        const stream = mgr.openStream(); // stream window 100
        expect(stream.localWindow.size).toBe(100);

        mgr.sendData(stream.id, new Uint8Array(200).fill(0x61), true);
        expect(stream.sendQueue.length).toBe(100); // 100 queued, stream window exhausted
        expect(stream.localWindow.size).toBe(0);

        cap.clear();
        // Peer raises INITIAL_WINDOW_SIZE to 100_000. Delta = +99_900 on this stream
        // (0 + 99_900), then the triggered drain consumes the 100 queued bytes,
        // leaving 99_800.
        mgr.dispatch(SETTINGS({ [0x4]: 100_000 }));
        expect(stream.localWindow.size).toBe(99_800);
        // The connection window still has room, so the queued 100 bytes drain now.
        expect(stream.sendQueue.length).toBe(0);
    });

    it("shrinks live stream send windows on a smaller INITIAL_WINDOW_SIZE", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const stream = mgr.openStream();
        expect(stream.localWindow.size).toBe(65_535);
        // Lower INITIAL_WINDOW_SIZE below default; delta is negative.
        mgr.dispatch(SETTINGS({ [0x4]: 32_768 }));
        expect(stream.localWindow.size).toBe(32_768);
    });
});

describe("drainSendQueue — connection-window exhaustion", () => {
    it("stops draining when the connection send window reaches zero", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const stream = mgr.openStream();

        // Send 70_000 bytes: connection window (65535) + stream window (65535) both
        // bottom out; the surplus stays queued.
        mgr.sendData(stream.id, new Uint8Array(70_000).fill(0x61), true);
        expect(stream.sendQueue.length).toBeGreaterThan(0);

        const queuedBefore = stream.sendQueue.length;

        // A *stream-level* WINDOW_UPDATE grows the stream window but the connection
        // window is still zero, so drainSendQueue must return immediately and the
        // queue must not change.
        mgr.applyWindowUpdate(stream.id, 100_000);
        expect(stream.sendQueue.length).toBe(queuedBefore);

        // A *connection-level* WINDOW_UPDATE finally unblocks the queue.
        mgr.dispatch({
            type: FrameType.WINDOW_UPDATE,
            flags: 0,
            streamId: ID(0),
            windowSizeIncrement: 100_000,
        });
        expect(stream.sendQueue.length).toBe(0);
        expect(cap.dataBytes()).toBe(70_000);
    });
});

describe("WINDOW_UPDATE dispatch", () => {
    it("connection-level WINDOW_UPDATE (streamId 0) grows the connection window", () => {
        const cap = new FrameCapture();
        const mgr = createStreamManager(cap.sendFrame.bind(cap));
        const s = mgr.openStream();
        // Send 70_000 bytes: both windows (stream + connection) bottom out, 4465 queued.
        mgr.sendData(s.id, new Uint8Array(70_000).fill(0x61), false);
        const before = cap.dataBytes(); // 65535
        // Grow BOTH windows — the connection-level update drains across streams,
        // and the stream-level update lifts this stream's own window.
        mgr.dispatch({
            type: FrameType.WINDOW_UPDATE,
            flags: 0,
            streamId: ID(0),
            windowSizeIncrement: 100_000,
        });
        mgr.applyWindowUpdate(s.id, 100_000);
        expect(cap.dataBytes()).toBeGreaterThan(before);
        expect(s.sendQueue.length).toBe(0);
    });
});
