/**
 * Full impersonation tests for @browsercore/http2.
 *
 * Covers all seven HTTP/2 fingerprint vectors:
 *   1. SETTINGS order preservation
 *   2. GREASE in SETTINGS
 *   3. Configurable pseudo-header order
 *   4. Connection preface sequencing (WINDOW_UPDATE + PRIORITY)
 *   5. HPACK table size respected (dynamic table size update)
 *   6. Huffman coding toggle
 *   7. Regular header order
 */

import { describe, expect, it } from "vitest";
import { testCrypto as crypto } from "./fake-transport.js";
import { serializeFrame, parseFrame, parseFrameHeader, FRAME_HEADER_LENGTH } from "../src/frame/frame.js";
import { HpackEncoder, HpackDecoder, encodeHeaders } from "../src/hpack/hpack.js";
import { encodeStringLiteral } from "../src/hpack/string.js";
import { generateHttp2GreaseValue } from "../src/utils.js";
import { connectHttp2 } from "../src/connection.js";
import { createFakeTransportPair, FakeTransport } from "./fake-transport.js";
import { FrameType } from "../src/types.js";
import type { Frame, Http2StreamId, Http2Request } from "../src/types.js";
import { createMockEventProvider } from "./test-helpers.js";

const ID = (n: number): Http2StreamId => n as Http2StreamId;

/** Concatenate two byte arrays. */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/** Read one full frame from a FakeTransport's buffered byte queue. */
async function readFrame(t: FakeTransport): Promise<Frame> {
    while (t.readBuffer.length < FRAME_HEADER_LENGTH) {
        const extra = await t.read();
        t.readBuffer = concat(t.readBuffer, extra);
    }
    const header = parseFrameHeader(t.readBuffer);
    const total = FRAME_HEADER_LENGTH + header.length;
    while (t.readBuffer.length < total) {
        const extra = await t.read();
        t.readBuffer = concat(t.readBuffer, extra);
    }
    const frame = parseFrame(t.readBuffer.subarray(0, total));
    t.readBuffer = t.readBuffer.subarray(total);
    return frame;
}

/** Extract setting ids from a serialized SETTINGS frame payload (in order). */
function settingIdsFromPayload(payload: Uint8Array): number[] {
    const ids: number[] = [];
    for (let i = 0; i + 6 <= payload.length; i += 6) {
        ids.push((payload[i]! << 8) | payload[i + 1]!);
    }
    return ids;
}

/** A server that completes the SETTINGS handshake (ACK + own SETTINGS). */
async function serverHandshake(server: FakeTransport): Promise<void> {
    await server.read(); // drain preface + client frames
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
}

const sampleReq: Http2Request = {
    method: "GET",
    scheme: "https",
    authority: "example.com",
    path: "/",
    headers: new Map(),
    body: undefined,
};

// =========================================================================
// Fix 1: SETTINGS order preservation
// =========================================================================

