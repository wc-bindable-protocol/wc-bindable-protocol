import { test, expect } from "@playwright/test";
import http from "node:http";
import { startServer } from "./server.js";

/** Send an HTTP GET with the raw path string — bypasses any client-side URL
 *  normalization (Playwright/`fetch`/`URL` collapse `..` before sending, which
 *  makes traversal tests pointless from the test's vantage point). */
function rawGet(host: string, port: number, rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method: "GET", path: rawPath }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

let server: Awaited<ReturnType<typeof startServer>>;

test.beforeAll(async () => {
  server = await startServer(0);
});

test.afterAll(async () => {
  await server.close();
});

test.beforeEach(() => {
  server.state.objects.clear();
  server.state.multiparts.clear();
  server.state.postProcessLog.length = 0;
  server.state.putCount = 0;
  server.state.putFailures.length = 0;
  server.state.closeWsOnFirstPart = false;
  server.state._wsClosedByTrigger = false;
  server.state.activeWs = null;
  server.state.reportProgressCalls.length = 0;
});

test("single PUT round-trips a small file via the mock S3", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 15000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);
  expect(results.singlePut.url).toBe(true);
  expect(results.singlePut.etag).toMatch(/^[0-9a-f]{32}$/);
  expect(results.singleGetSize).toBe(64);
});

test("multipart upload merges parts and the GET returns the full blob", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 15000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);
  expect(results.multipart.url).toBe(true);
  // Mock multipart ETag has the "<md5>-<partCount>" shape that real S3 uses.
  expect(results.multipart.etag).toMatch(/^[0-9a-f]{32}-\d+$/);
  // 6 MiB + 100 bytes; partSize 5 MiB -> 2 parts; merged size matches the upload.
  expect(results.multipartGetSize).toBe(6 * 1024 * 1024 + 100);
});

test("progress callbacks carry byte-level updates across both upload paths", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 15000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);

  // --- Phase-level sanity (client-observable) ---
  expect(results.progressEventCount).toBeGreaterThan(0);
  expect(results.progressPhases).toContain("uploading");
  expect(results.progressPhases).toContain("done");

  // --- Byte-level regression guard (server-observable) ---
  //
  // Why the phase check alone is NOT enough: `hawc-s3:progress-changed` is
  // rAF-coalesced on the server and, on fast local-loopback uploads, the
  // mid-upload byte events get absorbed by the next `_cancelFlush()` that
  // completeMultipart runs. The client then only sees phase transitions at
  // `loaded: 0` or `loaded: total`. A bug that silently drops every
  // reportProgress RPC server-side (the old `invoke("reportProgress", [l, t])`
  // array form — Core's `Number.isFinite([…])` check rejects the array and
  // no-ops) would leave every single phase-level assertion green.
  //
  // Observe at the Core boundary instead (monkey-patched in server.ts's
  // wss.on("connection")) — the observer sees every RPC before rAF touches it.
  const progressCalls = server.state.reportProgressCalls;

  // (1) Some RPC arrived.
  expect(progressCalls.length, "no reportProgress RPC reached Core at all").toBeGreaterThan(0);

  // (2) Every arriving call has the declared shape. If the Shell wraps its
  //     args in an array, `loaded` would be `Array<number>` and `total`
  //     would be `undefined` — caught by the strict typeof check.
  const illFormed = progressCalls.filter(
    (c) => typeof c.loaded !== "number" || typeof c.total !== "number",
  );
  expect(
    illFormed,
    `reportProgress RPC arrived with wrong argument shape — likely wrapped in an array. Example: ${JSON.stringify(illFormed[0])}`,
  ).toEqual([]);

  // (3) At least one call carried a non-zero `loaded` — the actual byte
  //     count the UI needs to render a progress bar. The phase-only
  //     `_setProgress` calls inside requestUpload / requestMultipartUpload
  //     all pass `loaded: 0`, so this strictly tests that XHR upload.progress
  //     events made the round-trip through the proxy.
  const withBytes = progressCalls.filter((c) => (c.loaded as number) > 0);
  expect(
    withBytes.length,
    "no reportProgress RPC carried a non-zero byte count — XHR upload.progress events are not reaching Core",
  ).toBeGreaterThan(0);

  // (4) The largest `loaded` we saw equals the total byte count of the
  //     multipart file (6 MiB + 100 B). If any scaling / off-by-one is
  //     introduced in the RPC plumbing, this catches it in addition to
  //     shape bugs. (The single-PUT small file is only 64 B, so the 6 MiB+
  //     ceiling can only come from the multipart part-PUT stream.)
  const maxLoaded = Math.max(...withBytes.map((c) => c.loaded as number));
  expect(maxLoaded).toBe(6 * 1024 * 1024 + 100);
});

