# s3-uploader Remote Demo

End-to-end demo of [`@wc-bindable/s3`](../../packages/s3/) running in **remote HAWC** mode:

- **Browser** (`index.html`) holds `<s3-uploader>` + `<s3-callback>` — no AWS SDK, no credentials
- **Node server** (`server.mjs`) holds `S3Core` + `AwsS3Provider` — owns the AWS credentials and signs requests
- **Bytes never traverse the WebSocket** — the browser PUTs directly to S3 with a presigned URL

```
[Browser]  <s3-uploader>  ─WS─►  S3Core  ──►  AWS S3
                              │
                              └─►  registerPostProcess hook  (DB / scan / thumb)
```

## Required environment

```
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
S3_BUCKET=my-uploads-bucket
```

## Optional environment

| var | purpose |
|---|---|
| `PORT` | HTTP/WS port. Default `8080`. |
| `S3_PREFIX` | Default key prefix for uploads (e.g. `demo/`). |
| `S3_ENDPOINT` | Custom endpoint for R2 / MinIO / Wasabi. |
| `S3_FORCE_PATH_STYLE` | Set to `1` for MinIO-style path URLs. |

## Run

From the repo root:

```bash
# 1. Build the workspace (so /packages/*/dist/index.js exists for the importmap)
npm run build

# 2. Start the demo
S3_BUCKET=my-bucket AWS_REGION=us-east-1 \
  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  node examples/s3-remote/server.mjs

# 3. Open
#   http://localhost:8080
```

## S3 bucket CORS

Because the browser PUTs **directly** to `https://<bucket>.s3.<region>.amazonaws.com`,
the bucket must allow your origin. Apply a CORS rule like:

```json
[
  {
    "AllowedOrigins": ["http://localhost:8080"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"]
  }
]
```

`ExposeHeaders: ["ETag"]` is required — the Shell reads `ETag` from the PUT
response and forwards it to the server's `complete()` command.

## What the demo does

1. You pick a file and click Upload.
2. `<s3-uploader>` decides between **single PUT** and **multipart** based on `multipart-threshold` (default 8 MiB).
3. **Single PUT path** (file ≤ threshold):
   1. `requestUpload(key, size, contentType)` over the WS → presigned PUT URL.
   2. Browser PUTs the file directly to S3 via XHR; `reportProgress` streams back.
   3. `complete(key, etag)` runs server-side `registerPostProcess` hooks then returns a presigned GET URL.
4. **Multipart path** (file > threshold):
   1. `requestMultipartUpload(key, size, contentType)` → `{ uploadId, partSize, parts: [{partNumber, url, range}] }`.
   2. Browser uploads each part PUT in parallel (`multipart-concurrency`, default 4); per-part progress is summed and forwarded to `reportProgress`.
   3. `completeMultipart(key, uploadId, parts)` runs the same `registerPostProcess` hooks then returns a presigned GET URL.
   4. On any part failure or `abort()`, the Shell aborts the in-flight XHRs and fires `abortMultipart` so S3 does not bill for orphaned parts.

## Multipart sizing knobs

```html
<s3-uploader
  multipart-threshold="8388608"    <!-- bytes; default 8 MiB -->
  multipart-concurrency="4">       <!-- parallel part PUTs; default 4 -->
</s3-uploader>
```

- `partSize` is computed server-side: `max(5 MiB, requested, ceil(size / 9999))`. The 9999 divisor guarantees the upload fits in S3's 10 000-part hard cap regardless of file size.
- The single-PUT path has no part-count cap but each PUT is a single TCP connection. Use multipart for files larger than ~16 MiB or when network is flaky.
- Lowering `multipart-threshold` (e.g. to 5 MiB) is useful for E2E testing the multipart path without huge files; S3 still requires each non-final part to be ≥ 5 MiB.

## Multipart and CORS

Multipart adds two extra request types the browser issues against S3 — make sure your bucket's CORS rule allows them too:

| request | method | headers |
|---|---|---|
| Part PUT | `PUT` | (none beyond the presigned URL) |

The Initiate / Complete / Abort calls happen **server-side** and do not need bucket CORS. Only the **per-part PUTs** are browser-originating.

The same `ExposeHeaders: ["ETag"]` rule from the single-PUT setup is required — the Shell reads each part's ETag from its PUT response and forwards it to `completeMultipart`.

## Where the C案 split lives

| layer | location |
|---|---|
| Browser-side callback | [`<s3-callback>`](./index.html) tags with inline `<script type="module">` |
| Server-side post-process | [`core.registerPostProcess(...)`](./server.mjs) inside the WS connection handler |