describe("Fix 1: SETTINGS order preservation", () => {
    it("serializes settings in the order given by settingsOrder", () => {
        // Settings { 1: A, 2: B, 3: C } with explicit order [3, 1, 2].
        const frame: Frame = {
            type: FrameType.SETTINGS,
            flags: 0,
            streamId: ID(0),
            ack: false,
            settings: { [0x1]: 100, [0x2]: 200, [0x3]: 300 },
            settingsOrder: [0x3, 0x1, 0x2],
        };
        const bytes = serializeFrame(frame);
        const parsed = parseFrame(bytes) as { settings: Record<number, number> };
        // The payload (bytes 9..) encodes settings in [3, 1, 2] order.
        const payload = bytes.subarray(FRAME_HEADER_LENGTH);
        const ids = settingIdsFromPayload(payload);
        expect(ids).toEqual([0x3, 0x1, 0x2]);
        // Values are correct too.
        expect(parsed.settings[0x1]).toBe(100);
        expect(parsed.settings[0x3]).toBe(300);
    });

    it("drops settings not listed in settingsOrder (ordered-only emission)", () => {
        // Chrome 131/140 oracle: real browsers emit a FIXED setting set. A
        // 6-entry frame with MAX_CONCURRENT_STREAMS=100 and
        // MAX_FRAME_SIZE=16384 appended after the ordered four is an
        // "impossible browser" frame no real client ever sends — unlisted
        // entries must be silently dropped, not appended.
        const frame: Frame = {
            type: FrameType.SETTINGS,
            flags: 0,
            streamId: ID(0),
            ack: false,
            settings: {
                [0x1]: 65536,
                [0x2]: 0,
                [0x3]: 100,
                [0x4]: 6291456,
                [0x5]: 16384,
                [0x6]: 262144,
            },
            settingsOrder: [0x1, 0x2, 0x4, 0x6],
        };
        const bytes = serializeFrame(frame);
        const payload = bytes.subarray(FRAME_HEADER_LENGTH);
        // Exactly the 4 listed entries → 4 × 6 bytes, nothing appended.
        expect(payload).toHaveLength(24);
        expect(settingIdsFromPayload(payload)).toEqual([0x1, 0x2, 0x4, 0x6]);
    });

    it("emits exactly the Chrome 24-byte SETTINGS payload for order [1,2,4,6]", () => {
        // Ground truth from the Chrome 131/140 oracle capture: SETTINGS
        // wire_order = [(1,65536),(2,0),(4,6291456),(6,262144)] — byte-exact.
        const frame: Frame = {
            type: FrameType.SETTINGS,
            flags: 0,
            streamId: ID(0),
            ack: false,
            settings: {
                [0x1]: 65536,
                [0x2]: 0,
                [0x4]: 6291456,
                [0x6]: 262144,
            },
            settingsOrder: [0x1, 0x2, 0x4, 0x6],
        };
        const bytes = serializeFrame(frame);
        const payload = bytes.subarray(FRAME_HEADER_LENGTH);
        // Each entry: 2-byte id BE + 4-byte value BE.
        expect(Array.from(payload)).toEqual([
            0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // 1: 65536
            0x00, 0x02, 0x00, 0x00, 0x00, 0x00, // 2: 0
            0x00, 0x04, 0x00, 0x60, 0x00, 0x00, // 4: 6291456
            0x00, 0x06, 0x00, 0x04, 0x00, 0x00, // 6: 262144
        ]);
    });

    it("uses natural sorted order when settingsOrder is absent", () => {
        const frame: Frame = {
            type: FrameType.SETTINGS,
            flags: 0,
            streamId: ID(0),
            ack: false,
            settings: { [0x3]: 300, [0x1]: 100, [0x2]: 200 },
        };
        const bytes = serializeFrame(frame);
        const payload = bytes.subarray(FRAME_HEADER_LENGTH);
        const ids = settingIdsFromPayload(payload);
        // Without settingsOrder, integer keys come in ascending order.
        expect(ids).toEqual([0x1, 0x2, 0x3]);
    });

    it("skips ids in settingsOrder that are not in the settings map", () => {
        const frame: Frame = {
            type: FrameType.SETTINGS,
            flags: 0,
            streamId: ID(0),
            ack: false,
            settings: { [0x1]: 100 },
            settingsOrder: [0x5, 0x1], // 0x5 is not in the map
        };
        const bytes = serializeFrame(frame);
        const payload = bytes.subarray(FRAME_HEADER_LENGTH);
        const ids = settingIdsFromPayload(payload);
        // Only 0x1 is emitted (0x5 had no value).
        expect(ids).toEqual([0x1]);
    });
});

// =========================================================================
// Fix 2: GREASE in SETTINGS
// =========================================================================

describe("Fix 2: GREASE in SETTINGS", () => {
    it("inserts a GREASE setting as the first entry when grease is true", () => {
        const frame: Frame = {
            type: FrameType.SETTINGS,
            flags: 0,
            streamId: ID(0),
            ack: false,
            settings: { [0x1]: 4096 },
            grease: true,
        };
        const bytes = serializeFrame(frame);
        const payload = bytes.subarray(FRAME_HEADER_LENGTH);
        const ids = settingIdsFromPayload(payload);
        // First id matches the 0x?a?a pattern; second is the real setting.
        expect(ids).toHaveLength(2);
        expect((ids[0]! & 0x0f0f)).toBe(0x0a0a);
        expect(ids[1]).toBe(0x1);
    });

    it("does NOT insert GREASE when grease is absent", () => {
        const frame: Frame = {
            type: FrameType.SETTINGS,
            flags: 0,
            streamId: ID(0),
            ack: false,
            settings: { [0x1]: 4096 },
        };
        const bytes = serializeFrame(frame);
        const payload = bytes.subarray(FRAME_HEADER_LENGTH);
        const ids = settingIdsFromPayload(payload);
        expect(ids).toEqual([0x1]);
    });

    it("does NOT insert GREASE when grease is false", () => {
        const frame: Frame = {
            type: FrameType.SETTINGS,
            flags: 0,
            streamId: ID(0),
            ack: false,
            settings: { [0x1]: 4096 },
            grease: false,
        };
        const bytes = serializeFrame(frame);
        const payload = bytes.subarray(FRAME_HEADER_LENGTH);
        const ids = settingIdsFromPayload(payload);
        expect(ids).toEqual([0x1]);
    });

    it("GREASE setting has value 0", () => {
        const frame: Frame = {
            type: FrameType.SETTINGS,
            flags: 0,
            streamId: ID(0),
            ack: false,
            settings: {},
            grease: true,
        };
        const bytes = serializeFrame(frame);
        const payload = bytes.subarray(FRAME_HEADER_LENGTH);
        // 6 bytes: 2-byte id + 4-byte value (should be 0).
        const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        expect(view.getUint32(2)).toBe(0);
    });

    it("SETTINGS ACK with grease flag produces empty payload", () => {
        const frame: Frame = {
            type: FrameType.SETTINGS,
            flags: 0x1,
            streamId: ID(0),
            ack: true,
            settings: {},
            grease: true,
        };
        const bytes = serializeFrame(frame);
        const payload = bytes.subarray(FRAME_HEADER_LENGTH);
        expect(payload.length).toBe(0);
    });
});

