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
| Multipart Initiate (`POST /<key>?uploads`) / Complete (`POST /<key>?uploadId=…`) / Abort (`DELETE /<key>?uploadId=…`) | Server (Provider presigns the control-plane URL and `fetch()`es it itself — this is **not** the "presigned POST" browser-upload form) |
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

## Security — your responsibilities

The Quick Start example above is **deliberately minimal** and is **not production-ready**.
The Core runs in your server process and trusts whatever you hand it — that means
authentication, per-user scoping, and input validation are your job, not the
library's. At minimum wire the following before exposing this to real users:

- **Authenticate the WebSocket.** `new WebSocketServer({ port: 8080 })` accepts
  anyone who can reach the port. Use `wss.on("upgrade", …)` (or your framework's
  WS adapter) to verify a session cookie / bearer token during the HTTP upgrade
  and reject connections with no identity.
- **Bind `core.prefix` to the authenticated user.** `core.prefix = "user/123/"`
  in the example is hard-coded for brevity. In production resolve the user id
  from the authenticated session and set the prefix per-connection, so user A
  cannot upload into user B's namespace.
- **Validate `key` before signing.** The default provider's `_resolveKey`
  strips a leading `/` but does not reject `..` segments. S3 stores `..` as a
  literal key part (it has no directory semantics), but downstream tools that
  normalize paths — or your own prefix-scoped `ListObjects` — can be tricked
  by a key like `../other-user/file.bin`. Reject `..`, control characters,
  absolute paths, and overly long keys in a `registerPostProcess` pre-check
  **or by wrapping `IS3Provider`** (see "Extension points" below).
- **Constrain `content-type`.** The browser picks the Content-Type freely.
  If you serve the presigned GET URL into a `<a>` / `<iframe>`, a user-supplied
  `text/html` upload becomes stored XSS. Mitigations, in order of preference:
  (1) allowlist Content-Types inside your `registerPostProcess` hook and
  `deleteObject` on rejection, (2) set a fixed `Content-Disposition: attachment`
  via `ResponseContentDisposition` on the download presign, or (3) serve
  uploads from a separate, cookie-less origin.
- **Enforce a max file size.** This component has no built-in cap. Enforce
  one server-side by inspecting the `size` argument to `requestUpload` /
  `requestMultipartUpload` — the cleanest place is a wrapper around
  `IS3Provider` that throws before any presigned URL is issued.

### Extension points

The Core's "accept input → sign → run hook" pipeline has two seams you can hook
today without forking:

| What you want to reject / enforce | Where to hook |
|---|---|
| Bucket / prefix / key / size / content-type before any URL is minted | Wrap `IS3Provider` and throw from `presignUpload` / `initiateMultipart`. The Core surfaces the throw as `hawc-s3:error` and leaves no S3 state behind. |
| Post-upload checks (virus scan, DB insert, allowlist) | `core.registerPostProcess(ctx => …)`. Throwing here rejects the upload — see "Post-process failure semantics" below. |

A dedicated `registerValidate` hook running **before** presign (so it can reject
without minting a URL) is on the roadmap; until it lands, the provider wrapper
is the supported equivalent.

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

### `<hawc-s3>` JS-only properties and methods

| property / method | meaning |
|---|---|
| `file` | the `Blob`/`File` to upload |
| `upload()` | explicit start. Returns the final download URL. Re-entry is serialized: a call while another upload is in flight aborts the prior one and waits for it to unwind before starting fresh. |
| `trigger` | attribute-/binding-driven convenience: setting it to `true` calls `upload()` and resets to `false` on completion. Prefer `upload()` from imperative code — `trigger` exists so reactive frameworks can drive the component as a property. |
| `abort()` | cancel the current upload. Also triggers server-side multipart cleanup when applicable. |

`key` is a dual-role property: set/attribute it before upload to force the object key,
then read it as state to get the resolved key emitted by the Core (`hawc-s3:key-changed`).

> **Class name vs. tag name.** The default element name is `<hawc-s3>`
> (configurable via `bootstrapS3({ tagNames: …})`), but the exported class is
> `WcsS3` (and `WcsS3Callback`) — the `Wcs` prefix is the package-wide class
> namespace across `@wc-bindable/*`, while `hawc-` is the tag namespace for
> this product family (`<hawc-ai>`, `<hawc-s3>`, `<hawc-auth0>`). When
> grepping, look for the tag string in templates and the class symbol in JS.

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

> **CSP note.** The inline `<script type="module">` body is not evaluated by
> the page's normal module loader — `<hawc-s3-callback>` wraps it in a Blob
> and dynamic-`import()`s the resulting `blob:` URL. That means a strict CSP
> needs `script-src 'self' blob:` (and `worker-src` is irrelevant here).
> If `blob:` is not allowed, use the `src` attribute to point at a real
> module URL instead.

### Event naming

Every observable property emits `hawc-s3:<name>-changed` — including boolean
state like `completed-changed`. The `-changed` suffix is applied uniformly
because framework bindings and the Remote proxy derive event names from
`wcBindable.properties` declaratively (`name → ${name}-changed`). Renaming
`completed-changed` to `completed` for readability would require every binder
to carry a per-property exception table, so the cost to the ecosystem
outweighs the local readability win.

The one exception is `error`, which dispatches as `hawc-s3:error` (no suffix)
because it is a signal, not a state transition.

