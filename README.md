# @browsercore/http2

[![npm version](https://img.shields.io/npm/v/@browsercore/http2)](https://www.npmjs.com/package/@browsercore/http2)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/jverneuer/browsercore-http2/main/coverage/badge.json)](https://github.com/jverneuer/browsercore-http2/blob/main/COVERAGE.md)
[![lint](https://img.shields.io/github/actions/workflow/status/jverneuer/browsercore-http2/ci.yml?label=lint)](https://github.com/jverneuer/browsercore-http2/actions/workflows/ci.yml)

HTTP/2 framing over any duplex byte stream. No knowledge of TLS or TCP — only HPACK + framing.

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

const conn = await connectHttp2({ transport, initialSettings: { ENABLE_PUSH: 0 } });

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

## Types & exports

| Export | Kind | Purpose |
| --- | --- | --- |
| `connectHttp2()` | function | Wrap a transport with HTTP/2 |
| `Http2Connection` | interface | Public contract higher layers depend on |
| `Http2ConnectionImpl` | class | Concrete connection (also exported for tests) |
| `Http2Options` | interface | Options for `connectHttp2()` |
| `Http2Request` / `Http2Response` | interfaces | Request/response shapes |
| `Http2StreamId` | branded type | Opaque 31-bit stream identifier |
| `Frame` | discriminated union | Every HTTP/2 frame variant |
| `FrameType` | const object | RFC 7540 frame type ids |
| `Http2Settings` | const object | RFC 7540 SETTINGS identifiers |
| `StreamState` | discriminated union | RFC 7540 §5.1 states |
| `StreamCloseReason` | discriminated union | Why a stream entered `closed` |
| `FlowControlWindow` | interface | Per-stream/connection send window |
| `HpackEncoder` / `HpackDecoder` | classes | HPACK codec (RFC 7541) |
| `encodeHeaders()` / `decodeHeaders()` | functions | Convenience wrappers over the HPACK codec |
| `HeaderField` / `HeaderBlock` | types | HPACK header field shapes |
| `parseFrame()` / `serializeFrame()` | functions | Wire-level frame (de)composition |
| `parseFrameHeader()` | function | Decode a 9-byte frame header |
| `FRAME_HEADER_LENGTH` | const | `9` — size of an HTTP/2 frame header |
| `DEFAULT_MAX_FRAME_SIZE` | const | `16384` — default max frame size |
| `createStreamManager()` | function | Construct a stream manager (for tests) |
| `Http2Stream` / `StreamManager` | types | Stream and stream-manager contracts |
| `assertNever()` | function | Exhaustiveness checker |

### Error classes

Every failure mode is an explicit typed error. Match on the `kind` discriminator
rather than parsing messages.

| Error | `kind` | Meaning |
| --- | --- | --- |
| `Http2Error` | `"Http2Error"` | Base class for all HTTP/2 errors |
| `GoawayReceivedError` | `"GoawayReceivedError"` | Peer sent GOAWAY (`lastStreamId`, `errorCode`, `debugData`) |
| `RstStreamError` | `"RstStreamError"` | Peer reset a stream (`streamId`, `errorCode`) |
| `FlowControlError` | `"FlowControlError"` | Send exceeded the stream/connection window |
| `FrameParseError` | `"FrameParseError"` | Malformed frame at a given `offset` |
| `SettingsAckTimeoutError` | `"SettingsAckTimeoutError"` | SETTINGS ACK not received in time |

## Dependency graph

```
@browsercore/http2
  ├─ @browsercore/transport — reliable ordered byte stream (TCP)
  │    └─ node:net / node:dns / node:events
  └─ @browsercore/crypto     — randomness + hashing for connection IDs + PING
       └─ node:crypto
```

No other `@browsercore/*` packages are imported.

## Source layout

```
src/
├─ index.ts          Public API surface — everything higher layers import
├─ connection.ts     Http2ConnectionImpl, connectHttp2()
├─ errors.ts         Typed error hierarchy (Http2Error and subclasses)
├─ types.ts          Frame, StreamState, Http2Settings, branded ids
├─ utils.ts          assertNever(), id generator
├─ frame/            parseFrame / serializeFrame / frame header
├─ hpack/            HPACK encoder + decoder (RFC 7541)
│   ├─ encoder.ts / decoder.ts
│   ├─ dynamic-table.ts / static-table.ts / huffman-table.ts
│   ├─ integer.ts / string.ts
│   └─ helpers.ts    encodeHeaders / decodeHeaders
└─ stream/           Stream state machine + flow control
```

## Development

Requires **Node >= 26**. ESM only (`"type": "module"`).

```sh
npm install      # installs @browsercore/dev (file:../dev) + siblings
npm run build    # tsc -p tsconfig.build.json (emit to dist/)
npm run typecheck
npm run lint     # oxlint --type-aware src/
npm test         # vitest run
```

Run a single test file:

```sh
npx vitest run tests/connection.test.ts
```

Run tests by name pattern:

```sh
npx vitest run -t "rejects a non-browser User-Agent"
```

Generate a coverage report:

```sh
npm test -- --coverage
node ../dev/bin/coverage-md.mjs   # writes COVERAGE.md + coverage/badge.json
```

### Shared config

This package adopts `@browsercore/dev`, the shared config package for the
`@browsercore/*` family. Configuration is centralized — this repo only wires it in:

| Concern | Mechanism |
| --- | --- |
| TypeScript strict flags | `tsconfig.json` extends `@browsercore/dev/tsconfig.base.json` |
| Vitest config | `vitest.config.ts` calls `definePackageConfig({ name: "@browsercore/http2" })` |
| Oxlint config | `oxlint.config.ts` extends `@browsercore/dev/oxlint` |
| Coverage report | `coverage-md` bin from `@browsercore/dev` |

`@browsercore/dev` is declared as a devDependency via `"@browsercore/dev": "file:../dev"`.

## License

MIT