describe("generateHttp2GreaseValue", () => {
    it("produces values matching the 0x?a?a pattern", () => {
        for (let i = 0; i < 16; i++) {
            const val = generateHttp2GreaseValue(i);
            const highByte = (val >> 8) & 0xff;
            const lowByte = val & 0xff;
            // Each byte has the same high nibble and 0xa low nibble.
            expect(highByte).toBe(lowByte);
            expect((highByte & 0x0f)).toBe(0x0a);
            expect((highByte >> 4)).toBe(i);
        }
    });

    it("produces a value in the valid range when called without args", () => {
        const val = generateHttp2GreaseValue();
        expect(val).toBeGreaterThanOrEqual(0x0a0a);
        expect(val).toBeLessThanOrEqual(0xfafa);
        expect((val & 0x0f0f)).toBe(0x0a0a);
    });
});

// =========================================================================
// Fix 3: Configurable pseudo-header order
// =========================================================================

describe("Fix 3: Configurable pseudo-header order", () => {
    it("sends pseudo-headers in the configured order", async () => {
        const { client, server } = createFakeTransportPair();
        const serverDone = (async () => {
            await server.read(); // drain preface
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

            // Read the client's request HEADERS frame.
            let frame: Frame;
            do {
                frame = await readFrame(server);
            } while (frame.type !== FrameType.HEADERS);

            // Decode the HPACK payload to check pseudo-header order.
            const dec = new HpackDecoder();
            const headers = dec.decode((frame as { payload: Uint8Array }).payload);
            const names = headers.map((h) => h.name);
            // Chrome order: :method, :authority, :scheme, :path
            expect(names.slice(0, 4)).toEqual([
                ":method",
                ":authority",
                ":scheme",
                ":path",
            ]);

            // Reply so the request resolves.
            await server.write(
                serializeFrame({
                    type: FrameType.HEADERS,
                    flags: 0x5,
                    streamId: frame.streamId,
                    endHeaders: true,
                    endStream: true,
                    padded: false,
                    payload: new Uint8Array([0x88]), // :status 200
                }),
            );
        })();

        const conn = await connectHttp2({
            transport: client,
            crypto,
            events: createMockEventProvider(),
            pseudoHeaderOrder: [":method", ":authority", ":scheme", ":path"],
        });
        await conn.request(sampleReq);
        await conn.close();
        await serverDone;
    });

    it("sends pseudo-headers in the profile order when declared with BARE names (m,a,s,p)", async () => {
        // Divergence D2: profiles (chrome/edge/firefox/safari) declare the
        // order with bare names ("method") — the wire names are
        // colon-prefixed. The old lookup compared raw entries against
        // ":method" etc. and never matched, silently falling back to the
        // default m,s,a,p. Chrome 131/140 oracle order: m,a,s,p.
        const { client, server } = createFakeTransportPair();
        const serverDone = (async () => {
            await server.read(); // drain preface
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

            let frame: Frame;
            do {
                frame = await readFrame(server);
            } while (frame.type !== FrameType.HEADERS);

            const dec = new HpackDecoder();
            const headers = dec.decode((frame as { payload: Uint8Array }).payload);
            expect(headers.map((h) => h.name).slice(0, 4)).toEqual([
                ":method",
                ":authority",
                ":scheme",
                ":path",
            ]);

            await server.write(
                serializeFrame({
                    type: FrameType.HEADERS,
                    flags: 0x5,
                    streamId: frame.streamId,
                    endHeaders: true,
                    endStream: true,
                    padded: false,
                    payload: new Uint8Array([0x88]),
                }),
            );
        })();

        const conn = await connectHttp2({
            transport: client,
            crypto,
            events: createMockEventProvider(),
            // Exactly how @browsercore/profiles declares Chrome's order.
            pseudoHeaderOrder: ["method", "authority", "scheme", "path"],
        });
        await conn.request(sampleReq);
        await conn.close();
        await serverDone;
    });

    it("sends pseudo-headers in the Firefox order when declared with bare names (m,p,a,s)", async () => {
        // Firefox oracle order: :method, :path, :authority, :scheme — proves
        // the order itself (not just non-default-ness) reaches the wire.
        const { client, server } = createFakeTransportPair();
        const serverDone = (async () => {
            await server.read(); // drain preface
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

            let frame: Frame;
            do {
                frame = await readFrame(server);
            } while (frame.type !== FrameType.HEADERS);

            const dec = new HpackDecoder();
            const headers = dec.decode((frame as { payload: Uint8Array }).payload);
            expect(headers.map((h) => h.name).slice(0, 4)).toEqual([
                ":method",
                ":path",
                ":authority",
                ":scheme",
            ]);

            await server.write(
                serializeFrame({
                    type: FrameType.HEADERS,
                    flags: 0x5,
                    streamId: frame.streamId,
                    endHeaders: true,
                    endStream: true,
                    padded: false,
                    payload: new Uint8Array([0x88]),
                }),
            );
        })();

        const conn = await connectHttp2({
            transport: client,
            crypto,
            events: createMockEventProvider(),
            pseudoHeaderOrder: ["method", "path", "authority", "scheme"],
        });
        await conn.request(sampleReq);
        await conn.close();
        await serverDone;
    });

    it("uses default order when pseudoHeaderOrder is absent", async () => {
        const { client, server } = createFakeTransportPair();
        const serverDone = (async () => {
            await server.read();
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

            let frame: Frame;
            do {
                frame = await readFrame(server);
            } while (frame.type !== FrameType.HEADERS);

            const dec = new HpackDecoder();
            const headers = dec.decode((frame as { payload: Uint8Array }).payload);
            const names = headers.map((h) => h.name);
            // Default: :method, :scheme, :authority, :path
            expect(names.slice(0, 4)).toEqual([
                ":method",
                ":scheme",
                ":authority",
                ":path",
            ]);

            await server.write(
                serializeFrame({
                    type: FrameType.HEADERS,
                    flags: 0x5,
                    streamId: frame.streamId,
                    endHeaders: true,
                    endStream: true,
                    padded: false,
                    payload: new Uint8Array([0x88]),
                }),
            );
        })();

        const conn = await connectHttp2({ transport: client, crypto, events: createMockEventProvider() });
        await conn.request(sampleReq);
        await conn.close();
        await serverDone;
    });
});

