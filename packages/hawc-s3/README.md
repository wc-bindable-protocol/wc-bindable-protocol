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

#### Provider wrapper recipe — Content-Type allowlist

Pre-presign rejection avoids the post-process hook's "bytes are already in S3"
window (extra cost, brief visibility, audit trail noise). Wrap your real
provider, gate `presignUpload` / `initiateMultipart`, and pass the wrapper to
`new S3Core(wrapper)`:

```ts
import {
  AwsS3Provider, S3Core,
  type IS3Provider, type S3RequestOptions,
} from "@wc-bindable/hawc-s3/server";

const ALLOWED = new Set([
  "image/png", "image/jpeg", "image/webp", "application/pdf",
]);

class ContentTypeAllowlist implements IS3Provider {
  constructor(private inner: IS3Provider) {}
  private _check(opts: S3RequestOptions): void {
    if (!opts.contentType || !ALLOWED.has(opts.contentType)) {
      throw new Error(`[upload] content-type not allowed: ${opts.contentType ?? "<none>"}`);
    }
  }
  presignUpload(key: string, opts: S3RequestOptions) {
    this._check(opts);
    return this.inner.presignUpload(key, opts);
  }
  initiateMultipart(key: string, opts: S3RequestOptions) {
    this._check(opts);
    return this.inner.initiateMultipart(key, opts);
  }
  // pass-through for the rest (presignDownload, presignPart, completeMultipart,
  // abortMultipart, deleteObject) — they cannot leak unauthorized bytes.
  presignDownload(k: string, o: S3RequestOptions) { return this.inner.presignDownload(k, o); }
  presignPart(k: string, u: string, n: number, o: S3RequestOptions) { return this.inner.presignPart(k, u, n, o); }
  completeMultipart(k: string, u: string, p: any, o: S3RequestOptions) { return this.inner.completeMultipart(k, u, p, o); }
  abortMultipart(k: string, u: string, o: S3RequestOptions) { return this.inner.abortMultipart(k, u, o); }
  deleteObject(k: string, o: S3RequestOptions) { return this.inner.deleteObject(k, o); }
}

const core = new S3Core(new ContentTypeAllowlist(new AwsS3Provider()));
```

The throw surfaces as `hawc-s3:error` on the Shell, no presigned URL is minted,
and S3 sees nothing. Use the same shape for max-size / key-shape / per-tenant
checks.

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
| `file` | the `Blob`/`File` to upload. Setting `file` is **passive** — it stores the value and does nothing else. The pending upload is not aborted, restarted, or re-keyed. The new value is consumed by the next `upload()` call (or `trigger=true`). To replace an in-flight upload's payload: call `abort()`, set `file`, then re-trigger. |
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
> module URL instead — or skip `<hawc-s3-callback>` entirely and subscribe
> through the wc-bindable adapter your framework already uses (see below).

#### When NOT to use `<hawc-s3-callback>`

`<hawc-s3-callback>` is the recommended path for **vanilla / no-framework**
pages, because the inline script keeps callback logic colocated with the
markup. For framework-driven apps, prefer the wc-bindable subscription that
your framework already speaks (`useWcBindable` in React/Vue, Svelte's
`use:wcBindable`, etc.) — bind to `<hawc-s3>` directly and read `progress`,
`completed`, `error` as reactive values. The callback element duplicates
that capability with extra DOM and a `blob:` requirement.

Strict-CSP environments (no `blob:` in `script-src`) should also drop the
callback element and bind through the framework adapter. The data plane is
the same — only the surface changes.

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

## Framework Integration

`<hawc-s3>` is HAWC + `wc-bindable-protocol`, so it works with any framework
through the thin adapters in `@wc-bindable/*`. The progress bar, completion
banner, and error surface in every example below are reactive views of the
**same** Shell state — no framework-specific upload code, no `useEffect` /
`onMounted` orchestration of XHRs.

