# @browsercore/http2


[![npm version](https://img.shields.io/npm/v/@browsercore/http2)](https://www.npmjs.com/package/@browsercore/http2)
[![coverage](https://img.shields.io/endpoint?url=https://jverneuer.github.io/browsercore-http2/badge.json)](https://github.com/jverneuer/browsercore-http2/blob/main/COVERAGE.md)
[![lint](https://img.shields.io/github/actions/workflow/status/jverneuer/browsercore-http2/ci.yml?label=lint)](https://github.com/jverneuer/browsercore-http2/actions/workflows/ci.yml)

HTTP/2 framing over any duplex byte stream.

## Responsibility

Frame parsing/serialization, HPACK header compression, stream lifecycle
management, flow control (connection + stream level), SETTINGS exchange,
GOAWAY graceful shutdown, PING, and PUSH_PROMISE handling. The package knows
nothing about the underlying transport — it could be plain TCP, TLS, a pipe, or
a test double.

## What it does NOT know about

- TLS / ALPN
- TCP, DNS, or sockets
- HTTP/1.1
- Browser fingerprints

## Public API

```ts
import { connectHttp2, GoawayReceivedError } from "@browsercore/http2";

const conn = await connectHttp2({
    transport,
    events,
    initialSettings: { ENABLE_PUSH: 0 },
});

const res = await conn.request({
    method: "GET",
    scheme: "https",
    authority: "example.com",
    path: "/index.html",
    headers: new Map([["accept", "text/html"]]),
    body: undefined,
});

console.log(res.statusCode, res.body);
await conn.ping();
await conn.close();
```

## Types

| Export | Kind | Purpose |
| --- | --- | --- |
| `Http2Connection` | interface | Public contract higher layers depend on |
| `connectHttp2()` | function | Wrap a transport with HTTP/2 |
| `Frame` | discriminated union | Every HTTP/2 frame variant |
| `FrameType` | const object | RFC 7540 frame type ids |
| `StreamState` | discriminated union | RFC 7540 §5.1 states |
| `FlowControlWindow` | interface | Per-stream/connection send window |
| `Http2Error` | class | Base typed error |
| `GoawayReceivedError` | class | Peer sent GOAWAY |
| `RstStreamError` | class | Peer reset a stream |
| `FlowControlError` | class | Send exceeded window |
| `FrameParseError` | class | Malformed frame |
| `SettingsAckTimeoutError` | class | SETTINGS ACK timed out |
| `HpackEncoderOptions` | interface | HPACK encoder config (table size, Huffman toggle) |
| `EncodeHeadersOptions` | interface | `encodeHeaders()` options (indexing, Huffman, table size) |
| `PriorityFrameSpec` | interface | PRIORITY frame spec for preface sequencing |
| `generateHttp2GreaseValue()` | function | RFC 8701 GREASE value generator (0x?a?a pattern) |

## Browser impersonation

`connectHttp2()` accepts impersonation options that control every ordering
vector in the HTTP/2 wire fingerprint:

```ts
await connectHttp2({
    transport,
    crypto,
    // SETTINGS frame: explicit id order + optional GREASE
    settingsOrder: [0x1, 0x3, 0x4, 0x5, 0x6],
    settingsGrease: true,
    // Connection-level WINDOW_UPDATE (Chrome sends one early)
    connectionWindowUpdate: 1_572_864,
    // PRIORITY frames for dependency tree setup
    priorityFrames: [
        { streamId: ID(3), streamDependency: ID(0), exclusive: false, weight: 255 },
    ],
    // Pseudo-header order in request HEADERS frames
    pseudoHeaderOrder: [":method", ":authority", ":scheme", ":path"],
    // Regular header order in request HEADERS frames
    headerOrder: ["cookie", "accept", "user-agent"],
    // HPACK encoder configuration
    hpackMaxTableSize: 4096,
    hpackHuffman: true,
    hpackIndexing: false,
});
```

## Dependency graph

```
@browsercore/http2
  ├─ @browsercore/transport
  │     └─ node:net / node:dns / node:crypto
  └─ @browsercore/contracts
```

`@browsercore/contracts` supplies the `EventProvider` interface the package
implements (injected, never imported from a concrete `node:events` backend).
No other `@browsercore/*` packages are imported.

## Position in BrowserCore

```
Application
      │
   @browsercore/http2
      │
   @browsercore/tls
      │
@browsercore/transport
      │
     TCP
```

Every higher networking layer communicates with the network exclusively through the layers below it.