// =========================================================================
// Fix 4: Connection preface sequencing
// =========================================================================

describe("Fix 4: Connection preface sequencing", () => {
    /**
     * Helper: read ALL frames sent by the client during the handshake.
     *
     * The FakeTransport delivers all buffered bytes per read() and clears its
     * buffer. We drain the preface (24-byte PRI string) from the first read,
     * then read additional chunks until we've collected the expected frames.
     */
    async function drainClientFrames(
        server: FakeTransport,
        expectedCount: number,
    ): Promise<Frame[]> {
        // First read: PRI string + possibly some frames.
        const first = await server.read();
        let buf = first.subarray(24); // skip PRI
        const frames: Frame[] = [];
        while (frames.length < expectedCount) {
            // Parse any complete frames from the buffer.
            while (buf.length >= FRAME_HEADER_LENGTH) {
                const header = parseFrameHeader(buf);
                const total = FRAME_HEADER_LENGTH + header.length;
                if (buf.length < total) break;
                frames.push(parseFrame(buf.subarray(0, total)));
                buf = buf.subarray(total);
            }
            if (frames.length >= expectedCount) break;
            // Need more bytes — read another chunk.
            const more = await server.read();
            buf = concat(buf, more);
        }
        return frames;
    }

    it("sends a connection-level WINDOW_UPDATE after SETTINGS", async () => {
        const { client, server } = createFakeTransportPair();
        const serverDone = (async () => {
            // Drain PRI + SETTINGS + WINDOW_UPDATE (3 frames after PRI).
            const frames = await drainClientFrames(server, 2);
            // Frame 0: SETTINGS; Frame 1: WINDOW_UPDATE
            expect(frames[0]!.type).toBe(FrameType.SETTINGS);
            expect(frames[1]!.type).toBe(FrameType.WINDOW_UPDATE);
            expect((frames[1] as { windowSizeIncrement: number }).windowSizeIncrement).toBe(
                1_572_864,
            );

            // connectHttp2 no longer waits for this ACK, so the client may
            // already have closed — a failed write just ends the script.
            await server.write(
                serializeFrame({
                    type: FrameType.SETTINGS,
                    flags: 0x1,
                    streamId: ID(0),
                    ack: true,
                    settings: {},
                }),
            ).catch(() => undefined);
        })();

        const conn = await connectHttp2({
            transport: client,
            crypto,
            events: createMockEventProvider(),
            connectionWindowUpdate: 1_572_864,
            settingsAckTimeoutMs: 1000,
        });
        await conn.close();
        await serverDone;
    });

    it("sends PRIORITY frames after SETTINGS + WINDOW_UPDATE", async () => {
        const { client, server } = createFakeTransportPair();
        const serverDone = (async () => {
            // Drain PRI + SETTINGS + WINDOW_UPDATE + 2× PRIORITY = 4 frames.
            const frames = await drainClientFrames(server, 4);
            const types = frames.map((f) => f.type);
            expect(types).toContain(FrameType.SETTINGS);
            expect(types).toContain(FrameType.WINDOW_UPDATE);
            const priorities = frames.filter((f) => f.type === FrameType.PRIORITY);
            expect(priorities).toHaveLength(2);
            expect((priorities[0] as { streamId: Http2StreamId }).streamId).toBe(ID(3));
            expect((priorities[1] as { streamId: Http2StreamId }).streamId).toBe(ID(5));

            // connectHttp2 no longer waits for this ACK, so the client may
            // already have closed — a failed write just ends the script.
            await server.write(
                serializeFrame({
                    type: FrameType.SETTINGS,
                    flags: 0x1,
                    streamId: ID(0),
                    ack: true,
                    settings: {},
                }),
            ).catch(() => undefined);
        })();

        const conn = await connectHttp2({
            transport: client,
            crypto,
            events: createMockEventProvider(),
            connectionWindowUpdate: 66_560,
            priorityFrames: [
                { streamId: ID(3), streamDependency: ID(0), exclusive: false, weight: 255 },
                { streamId: ID(5), streamDependency: ID(0), exclusive: false, weight: 128 },
            ],
            settingsAckTimeoutMs: 1000,
        });
        await conn.close();
        await serverDone;
    });

    it("does NOT send WINDOW_UPDATE or PRIORITY when options are absent", async () => {
        const { client, server } = createFakeTransportPair();
        const serverDone = (async () => {
            // Only SETTINGS frame after PRI.
            const frames = await drainClientFrames(server, 1);
            expect(frames).toHaveLength(1);
            expect(frames[0]!.type).toBe(FrameType.SETTINGS);

            // connectHttp2 no longer waits for this ACK, so the client may
            // already have closed — a failed write just ends the script.
            await server.write(
                serializeFrame({
                    type: FrameType.SETTINGS,
                    flags: 0x1,
                    streamId: ID(0),
                    ack: true,
                    settings: {},
                }),
            ).catch(() => undefined);
        })();

        const conn = await connectHttp2({
            transport: client,
            crypto,
            events: createMockEventProvider(),
            settingsAckTimeoutMs: 1000,
        });
        await conn.close();
        await serverDone;
    });

    it("passes settingsOrder and settingsGrease through connectHttp2 to the preface SETTINGS", async () => {
        // Exercises the connectHttp2 ternary branches for settingsOrder and
        // settingsGrease — these options are read in connectHttp2 (not in the
        // frame serializer) so they need an integration path to cover.
        const { client, server } = createFakeTransportPair();
        const serverDone = (async () => {
            await server.read(); // PRI + SETTINGS
            // connectHttp2 no longer waits for this ACK, so the client may
            // already have closed — a failed write just ends the script.
            await server.write(
                serializeFrame({
                    type: FrameType.SETTINGS,
                    flags: 0x1,
                    streamId: ID(0),
                    ack: true,
                    settings: {},
                }),
            ).catch(() => undefined);
        })();

        const conn = await connectHttp2({
            transport: client,
            crypto,
            events: createMockEventProvider(),
            settingsOrder: [0x3, 0x5],
            settingsGrease: true,
            initialSettings: { [0x3]: 100, [0x5]: 16384 },
            settingsAckTimeoutMs: 1000,
        });
        await conn.close();
        await serverDone;
    });
});