test("completed callback fires exactly once per upload", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 15000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);
  // 2 uploads (small + large) → exactly 2 completed callbacks (the false→true edges).
  expect(results.completedEventCount).toBe(2);
});

test("post-process hook runs server-side on every upload", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 15000 });

  // The server's registerPostProcess hook records each completion in postProcessLog.
  expect(server.state.postProcessLog).toHaveLength(2);
  expect(server.state.postProcessLog[0].key).toBe("small.txt");
  expect(server.state.postProcessLog[1].key).toBe("large.bin");
  expect(server.state.postProcessLog[1].etag).toMatch(/-\d+$/);
});

test("server-side state has both uploads stored under the test bucket", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 15000 });

  expect(server.state.objects.has("test-bucket/small.txt")).toBe(true);
  expect(server.state.objects.has("test-bucket/large.bin")).toBe(true);
  expect(server.state.multiparts.size).toBe(0); // no orphans
});

test("transient 503 on the single PUT triggers a successful retry", async ({ page }) => {
  // First single PUT fails with 503; the Shell's retry-with-backoff makes a
  // second attempt that the mock accepts. The end-to-end status still reaches
  // "done" and the small file ends up stored.
  server.state.putFailures.push({
    status: 503,
    match: (_p, q) => !q.has("uploadId"), // single PUT, not a multipart part
  });
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 15000 });

  // 1 single (retry: +1) + 2 multipart parts (6 MiB / 8 MiB partSize → 1 part actually).
  // Multipart with default 8 MiB partSize yields 1 part for 6 MiB+100B → 2 PUTs total
  // for the multipart, plus 2 PUTs for single (1 fail + 1 retry) = total ≥ 3.
  expect(server.state.putCount).toBeGreaterThanOrEqual(3);
  expect(server.state.objects.has("test-bucket/small.txt")).toBe(true);
  expect(server.state.objects.has("test-bucket/large.bin")).toBe(true);
});

test("transient 503 on a multipart part triggers a successful retry", async ({ page }) => {
  // First multipart part PUT fails. Multipart pipeline must retry and complete.
  server.state.putFailures.push({
    status: 503,
    match: (_p, q) => q.has("uploadId") && q.has("partNumber"),
  });
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 15000 });

  expect(server.state.objects.has("test-bucket/large.bin")).toBe(true);
  expect(server.state.multiparts.size).toBe(0); // multipart finalized cleanly
});

test("non-retriable 403 on the first PUT fails fast and leaves nothing behind", async ({ page }) => {
  // 403 is permanent (signature/permission style) — Shell must not retry.
  // Injected without a matcher, so the very first PUT (the small single-PUT
  // upload in client.html) consumes it. The page reaches error status before
  // the multipart upload ever starts.
  server.state.putFailures.push({ status: 403 });
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("error", { timeout: 15000 });

  // (1) Fail-fast: exactly one PUT attempt, no retries spent on a permanent error.
  expect(server.state.putCount).toBe(1);
  // (2) No orphaned multipart: because the single PUT failed, the multipart
  //     never initiated, so `_multipart` stays null server-side. Pinning this
  //     explicitly here — rather than relying only on the separate part-PUT
  //     test — makes the no-orphan invariant visible to readers of THIS test
  //     and would also catch a regression where a failed single PUT somehow
  //     left multipart state dangling.
  expect(server.state.multiparts.size).toBe(0);
  // (3) No partial object written.
  expect(server.state.objects.has("test-bucket/small.txt")).toBe(false);
});

test("static /packages handler only serves dist/, not src/ or package metadata", async () => {
  // Traversal is one attack surface; another is a handler that, while never
  // leaving the packages tree, happily hands out source files, test
  // fixtures, or package.json. Even for a demo server this is a footgun if
  // it ever ships outside the docs. Pin that ONLY `dist/**` is reachable.
  //
  // Sanity: the legitimate path still serves.
  const ok = await rawGet("localhost", server.port, "/packages/hawc-s3/dist/index.js");
  expect(ok.status).toBe(200);

  const shouldBeBlocked = [
    // TypeScript source
    "/packages/hawc-s3/src/components/S3.ts",
    "/packages/hawc-s3/src/signing/sigv4.ts",
    "/packages/core/src/index.ts",
    // package metadata
    "/packages/hawc-s3/package.json",
    "/packages/hawc-s3/tsconfig.json",
    // test infrastructure
    "/packages/hawc-s3/__tests__/sigv4.test.ts",
    "/packages/hawc-s3/tests/integration/server.ts",
    // docs / license at package root
    "/packages/hawc-s3/README.md",
    "/packages/hawc-s3/LICENSE",
  ];
  for (const p of shouldBeBlocked) {
    const res = await rawGet("localhost", server.port, p);
    expect(res.status, `${p} must not be served (got ${res.status})`).toBe(404);
  }
});

