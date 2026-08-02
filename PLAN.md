# @browsercore/http2 — Implementation Plan

HTTP/2 framing over any duplex byte stream. Implement in this order; each step
is independently testable.

## Step 1 — Frame header parse/serialize (DONE)

`serializeFrame()` for the header + `parseFrameHeader()` are implemented and
tested. The 9-byte header (length, type, flags, stream id) round-trips.

Tests: serialize + parse a header; assert fields match.

## Step 2 — Full frame parse/serialize for each type

Implement `parseFrame()` body dispatch for every `FrameType` variant. Each
frame type has its own wire encoding per RFC 7540 §6.

Tests: round-trip each frame type through `serializeFrame()` + `parseFrame()`.

## Step 3 — HPACK static table + encode/decode

Implement `HpackEncoder` and `HpackDecoder` against the static table (RFC 7541
Appendix A). Support literal header fields with and without indexing.

Tests: encode a header block; decode it back; assert the round trip is exact.

## Step 4 — HPACK dynamic table

Add the dynamic table: track entries, evict when size exceeds the peer's
`SETTINGS_HEADER_TABLE_SIZE`, and honor `DYNAMIC_TABLE_SIZE_UPDATE`.

Tests: fill the dynamic table past its limit; assert the oldest entry is
evicted. Decode a reference to a dynamic-table entry.

## Step 5 — Stream state machine

Implement `createStreamManager()` and the `StreamState` transitions per RFC
7540 §5.1. Map frame types to state changes (e.g., HEADERS opens a stream,
END_STREAM half-closes, RST_STREAM closes).

Tests: drive a stream through every valid transition; assert invalid
transitions raise an error.

## Step 6 — Flow control (connection + stream level)

Track connection-level and stream-level send/receive windows. Refuse sends
that exceed the window; emit `WINDOW_UPDATE` frames as the consumer drains.

Tests: send up to the window limit — send blocks. Receive a `WINDOW_UPDATE` —
send unblocks. Exceeding the window raises `FlowControlError`.

## Step 7 — Settings exchange + ACK

Implement the connection preface: send client connection preface string + a
SETTINGS frame, await the peer's SETTINGS + SETTINGS ACK. Apply the peer's
settings locally. Timeout with `SettingsAckTimeoutError`.

Tests: a mock peer that replies with SETTINGS + ACK completes the handshake.
A peer that never ACKs fires `SettingsAckTimeoutError`.

## Step 8 — Multiplexing (concurrent streams)

`Http2Connection.request()` opens an odd-numbered stream, sends HEADERS +
DATA, and resolves when the response's END_STREAM arrives. Multiple requests
run concurrently; responses are correlated by stream id.

Tests: fire 5 concurrent requests; assert all 5 resolve with the right body.

## Step 9 — GOAWAY + graceful shutdown

Implement `goaway()`: send GOAWAY, stop opening new streams, let in-flight
streams drain, then close. Handle inbound GOAWAY from the peer by raising
`GoawayReceivedError`.

Tests: sending GOAWAY stops new requests. Receiving GOAWAY raises
`GoawayReceivedError` with the last stream id.

## Step 10 — PING

Implement `ping()`: send a PING frame, await the PING ACK with matching opaque
data. Used for liveness checks and RTT estimation.

Tests: ping returns the same opaque data the peer echoed back.

## Step 11 — PUSH_PROMISE (server push handling)

Decode inbound PUSH_PROMISE frames, open the reserved stream, and expose the
pushed response to the caller. This package does NOT initiate push — it only
handles push from the peer.

Tests: a mock PUSH_PROMISE frame opens a reserved stream; HEADERS + DATA on
the promised stream resolve a pushed response.

## Step 12 — Priority

Honor PRIORITY frames and HEADERS priority fields to schedule DATA sends.
This is best-effort — the wire encoding must be correct, but scheduling
policy can start simple (FIFO).

Tests: serialize/deserialize PRIORITY frames; assert fields round-trip.

## Definition of done

- [ ] Every frame type parses and serializes correctly.
- [ ] HPACK static + dynamic tables encode/decode round-trip.
- [ ] Stream state machine covers every RFC 7540 §5.1 transition.
- [ ] Flow control blocks sends that exceeds the window.
- [ ] SETTINGS exchange completes with ACK (or times out with a typed error).
- [ ] Multiple requests multiplex concurrently over one connection.
- [ ] GOAWAY is sent on shutdown and received as a typed error.
- [ ] PING round-trips opaque data.
- [ ] PUSH_PROMISE is handled (server push).
- [ ] PRIORITY frames round-trip.
- [ ] Every test in `tests/` passes; `tsc --build` is clean.