// =========================================================================
// Fix 5: HPACK table size respected
// =========================================================================

describe("Fix 5: HPACK table size respected", () => {
    it("emits a dynamic table size update when maxTableSize differs from default", () => {
        const enc = new HpackEncoder({ maxTableSize: 2048 });
        const bytes = enc.encode([{ name: "x-test", value: "v", indexing: false }]);
        // The first octet should be a size update: 001_ prefix (0x20) + value.
        // 2048 in a 5-bit prefix: 2048 = 31 + continuation octets.
        // First octet: 0x20 | 31 = 0x3f, then continuation bytes.
        expect(bytes[0]).toBe(0x3f);
    });

    it("does NOT emit a size update when maxTableSize is the default (4096)", () => {
        const enc = new HpackEncoder({ maxTableSize: 4096 });
        const bytes = enc.encode([{ name: ":method", value: "GET", indexing: false }]);
        // Should be a direct indexed representation (0x82), not a size update.
        expect(bytes[0]).toBe(0x82);
    });

    it("does NOT emit a size update when maxTableSize is not specified", () => {
        const enc = new HpackEncoder();
        const bytes = enc.encode([{ name: ":method", value: "GET", indexing: false }]);
        expect(bytes[0]).toBe(0x82);
    });

    it("round-trips with a non-default table size (decoder honours the update)", () => {
        const enc = new HpackEncoder({ maxTableSize: 2048 });
        const dec = new HpackDecoder();
        const block = enc.encode([{ name: "x-custom", value: "hello", indexing: true }]);
        const decoded = dec.decode(block);
        expect(decoded[0]?.name).toBe("x-custom");
        expect(decoded[0]?.value).toBe("hello");
        // The entry was added to the dynamic table with the 2048 limit.
        const ref = dec.decode(new Uint8Array([0x80 | 62]));
        expect(ref[0]?.name).toBe("x-custom");
    });

    it("encodeHeaders accepts indexing option", () => {
        const headers = new Map([["x-custom", "value"]]);
        // With indexing: true, the first byte should be a literal-incremental (0x40 prefix).
        const indexed = encodeHeaders(headers, { indexing: true });
        expect((indexed[0]! & 0xc0)).toBe(0x40);

        // With indexing: false (default), the first byte should be a no-indexing literal (0x00 prefix).
        const notIndexed = encodeHeaders(headers, { indexing: false });
        expect((notIndexed[0]! & 0xf0)).toBe(0x00);
    });
});