test("static /packages handler rejects path-traversal attempts", async () => {
  // Layered defense check — the helper itself is unit-tested in
  // __tests__/staticPath.test.ts (which exercises raw `..`, encoded `..`,
  // null bytes, etc.). This spec is the integration-level smoke test that
  // the server pipeline (URL parsing + helper + fs lookup) refuses every
  // shape we have seen suggested as an attack vector. Sent via raw HTTP so
  // client-side URL normalization does not collapse `..` before the server
  // sees it.
  const ok = await rawGet("localhost", server.port, "/packages/hawc-s3/dist/index.js");
  expect(ok.status).toBe(200);

  const cases = [
    "/packages/../package.json",
    "/packages/../../package.json",
    "/packages/hawc-s3/../../package.json",
    "/packages/%2e%2e/package.json",
    "/packages/%2E%2E%2F..%2Fpackage.json",
    "/packages/%2e%2e%2fpackage.json",
    "/packages/./../package.json",
  ];
  for (const p of cases) {
    const res = await rawGet("localhost", server.port, p);
    // The repo root contains a `package.json` whose contents include the
    // workspace name — match on that to catch a leak even if the status
    // code happens to be 200 by accident.
    expect(res.status, `${p} should not leak (got ${res.status})`).toBe(404);
    expect(res.body.includes("wc-bindable-protocol"), `${p} body must not contain root package.json contents`).toBe(false);
  }
});

test("non-retriable part-PUT failure triggers remote abortMultipart cleanup (live WS)", async ({ page }) => {
  // Different from the WS-drop spec: here the WebSocket stays *open* while a
  // part PUT fails non-retriably. The Shell must walk the `_abortMultipartFireAndForget`
  // path, which goes through `proxy.invoke("abortMultipart", key, uploadId)`.
  //
  // Regression guard: `proxy.invoke(name, ...args)` is variadic. A previous
  // implementation passed `[key, uploadId]` as a single array argument — the
  // server saw one array-typed argument and rejected on validation, the
  // rejection was swallowed by `.catch(() => {})`, and the orphan multipart
  // stayed in S3. The spec pins the live-WS cleanup path end-to-end so that
  // regression (or equivalents on reportProgress / other variadic sites)
  // surfaces at integration time.
  server.state.putFailures.push({
    status: 403, // non-retriable → the Shell fails fast after this one attempt
    match: (_p, q) => q.has("uploadId") && q.has("partNumber"),
  });
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("error", { timeout: 15000 });

  // Give the fire-and-forget abortMultipart RPC a moment to land server-side.
  await page.waitForTimeout(200);
  expect(server.state.multiparts.size, "multipart was not cleaned up — abortMultipart RPC likely malformed").toBe(0);
  // Small upload still landed (it ran before the multipart).
  expect(server.state.objects.has("test-bucket/small.txt")).toBe(true);
  // The interrupted multipart key did NOT finalize.
  expect(server.state.objects.has("test-bucket/large.bin")).toBe(false);
});

test("WS drop mid-multipart triggers server-side abortMultipart cleanup", async ({ page }) => {
  // Simulate the network disappearing after the first part successfully
  // lands. Without server-side cleanup, S3 would retain the orphan multipart
  // (the Core's `_multipart` slot would stay set, the uploadId would become
  // unreachable, and storage charges would accumulate on AWS).
  server.state.closeWsOnFirstPart = true;
  await page.goto(`http://localhost:${server.port}/client.html`);
  // The page surfaces the error from completeMultipart's transport failure.
  await expect(page.locator("#status")).toHaveText("error", { timeout: 15000 });

  // The server's ws.on("close", () => core.abort()) hook fires abortMultipart
  // against the mock S3, which clears the multiparts state.
  // Allow a generous beat for the close → abort → mock-S3 round-trip.
  await page.waitForTimeout(200);
  expect(server.state.multiparts.size).toBe(0);
  // The interrupted upload key did NOT make it into the finalized object
  // store — Complete never ran, so the parts are discarded.
  expect(server.state.objects.has("test-bucket/large.bin")).toBe(false);
  // No post-process hook ran for the failed upload.
  expect(server.state.postProcessLog.find(e => e.key === "large.bin")).toBeUndefined();
});