## Multipart sizing

- Default part size: 8 MiB.
- Auto-scaled upward to fit S3's 10 000-part hard cap: `partSize = max(5 MiB, requested, ceil(size / 9999))`.
- Files ≤ `multipart-threshold` use a single PUT and skip the multipart machinery entirely.

## Multipart URL lifetime

Each part URL is individually signed with the provider's `defaultExpiresInSeconds`
(default **15 minutes**), carried through to the browser as `part.expiresAt`.

For a large file on a slow link, the tail parts can reach their turn well
after the initial window — so the Shell **re-signs on demand** rather than
letting them 403:

- **Eager refresh.** Before each PUT, if the part URL has less than 60 s of
  TTL remaining, the Shell calls `signMultipartPart(key, uploadId, partNumber)`
  on the Core to mint a fresh URL. No exponential-backoff cost, no failed PUT.
- **403 fallback.** If the URL still 403s mid-upload (e.g. clock skew, the
  eager check was off), the Shell re-signs once and retries immediately. A
  second 403 is treated as a genuine deny and surfaced to `error`.

You do not need to configure anything — the behavior is automatic. If you
front the Core with your own `IS3Provider`, implement `presignPart` to return
a fresh URL each call; the Core treats it as side-effect-free.

Any `headers` your `presignPart` returns (SSE-C, custom auth, etc.) are
forwarded to the Shell on both the initial signing and every re-sign and
echoed on the part PUT — the multipart path is symmetrical with the single
PUT path.

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

## Presigned URL TTL

The `url` property holds a **presigned GET URL** that AWS will honor for a
bounded time — after expiry it returns `AccessDenied` and cannot be renewed.
Treat it as a one-shot link, not a durable identifier.

- Default lifetime: **15 minutes** (`defaultExpiresInSeconds: 900` on
  `AwsS3Provider`).
- Overridable globally: `new AwsS3Provider({ defaultExpiresInSeconds: 3600 })`.
- Overridable per-request: pass `expiresInSeconds` in `S3RequestOptions`.
- Hard cap: SigV4 allows at most **7 days** — the provider does not currently
  widen beyond that.

**Do not persist `url` to a database or let users bookmark it.** Store the
stable `key` instead and call `core.requestDownload(key)` (or expose your own
endpoint that does) to mint a fresh presigned URL on demand.

## Post-process failure semantics

When a `registerPostProcess` hook throws, the contract is:

| state | value |
|---|---|
| S3 object | **retained** (the bytes are already in the bucket at that point) |
| `completed` | stays `false` |
| `uploading`, `loading` | set to `false` |
| `error` | populated with the thrown error; `hawc-s3:error` dispatched |
| `url` | **not** published (no presigned GET minted) |
| the `complete` / `completeMultipart` RPC | rejects with the same error |

Hooks run **sequentially** — the first to throw aborts the rest. The Core
deliberately does **not** auto-delete the S3 object on hook failure, because
that decision depends on your invariants (DB insert rolled back? virus scan
quarantined? audit trail needed?). If you want rollback, call
`core.deleteObject(key)` from an outer try/catch around the hook you register.

**Atomicity with your DB.** There is no two-phase commit between S3 and your
database. The supported patterns are:

1. *Write-then-DB* — let the upload land in S3, insert into the DB from the
   post-process hook. If the DB insert fails, the object is orphaned; a
   periodic reconciliation job (list S3, left-anti-join DB) cleans it up.
2. *Shadow-prefix-then-move* — upload to `staging/...`, insert into DB from
   the hook, then rename (server-side copy + delete) into `canonical/...`.
   More work, but the DB is the sole source of truth at rest.

## ETag and integrity

- **Single PUT** — the ETag is the MD5 of the object content. Safe to use as
  an integrity check.
- **Multipart** — S3's multipart ETag is **not** an MD5 of the content; it is
  an MD5 of the concatenated part MD5s plus `-<partCount>`. Do not compare it
  against a client-side file hash.
- **x-amz-checksum-sha256** — not currently emitted or validated by
  `AwsS3Provider`. If you need end-to-end SHA-256 verification, compute it
  client-side and store it in your DB via the post-process hook, or wrap
  `IS3Provider` to add the header and verify the response.

## Resumability

This component is **not resumable**. When the WebSocket drops mid-multipart,
`ws.on("close", () => core.abort())` tells S3 to abort the multipart upload —
which frees storage but means there is no partial state to resume from.
A subsequent upload re-uploads every byte.

For workloads with single-file uploads in the low-GB range this is usually
acceptable. For workloads that routinely ship tens of GB over flaky links
you want a resumable design (persist `uploadId` + completed part list across
reconnects, reuse them on the next session). A resumable mode is not in this
release; the extension points to build one are `IS3Provider` +
`registerPostProcess`, and we would accept a PR.

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

**Endpoint path prefix.** Reverse-proxy deployments can mount the store under
a non-root path — the provider preserves any pathname on `endpoint` and
signs the full URL:

```ts
new AwsS3Provider({
  endpoint: "https://example.com/storage", // → https://example.com/storage/<bucket>/<key>
  forcePathStyle: true,
});
```

The path prefix is covered by the SigV4 signature, so the reverse proxy must
forward the request without rewriting the path. If your proxy strips the
prefix before handing the request to S3, sign against the bare-origin
endpoint instead.

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