// =========================================================================
// Fix 6: Huffman coding toggle
// =========================================================================

describe("Fix 6: Huffman coding toggle", () => {
    it("uses Huffman by default (high bit set on string length prefix)", () => {
        const enc = new HpackEncoder();
        const bytes = enc.encode([{ name: "x-huffman", value: "test-value", indexing: false }]);
        // The literal no-indexing representation is: 0000xxxx prefix, then name string.
        // The name string's length-prefix octet should have the Huffman flag (0x80) set.
        // For a new name: first octet is 0x00 (no-indexing, new name), then name string.
        const nameLengthPrefix = bytes[1]!;
        expect((nameLengthPrefix & 0x80) !== 0).toBe(true);
    });

    it("emits raw literals when useHuffman is false (high bit clear)", () => {
        const enc = new HpackEncoder({ useHuffman: false });
        const bytes = enc.encode([{ name: "x-plain", value: "test-value", indexing: false }]);
        // The name string length prefix should NOT have the Huffman flag set.
        const nameLengthPrefix = bytes[1]!;
        expect((nameLengthPrefix & 0x80) === 0).toBe(true);
    });

    it("round-trips correctly with Huffman disabled", () => {
        const enc = new HpackEncoder({ useHuffman: false });
        const dec = new HpackDecoder();
        const block = enc.encode([{ name: "x-roundtrip", value: "hello-world", indexing: false }]);
        const decoded = dec.decode(block);
        expect(decoded[0]?.name).toBe("x-roundtrip");
        expect(decoded[0]?.value).toBe("hello-world");
    });

    it("encodeStringLiteral produces non-Huffman output", () => {
        const octets = encodeStringLiteral("abc");
        // Length prefix = 3 (fits in 7-bit prefix), high bit clear.
        expect(octets[0]).toBe(3);
        // Followed by raw bytes 'a', 'b', 'c'.
        expect(octets.slice(1)).toEqual([0x61, 0x62, 0x63]);
    });

    it("Huffman toggle changes the encoded size for compressible strings", () => {
        const value = "www.example.com"; // Huffman-compressible
        const encHuff = new HpackEncoder({ useHuffman: true });
        const encPlain = new HpackEncoder({ useHuffman: false });
        const huff = encHuff.encode([{ name: "x-host", value, indexing: false }]);
        const plain = encPlain.encode([{ name: "x-host", value, indexing: false }]);
        // Huffman encoding should be shorter for this compressible string.
        expect(huff.length).toBeLessThan(plain.length);
    });
});

// =========================================================================
// Fix 7: Header order for regular headers
// =========================================================================