For strict-CSP environments where `<hawc-s3-callback>` is not viable
(see [the CSP note](#-hawc-s3-callback-)), the framework adapters are also
the recommended substitute.

### React

`useWcBindable` returns a **callback ref**, not a `RefObject` — there is no
`.current`. Capture the element with a small fan-out callback ref so the
imperative `file=` / `trigger=true` assignments still have something to
target:

```tsx
import { useWcBindable } from "@wc-bindable/react";
import { useCallback, useRef, useState } from "react";
import type { WcsS3Values } from "@wc-bindable/hawc-s3";

type S3Element = HTMLElement & { file: Blob | null; trigger: boolean };

function Uploader() {
  const [bindRef, { progress, completed, url, error }] =
    useWcBindable<HTMLElement, WcsS3Values>();
  const [s3, setS3] = useState<S3Element | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Fan out one ref slot to (a) the wcBindable subscriber and (b) our
  // imperative handle. React calls callback refs on mount with the node
  // and on unmount with null.
  const setS3Ref = useCallback((node: HTMLElement | null) => {
    bindRef(node);
    setS3(node as S3Element | null);
  }, [bindRef]);

  const onUpload = () => {
    const file = fileInput.current?.files?.[0];
    if (!file || !s3) return;
    s3.file = file;
    s3.trigger = true;
  };

  return (
    <>
      <hawc-s3 ref={setS3Ref} multipart-threshold="8388608" />
      <input type="file" ref={fileInput} />
      <button onClick={onUpload}>Upload</button>
      <progress value={progress?.total ? progress.loaded / progress.total : 0} />
      {completed && url && <a href={url}>Download</a>}
      {error && <p className="error">{(error as Error).message}</p>}
    </>
  );
}
```

### Vue

```vue
<script setup lang="ts">
import { useWcBindable } from "@wc-bindable/vue";
import type { WcsS3Values } from "@wc-bindable/hawc-s3";

const { ref: s3Ref, values } = useWcBindable<HTMLElement, WcsS3Values>();

function onUpload(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  const s3 = s3Ref.value as any;
  if (!file || !s3) return;
  s3.file = file;
  s3.trigger = true;
}
</script>

<template>
  <hawc-s3 :ref="s3Ref" multipart-threshold="8388608" />
  <input type="file" @change="onUpload" />
  <progress :value="values.progress?.total ? values.progress.loaded / values.progress.total : 0" />
  <a v-if="values.completed && values.url" :href="values.url">Download</a>
  <p v-if="values.error" class="error">{{ values.error.message }}</p>
</template>
```

### Svelte

```svelte
<script>
import { wcBindable } from "@wc-bindable/svelte";

let s3El;
let progress = $state({ loaded: 0, total: 0 });
let completed = $state(false);
let url = $state("");
let error = $state(null);

function onUpload(e) {
  const file = e.target.files?.[0];
  if (!file || !s3El) return;
  s3El.file = file;
  s3El.trigger = true;
}
</script>

<hawc-s3 bind:this={s3El} multipart-threshold="8388608"
  use:wcBindable={{ onUpdate: (name, v) => {
    if (name === "progress") progress = v;
    if (name === "completed") completed = v;
    if (name === "url") url = v;
    if (name === "error") error = v;
  }}} />

<input type="file" on:change={onUpload} />
<progress value={progress.total ? progress.loaded / progress.total : 0} />
{#if completed && url}<a href={url}>Download</a>{/if}
{#if error}<p class="error">{error.message}</p>{/if}
```

### Vanilla — `bind()` directly

When you do not want to take the callback element's `blob:` CSP cost (or
just prefer imperative wiring), subscribe with `bind()`:

```javascript
import { bind } from "@wc-bindable/core";

const s3 = document.querySelector("hawc-s3");
const bar = document.getElementById("bar");

bind(s3, (name, value) => {
  if (name === "progress") {
    bar.value = value.total ? value.loaded / value.total : 0;
  } else if (name === "completed" && value === true) {
    bar.value = 1;
  }
});

document.getElementById("go").onclick = () => {
  s3.file = document.getElementById("picker").files[0];
  s3.trigger = true;
};
```

### What the adapters do *not* cover

The adapters subscribe to **state**. The two browser-side actions —
choosing a `File` and starting the upload — stay imperative because both
are gestures the framework's reactive layer should not own:

- `s3.file = file` runs on a user-driven `<input type="file">` change. Most
  frameworks treat the `FileList` as escape-hatch territory and do not
  reactively bind it.
- `s3.trigger = true` (or `s3.upload()`) is a command, not state. Like
  `fetch()` itself, it should fire from an event handler, not from a render
  cycle.

Everything downstream of those two lines — progress, completion, errors —
is fully reactive through the adapter.

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

### Single-PUT URL lifetime

The single-PUT path does **not** re-sign on demand. The presigned PUT URL is
issued once at `requestUpload()` time and used as-is for the whole upload —
including any retry. A PUT that 403s mid-flight (signature expired) is
classified as a non-retriable 4xx by the default policy and surfaces to
`error` immediately; `put-retries` is not consumed because retrying with the
same expired URL would 403 again.

In practice this only matters for the long-tail combination of (a) a small
file under `multipart-threshold` and (b) a link slow enough to take longer
than the presign TTL (default **15 minutes**). At that size a typical link
finishes in seconds, so the window is narrow. If you support genuinely slow
clients (satellite, weak mobile) where a single ≤ 8 MiB PUT can run past
15 minutes:

- **Lower the threshold** so those uploads route through multipart, which
  has the lazy-refresh + 403-retry behavior described above.
  `<hawc-s3 multipart-threshold="1048576">` (1 MiB) is a reasonable floor.
- **Or widen the TTL** for that workload via
  `new AwsS3Provider({ defaultExpiresInSeconds: 3600 })` — capped at SigV4's
  hard maximum of 7 days.

First-class single-PUT re-sign (eager refresh + 403-retry on the single path,
mirroring multipart) is on the same roadmap as `registerValidate`; PRs
welcome.

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

Hooks run **sequentially** — the first **fatal** hook to throw aborts the
rest. The Core deliberately does **not** auto-delete the S3 object on hook
failure, because that decision depends on your invariants (DB insert rolled
back? virus scan quarantined? audit trail needed?). If you want rollback,
call `core.deleteObject(key)` from an outer try/catch around the hook you
register.

### Fatal vs non-fatal hooks

By default every hook is **fatal**: a throw aborts the chain and rejects the
upload. That is the right behavior for hooks that gate the upload (DB insert,
virus scan, content-type allowlist) — losing them is unsafe.

For ancillary hooks whose failure must **not** invalidate the upload (audit
log, notification, metrics), opt out with `{ fatal: false }`:

```ts
core.registerPostProcess(logAudit,  { fatal: false }); // warn, keep going
core.registerPostProcess(virusScan);                   // gate (fatal default)
core.registerPostProcess(insertDB);                    // gate (fatal default)
```

A non-fatal throw is surfaced via a `hawc-s3:postprocess-warning` event on
the Core's target (detail: `{ error, ctx }`) and the chain continues with
the next hook. This removes the implicit "wrap your own try/catch" tax that
ancillary hooks would otherwise carry, and prevents a logging sink outage
from blocking real uploads.

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

## Error types

Errors surfaced through `hawc-s3:error` (and the `error` property) come from
two distinct layers, and the package treats them differently.

### Package-owned errors — discriminated union

Cases the package itself raises are exported as named classes **and** unioned
under a single `S3OwnedError` type, so consumers get exhaustive narrowing
without parsing message strings:

| class | thrown when | retried? |
|---|---|---|
| `PutHttpError` | a browser PUT receives a non-2xx status. Carries `status` and `responseBody`. | yes for 408 / 429 / 5xx; no for other 4xx |
| `MissingEtagError` | a 2xx PUT response has no visible `ETag` header (CORS `ExposeHeaders` or non-emitting S3-compatible server). | no — configuration issue |

```ts
import {
  PutHttpError, MissingEtagError,
  type S3OwnedError,
} from "@wc-bindable/hawc-s3";

function handleOwned(err: S3OwnedError): void {
  switch (err.name) {                         // exhaustive on the union
    case "MissingEtagError":
      // Surface a CORS-fix prompt; never going to self-heal.
      return;
    case "PutHttpError":
      // err.status, err.responseBody available
      if (err.status === 403) { /* likely expired single-PUT presign */ }
      return;
  }
}

s3.addEventListener("hawc-s3:error", (e) => {
  const err = (e as CustomEvent).detail;
  if (err instanceof PutHttpError || err instanceof MissingEtagError) {
    handleOwned(err);
  } else {
    // Upstream / transport — see next section.
  }
});
```

`S3OwnedError` is intentionally **closed**: every member is a class this
package raises itself, so adding a new member is a breaking change you can
catch at compile time. If the union widens in a future release, your
`switch` will surface a non-exhaustive warning at the unhandled case rather
than silently changing behavior at runtime.

### Upstream errors — passed through unwrapped

Errors **not** owned by this package — `AccessDenied`, `NoSuchBucket`,
`InvalidPart`, CORS preflight rejections, the underlying transport's
network errors — surface as plain `Error` instances with the upstream
message preserved. **They are not members of `S3OwnedError`** and are
deliberately not wrapped:

- `AwsS3Provider` already produces messages that discriminate the SDK error
  code; wrapping each into a class here would couple the package to AWS's
  evolving error vocabulary.
- The WebSocket transport and browser XHR layer have their own established
  error shapes that downstream tooling already handles.
- A single "wraps everything" parent class would force consumers to
  re-discriminate by message anyway.

If you need code-level discrimination on upstream cases, do it where the
vocabulary is stable: in your wrapped `IS3Provider`, throw your own typed
errors at the boundary you control. Those will then surface through
`hawc-s3:error` with their original class intact, and you can extend your
own discriminated union alongside `S3OwnedError`.

## Resumability

This component is **not resumable**. When the WebSocket drops mid-multipart,
`ws.on("close", () => core.abort())` tells S3 to abort the multipart upload —
which frees storage but means there is no partial state to resume from.
A subsequent upload re-uploads every byte.

For workloads with single-file uploads in the low-GB range this is usually
acceptable. For workloads that routinely ship tens of GB over flaky links
you want a resumable design (persist `uploadId` + completed part list across
reconnects, reuse them on the next session).

**Roadmap.** Resumable mode is **not** planned for the core package — the
required machinery (durable `uploadId` + part-etag store, reconnect
handshake, server-side Core re-attach across WebSocket sessions) materially
expands the surface area and is out of scope for the "control-plane only"
design. The intended path is a separate `@wc-bindable/hawc-s3-resumable`
companion that composes with this package via `IS3Provider` +
`registerPostProcess` (the same seams documented above). PRs that build it
in-tree as a sibling package are welcome; until then, treat in-flight
multiparts as discardable on disconnect.

### Residual orphan-parts risk

The `ws.on("close", () => core.abort())` hook and the provider-failure path
in `completeMultipart` both call `abortMultipart` as **best-effort** cleanup
(fire-and-forget with a swallowed catch — we intentionally do not block the
caller on cleanup, and the server may itself be unreachable at that point).
If that abort also fails (control plane outage, process crashes mid-call,
etc.), S3 keeps the uploaded parts and keeps billing for them.

The standard mitigation is a bucket-level lifecycle rule that sweeps them
automatically:

```json
{
  "Rules": [{
    "ID": "abort-orphan-multipart",
    "Status": "Enabled",
    "Filter": {},
    "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
  }]
}
```

Set the window to match your longest legitimate multipart (seconds to hours,
not days). Most S3-compatible stores (R2, MinIO, Wasabi, etc.) expose the
same `AbortIncompleteMultipartUpload` action on their lifecycle APIs, but
support level and exact parameter names vary — **check your provider's
current lifecycle documentation** before relying on it. If the action is
not available on your store, you will need an out-of-band sweeper
(`ListMultipartUploads` → `AbortMultipartUpload` on anything older than the
chosen window).

Configuring a backstop on every bucket that hosts `<hawc-s3>` uploads is
strongly recommended — it is the operational safety net that covers the
"best-effort cleanup itself failed" residual case.

## Scaling characteristics

A useful side effect of the "bytes never traverse the WebSocket" design is
that the **server cost is decoupled from upload size**:

- Per upload, the server holds: one WebSocket slot, one `S3Core` instance,
  and any per-hook state (DB connections, scan queue tickets).
- It does **not** hold the bytes. The browser PUTs directly to S3; the
  server only signs URLs, receives rAF-batched progress updates, runs the
  post-process hook, and presigns the final GET.

In big-O terms the server-side work is `O(connections × signing_rate)`,
not `O(bytes_uploaded)`. A 100 GB upload and a 1 KB upload cost the server
roughly the same — both are a handful of small RPCs spread over the
upload's wall-clock time. The bandwidth and storage cost lives entirely
on AWS's side of the wire.

This makes the package a good fit for workloads that would otherwise force
horizontal scaling on the upload-receiver tier: large media ingest, dataset
uploads, regulatory archives. Plan capacity by concurrent **connections**
(≈ a few KB of process memory each + your hook's per-call cost), not by
expected throughput. The constraints that *do* scale with byte volume —
S3 request rate, lifecycle / replication, downstream processing — sit on
AWS or in your own post-process pipeline, not in this Core.

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

A 2xx PUT whose response has no visible `ETag` is treated as a hard failure
(`MissingEtagError`) and is **not** retried — the two realistic causes
(missing `ExposeHeaders` on CORS, or an S3-compatible server that does not
emit ETag) are both configuration issues that retrying cannot fix. This
applies uniformly to both the single PUT path (failing before `complete()`)
and the per-part PUT path (failing before `completeMultipart()`), so the
completion call and the `registerPostProcess` hook never see an empty etag
— silent data corruption is no longer possible.

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
