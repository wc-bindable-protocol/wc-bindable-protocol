# @wc-bindable/hawc-s3

`@wc-bindable/hawc-s3` is a headless **S3 (and S3-compatible) blob store** component built on wc-bindable-protocol.

It is not a visual UI widget.
It is an **I/O node** that connects an upload pipeline to reactive state — with first-class progress, multipart, retry, and post-process hooks.

- **input / command surface**: `file`, `trigger`, `bucket`, `prefix`, `key`, `content-type`
- **output state surface**: `url`, `etag`, `progress`, `loading`, `uploading`, `completed`, `metadata`, `error`

`@wc-bindable/hawc-s3` follows the [HAWC](https://github.com/wc-bindable-protocol/wc-bindable-protocol/blob/main/docs/articles/HAWC.md) architecture:

- **Core** (`S3Core`) lives server-side. Owns AWS credentials, signs URLs, runs post-process hooks.
- **Shell** (`<hawc-s3>`) lives in the browser. Picks the file, PUTs **directly to S3**, reports progress.
- **Bytes never traverse the WebSocket** — only signing requests, progress, and completion notifications do.
- frameworks and binding systems consume it through [wc-bindable-protocol](https://github.com/wc-bindable-protocol/wc-bindable-protocol)

**No AWS SDK required.** SigV4 presigning is implemented with the Web Crypto API. The only runtime dependencies are `@wc-bindable/core` and `@wc-bindable/remote`.

## Why this exists

Building a "user uploads a file to S3" feature normally requires:
a server endpoint that mints presigned URLs, browser-side `XMLHttpRequest` with progress events,
multipart orchestration for large files, retry logic, abort handling, and a callback path
back to the server when the upload finishes (DB insert, virus scan, thumbnailer, ...).

`@wc-bindable/hawc-s3` moves all of that behind two custom elements and a server-side `S3Core`,
exposing the result as bindable state.

## Architecture

```
[Browser]  <hawc-s3>  ─WS─►  S3Core  ──presigned PUT──►  AWS S3
                              │
                              └─►  registerPostProcess hook  (DB / scan / thumbnail)
```

| Operation | Where it runs |
|---|---|
| Single PUT | Browser — direct to S3 |
| Multipart Initiate / Complete / Abort | Server (Provider issues a presigned POST/DELETE and fetches it) |
| Per-part PUT | Browser — direct to S3, parallel up to `multipart-concurrency` |
| Post-process (DB / scan / thumbnail) | Server (`core.registerPostProcess(fn)`) |
| Browser-side callbacks (UI updates) | Browser (`<hawc-s3-callback>`) |

## Install

```bash
npm install @wc-bindable/hawc-s3
```

No peer dependencies required.

## Quick Start

### 1. Server (Node)

Use the `/server` subpath — the default barrel pulls in the browser custom
elements (`HTMLElement`-based) and is not safe to load from Node.

```ts
import { WebSocketServer } from "ws";
import { RemoteShellProxy } from "@wc-bindable/remote";
import { S3Core, AwsS3Provider } from "@wc-bindable/hawc-s3/server";

const provider = new AwsS3Provider(); // reads AWS_* env vars

const wss = new WebSocketServer({ port: 8080 });
wss.on("connection", (ws) => {
  const core = new S3Core(provider);
  core.bucket = "my-uploads";
  core.prefix = "user/123/";

  // Server-side post-process hook (DB / scan / thumbnail / ...).
  core.registerPostProcess(async ({ key, etag, size }) => {
    await db.insertAsset({ key, etag, size });
  });

  // Adapter elided — see the ws ⇆ ServerTransport sample in examples/s3-remote/.
  new RemoteShellProxy(core, makeTransport(ws));

  // REQUIRED: clean up when the WS drops mid-upload. Without this, an
  // interrupted multipart leaves orphan parts in S3 (and you keep paying
  // for them) — the client cannot signal abortMultipart through a dead
  // control channel, so this server-side hook is the only path that
  // actually cancels. Cheap no-op when no upload is in flight.
  ws.on("close", () => core.abort());
});
```

Required environment: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`.

> **Always wire `ws.on("close", () => core.abort())`.** It is the load-bearing
> piece that keeps S3 from accumulating orphan multipart uploads when a
> connection drops. The browser-side Shell will mark itself aborted and
> stop spending bandwidth, but it cannot reach S3's abortMultipart endpoint
> without going through the Core.

### 2. Browser

```html
<script>globalThis.S3_REMOTE_CORE_URL = "ws://localhost:8080";</script>
<script type="module" src="/node_modules/@wc-bindable/hawc-s3/src/auto/remoteEnv.min.js"></script>

<input type="file" id="picker" />
<button id="go">Upload</button>
<progress id="bar" max="1"></progress>
<a id="dl" hidden></a>

<hawc-s3 id="s3" multipart-threshold="8388608"></hawc-s3>

<hawc-s3-callback for="#s3" on="progress">
  <script type="module">
    export default ({ loaded, total }) => {
      document.getElementById("bar").value = total ? loaded / total : 0;
    };
  </script>
</hawc-s3-callback>

<hawc-s3-callback for="#s3" on="completed">
  <script type="module">
    export default (done, { host }) => {
      if (!done) return;
      const dl = document.getElementById("dl");
      dl.href = host.url; dl.textContent = "open"; dl.hidden = false;
    };
  </script>
</hawc-s3-callback>

<script type="module">
  document.getElementById("go").onclick = () => {
    const s3 = document.getElementById("s3");
    s3.file = document.getElementById("picker").files[0];
    s3.trigger = true; // single PUT or multipart, chosen by file size
  };
</script>
```

## Component API

### `<hawc-s3>` attributes

| attribute | type | default | meaning |
|---|---|---|---|
| `bucket` | string | (server) | S3 bucket name (server may pre-seed it) |
| `prefix` | string | "" | key prefix prepended on the server |
| `key` | string | filename | explicit object key (else derived from `file.name`) |
| `content-type` | string | `file.type` | MIME override |
| `multipart-threshold` | bytes | `8388608` (8 MiB) | files larger than this go through multipart |
| `multipart-concurrency` | int | `4` | parallel part PUTs |
| `put-retries` | int | `3` | per-PUT retries on top of the initial attempt (0 disables) |

### `<hawc-s3>` JS-only properties

| property | meaning |
|---|---|
| `file` | the `Blob`/`File` to upload |
| `trigger` | set to `true` to start; auto-resets to `false` on completion |

### `<hawc-s3>` state (read-only, dispatched as events)

| property | event | description |
|---|---|---|
| `url` | `hawc-s3:url-changed` | presigned GET URL after completion |
| `key` | `hawc-s3:key-changed` | resolved object key |
| `etag` | `hawc-s3:etag-changed` | server-issued ETag (quotes stripped) |
| `progress` | `hawc-s3:progress-changed` | `{ loaded, total, phase }` (rAF-batched) |
| `loading` | `hawc-s3:loading-changed` | true during signing/uploading |
| `uploading` | `hawc-s3:uploading-changed` | true during the actual PUT(s) |
| `completed` | `hawc-s3:completed-changed` | true after post-process succeeds |
| `metadata` | `hawc-s3:metadata-changed` | `{ size, contentType }` |
| `error` | `hawc-s3:error` | `null` between uploads, error object on failure |

### `<hawc-s3-callback>`

```html
<hawc-s3-callback for="#s3" on="completed">
  <script type="module">
    export default (detail, { event, host }) => { /* ... */ };
  </script>
</hawc-s3-callback>
```

| attribute | meaning |
|---|---|
| `on` | event short name (`completed`, `progress`, `error`, `url`, `key`, `etag`, `loading`, `uploading`, `metadata`) or full event name with `:` |
| `for` | optional CSS selector for the host. Defaults to the nearest `<hawc-s3>` ancestor |
| `src` | optional external module URL instead of inline `<script>` |

## Multipart sizing

- Default part size: 8 MiB.
- Auto-scaled upward to fit S3's 10 000-part hard cap: `partSize = max(5 MiB, requested, ceil(size / 9999))`.
- Files ≤ `multipart-threshold` use a single PUT and skip the multipart machinery entirely.

## Retry policy

`put-retries` (default 3) applies to **every browser-originated PUT** — single uploads and per-part PUTs alike.

| condition | retried? |
|---|---|
| network error (XHR `error`) | yes |
| HTTP 5xx | yes |
| HTTP 408 / 429 | yes |
| other 4xx | no (won't fix itself) |
| user `abort()` | no (loop bails immediately) |

Backoff: 250 ms → 500 ms → 1000 ms → 2000 ms (capped at 4000 ms).

## S3 bucket CORS

Browser-side PUTs hit `https://<bucket>.s3.<region>.amazonaws.com` directly, so the bucket needs:

```json
[
  {
    "AllowedOrigins": ["https://your-app.example.com"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"]
  }
]
```

`ExposeHeaders: ["ETag"]` is required — both the single-PUT and multipart paths read each PUT's `ETag` header and forward it to the server. (Initiate / Complete / Abort happen server-side and do **not** need browser CORS.)

## S3-compatible stores

`AwsS3Provider` accepts `endpoint` and `forcePathStyle` for R2, MinIO, Wasabi, etc.:

```ts
new AwsS3Provider({
  endpoint: "https://<accountid>.r2.cloudflarestorage.com",
  forcePathStyle: true,  // required for MinIO; optional for R2
});
```

## Package entry points

| subpath | environment | exports |
|---|---|---|
| `@wc-bindable/hawc-s3` | browser | `bootstrapS3`, `WcsS3`, `WcsS3Callback`, `S3Core`, `AwsS3Provider`, retry helpers, types |
| `@wc-bindable/hawc-s3/server` | Node | `S3Core`, `AwsS3Provider`, `presignS3Url`, retry helpers, types — **no `HTMLElement`-based code** |
| `@wc-bindable/hawc-s3/auto` | browser (side-effect) | calls `bootstrapS3()` so `<hawc-s3>` and `<hawc-s3-callback>` are registered on import |
| `@wc-bindable/hawc-s3/auto/remoteEnv` | browser (side-effect) | calls `bootstrapS3({ remote: { enableRemote: true, remoteSettingType: "env" } })` — reads the WS URL from `globalThis.S3_REMOTE_CORE_URL` or `process.env.S3_REMOTE_CORE_URL` |

The default barrel is browser-targeted on purpose. Importing it from Node
fails at module evaluation (`HTMLElement is not defined`); use `/server`
for any code that runs outside a browser.

## End-to-end example

A runnable demo (HTTP + WS server, sample `<hawc-s3-callback>` set, server-side post-process hook) lives under [examples/s3-remote/](https://github.com/wc-bindable-protocol/wc-bindable-protocol/tree/main/examples/s3-remote).

## License

MIT