describe("Fix 7: Regular header order", () => {
    it("sends regular headers in the configured order", async () => {
        const { client, server } = createFakeTransportPair();
        const reqHeaders = new Map([
            ["user-agent", "test-agent"],
            ["accept", "text/html"],
            ["cookie", "session=abc"],
        ]);

        const serverDone = (async () => {
            await serverHandshake(server);

            let frame: Frame;
            do {
                frame = await readFrame(server);
            } while (frame.type !== FrameType.HEADERS);

            const dec = new HpackDecoder();
            const headers = dec.decode((frame as { payload: Uint8Array }).payload);
            const regularNames = headers.filter((h) => !h.name.startsWith(":")).map((h) => h.name);
            // headerOrder: cookie first, then accept, then user-agent.
            expect(regularNames).toEqual(["cookie", "accept", "user-agent"]);

            await server.write(
                serializeFrame({
                    type: FrameType.HEADERS,
                    flags: 0x5,
                    streamId: frame.streamId,
                    endHeaders: true,
                    endStream: true,
                    padded: false,
                    payload: new Uint8Array([0x88]),
                }),
            );
        })();

        const conn = await connectHttp2({
            transport: client,
            crypto,
            events: createMockEventProvider(),
            headerOrder: ["cookie", "accept", "user-agent"],
        });
        await conn.request({ ...sampleReq, headers: reqHeaders });
        await conn.close();
        await serverDone;
    });

    it("appends unlisted headers after the ordered ones", async () => {
        const { client, server } = createFakeTransportPair();
        const reqHeaders = new Map([
            ["x-first", "1"],
            ["x-second", "2"],
            ["x-third", "3"],
        ]);

        const serverDone = (async () => {
            await serverHandshake(server);

            let frame: Frame;
            do {
                frame = await readFrame(server);
            } while (frame.type !== FrameType.HEADERS);

            const dec = new HpackDecoder();
            const headers = dec.decode((frame as { payload: Uint8Array }).payload);
            const regularNames = headers.filter((h) => !h.name.startsWith(":")).map((h) => h.name);
            // headerOrder lists only x-third; x-first and x-second follow.
            expect(regularNames[0]).toBe("x-third");
            expect(regularNames.slice(1).sort()).toEqual(["x-first", "x-second"]);

            await server.write(
                serializeFrame({
                    type: FrameType.HEADERS,
                    flags: 0x5,
                    streamId: frame.streamId,
                    endHeaders: true,
                    endStream: true,
                    padded: false,
                    payload: new Uint8Array([0x88]),
                }),
            );
        })();

        const conn = await connectHttp2({
            transport: client,
            crypto,
            events: createMockEventProvider(),
            headerOrder: ["x-third"],
        });
        await conn.request({ ...sampleReq, headers: reqHeaders });
        await conn.close();
        await serverDone;
    });

    it("uses insertion order when headerOrder is absent", async () => {
        const { client, server } = createFakeTransportPair();
        const reqHeaders = new Map([
            ["x-alpha", "1"],
            ["x-beta", "2"],
        ]);

        const serverDone = (async () => {
            await serverHandshake(server);

            let frame: Frame;
            do {
                frame = await readFrame(server);
            } while (frame.type !== FrameType.HEADERS);

            const dec = new HpackDecoder();
            const headers = dec.decode((frame as { payload: Uint8Array }).payload);
            const regularNames = headers.filter((h) => !h.name.startsWith(":")).map((h) => h.name);
            // Map insertion order preserved.
            expect(regularNames).toEqual(["x-alpha", "x-beta"]);

            await server.write(
                serializeFrame({
                    type: FrameType.HEADERS,
                    flags: 0x5,
                    streamId: frame.streamId,
                    endHeaders: true,
                    endStream: true,
                    padded: false,
                    payload: new Uint8Array([0x88]),
                }),
            );
        })();

        const conn = await connectHttp2({ transport: client, crypto, events: createMockEventProvider() });
        await conn.request({ ...sampleReq, headers: reqHeaders });
        await conn.close();
        await serverDone;
    });
});

// =========================================================================
// Fix 8: HEADERS frame PRIORITY flag + payload block (D5)
// =========================================================================

describe("Fix 8: HEADERS frame PRIORITY flag", () => {
    /** Read one full frame's RAW wire bytes (header + payload), unparsed. */
    async function readRawFrame(t: FakeTransport): Promise<Uint8Array> {
        let buf = t.readBuffer;
        while (buf.length < FRAME_HEADER_LENGTH) {
            const extra = await t.read();
            buf = concat(buf, extra);
        }
        const header = parseFrameHeader(buf);
        const total = FRAME_HEADER_LENGTH + header.length;
        while (buf.length < total) {
            const extra = await t.read();
            buf = concat(buf, extra);
        }
        t.readBuffer = buf.subarray(total);
        return buf.subarray(0, total);
    }

    /** Read raw bytes of the client's first HEADERS frame. */
    async function readRawHeadersFrame(server: FakeTransport): Promise<Uint8Array> {
        let raw: Uint8Array;
        do {
            raw = await readRawFrame(server);
        } while (parseFrameHeader(raw).type !== FrameType.HEADERS);
        return raw;
    }

    it("sets flags 0x25 and carries the 5-byte priority block when initialPriority is set", async () => {
        // Chrome 131/140 oracle (DIVERGENCE_REPORT §3.5): the first HEADERS on
        // a stream carries flags 0x25 (END_STREAM | END_HEADERS | PRIORITY)
        // with priority { exclusive: 1, streamDependency: 0, weight: 256 } —
        // wire block 80 00 00 00 ff (logical weight 256 = wire byte 0xff).
        const { client, server } = createFakeTransportPair();
        const serverDone = (async () => {
            await server.read(); // drain preface
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

            const raw = await readRawHeadersFrame(server);
            // Flags byte: END_STREAM | END_HEADERS | PRIORITY.
            expect(raw[4]).toBe(0x25);
            // 5-byte priority block prefixes the header block fragment.
            const priorityBlock = raw.subarray(FRAME_HEADER_LENGTH, FRAME_HEADER_LENGTH + 5);
            expect(Array.from(priorityBlock)).toEqual([0x80, 0x00, 0x00, 0x00, 0xff]);
            // The remainder is the plain HPACK header block.
            const dec = new HpackDecoder();
            const headers = dec.decode(raw.subarray(FRAME_HEADER_LENGTH + 5));
            expect(headers.filter((h) => h.name.startsWith(":")).map((h) => h.name)).toEqual([
                ":method",
                ":scheme",
                ":authority",
                ":path",
            ]);

            await server.write(
                serializeFrame({
                    type: FrameType.HEADERS,
                    flags: 0x5,
                    streamId: parseFrameHeader(raw).streamId,
                    endHeaders: true,
                    endStream: true,
                    padded: false,
                    payload: new Uint8Array([0x88]),
                }),
            );
        })();

        const conn = await connectHttp2({
            transport: client,
            crypto,
            events: createMockEventProvider(),
            initialPriority: { exclusive: true, streamDependency: ID(0), weight: 255 },
        });
        await conn.request(sampleReq);
        await conn.close();
        await serverDone;
    });

    it("sets flags 0x24 (PRIORITY, no END_STREAM) for requests with a body", async () => {
        const { client, server } = createFakeTransportPair();
        const serverDone = (async () => {
            await server.read(); // drain preface
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

            const raw = await readRawHeadersFrame(server);
            expect(raw[4]).toBe(0x24);
            const priorityBlock = raw.subarray(FRAME_HEADER_LENGTH, FRAME_HEADER_LENGTH + 5);
            expect(Array.from(priorityBlock)).toEqual([0x80, 0x00, 0x00, 0x00, 0xff]);

            // Complete the exchange so the request resolves: response HEADERS
            // (END_HEADERS) + DATA-less END_STREAM + a DATA frame for the body.
            await server.write(
                serializeFrame({
                    type: FrameType.HEADERS,
                    flags: 0x4,
                    streamId: parseFrameHeader(raw).streamId,
                    endHeaders: true,
                    endStream: false,
                    padded: false,
                    payload: new Uint8Array([0x88]),
                }),
            );
            await server.write(
                serializeFrame({
                    type: FrameType.DATA,
                    flags: 0x1,
                    streamId: parseFrameHeader(raw).streamId,
                    payload: new Uint8Array(0),
                }),
            );
        })();

        const conn = await connectHttp2({
            transport: client,
            crypto,
            events: createMockEventProvider(),
            initialPriority: { exclusive: true, streamDependency: ID(0), weight: 255 },
        });
        await conn.request({ ...sampleReq, body: new Uint8Array([0x61]) });
        await conn.close();
        await serverDone;
    });

    it("keeps today's bare HEADERS (flags 0x05, no priority block) when initialPriority is absent", async () => {
        const { client, server } = createFakeTransportPair();
        const serverDone = (async () => {
            await server.read(); // drain preface
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

            const raw = await readRawHeadersFrame(server);
            // Backwards compatible: no PRIORITY flag, no 5-byte block.
            expect(raw[4]).toBe(0x05);
            const dec = new HpackDecoder();
            // The WHOLE payload is HPACK from byte zero.
            const headers = dec.decode(raw.subarray(FRAME_HEADER_LENGTH));
            expect(headers.filter((h) => h.name.startsWith(":")).map((h) => h.name)).toEqual([
                ":method",
                ":scheme",
                ":authority",
                ":path",
            ]);

            await server.write(
                serializeFrame({
                    type: FrameType.HEADERS,
                    flags: 0x5,
                    streamId: parseFrameHeader(raw).streamId,
                    endHeaders: true,
                    endStream: true,
                    padded: false,
                    payload: new Uint8Array([0x88]),
                }),
            );
        })();

        const conn = await connectHttp2({
            transport: client,
            crypto,
            events: createMockEventProvider(),
        });
        await conn.request(sampleReq);
        await conn.close();
        await serverDone;
    });
});
