import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { S3 } from "../src/components/S3";
import { S3Core } from "../src/core/S3Core";
import {
  IS3Provider, S3RequestOptions, PresignedUpload, PresignedDownload, MultipartPart,
} from "../src/types";

/**
 * FakeXhr that always succeeds with status 200 but returns `null` from
 * `getResponseHeader("ETag")` — the exact shape a bucket with missing
 * `ExposeHeaders: ["ETag"]` CORS produces, and also what an S3-compatible
 * server that simply never emits ETag looks like to the browser.
 *
 * Also counts how many times it was constructed so we can assert the
 * retry policy treats this as non-retriable.
 */
let xhrConstructCount = 0;

class NoEtagXhr {
  status = 200;
  statusText = "OK";
  responseText = "";
  upload = { addEventListener: (_n: string, _fn: (ev: any) => void) => { /* ignored */ } };
  private _listeners: Record<string, Array<() => void>> = {};

  constructor() { xhrConstructCount++; }

  open(_method: string, _url: string, _async?: boolean): void { /* ignored */ }
  setRequestHeader(_name: string, _value: string): void { /* ignored */ }
  addEventListener(name: string, handler: () => void): void {
    (this._listeners[name] ??= []).push(handler);
  }
  // The whole point: the ETag header is not visible, even though the PUT
  // itself succeeded at HTTP level. Before the fix, the Shell resolved with
  // "" here and fed empty etag into completion.
  getResponseHeader(_name: string): string | null { return null; }
  send(_body: unknown): void {
    queueMicrotask(() => { for (const fn of this._listeners["load"] ?? []) fn(); });
  }
  abort(): void {
    for (const fn of this._listeners["abort"] ?? []) fn();
  }
}

class SimpleProvider implements IS3Provider {
  async presignUpload(key: string, _o: S3RequestOptions): Promise<PresignedUpload> {
    return { url: `https://example/upload/${key}`, method: "PUT", headers: {}, expiresAt: Date.now() + 60_000 };
  }
  async presignDownload(key: string, _o: S3RequestOptions): Promise<PresignedDownload> {
    return { url: `https://example/download/${key}`, method: "GET", expiresAt: Date.now() + 60_000 };
  }
  async deleteObject(_k: string, _o: S3RequestOptions): Promise<void> {}
  async initiateMultipart(_k: string, _o: S3RequestOptions): Promise<{ uploadId: string }> {
    return { uploadId: "u1" };
  }
  async presignPart(_k: string, _u: string, partNumber: number, _o: S3RequestOptions): Promise<PresignedUpload> {
    return { url: `https://example/part/${partNumber}`, method: "PUT", headers: {}, expiresAt: Date.now() + 60_000 };
  }
  async completeMultipart(_k: string, _u: string, _p: MultipartPart[], _o: S3RequestOptions): Promise<{ etag: string }> {
    // If we ever reach here, the fix has regressed — the missing-ETag guard
    // in the Shell should have rejected the upload long before complete.
    throw new Error("[test] completeMultipart should not have been reached on a missing-ETag PUT");
  }
  async abortMultipart(_k: string, _u: string, _o: S3RequestOptions): Promise<void> {}
}

let originalXhr: typeof XMLHttpRequest;

beforeAll(() => {
  if (!customElements.get("s3-uploader")) customElements.define("s3-uploader", S3);
});

beforeEach(() => {
  originalXhr = globalThis.XMLHttpRequest;
  (globalThis as any).XMLHttpRequest = NoEtagXhr;
  xhrConstructCount = 0;
});

afterEach(() => {
  (globalThis as any).XMLHttpRequest = originalXhr;
});

describe("S3 Shell — 2xx PUT with missing ETag is treated as a hard failure", () => {
  it("single PUT rejects with MissingEtagError and does NOT fall through to complete()", async () => {
    // The bug: before the fix, `_doPutOnce` did
    //   resolve(xhr.getResponseHeader("ETag") || "")
    // so a 200 with no ETag silently succeeded with "", and the post-process
    // hook received `etag: ""`. Now the Shell rejects explicitly.
    const el = document.createElement("s3-uploader") as S3;
    const core = new S3Core(new SimpleProvider());
    core.bucket = "b";
    // The server-side hook MUST NOT run on a missing-ETag upload. A spy
    // here makes the regression loud rather than subtle.
    let hookRan = false;
    core.registerPostProcess(() => { hookRan = true; });
    el.attachLocalCore(core);
    document.body.appendChild(el);
    try {
      el.file = new Blob(["payload"]);
      await expect(el.upload()).rejects.toThrow(/no ETag header/);
      expect(hookRan).toBe(false);
      expect(el.completed).toBe(false);
      expect(el.error).toBeInstanceOf(Error);
      expect(String((el.error as Error).message)).toMatch(/ExposeHeaders/);
    } finally {
      el.remove();
    }
  });

  it("MissingEtagError is NOT retried (configuration issue, won't self-heal)", async () => {
    // Proof that retry policy classifies MissingEtagError as terminal:
    // a missing-ETag 200 should consume exactly one XHR attempt, not four
    // (the default `putRetries = 3` budget would produce four if retried).
    const el = document.createElement("s3-uploader") as S3;
    const core = new S3Core(new SimpleProvider());
    core.bucket = "b";
    el.attachLocalCore(core);
    document.body.appendChild(el);
    try {
      el.file = new Blob(["payload"]);
      await expect(el.upload()).rejects.toThrow(/no ETag header/);
      expect(xhrConstructCount).toBe(1);
    } finally {
      el.remove();
    }
  });

  it("multipart part PUTs also reject on missing ETag (does not leak empty part etags)", async () => {
    // Per-part PUTs share `_doPutOnce` with the single-PUT path, so the
    // guard must kick in on multipart too. If it did not, the empty etag
    // would accumulate in `completed[]` and reach `completeMultipart` —
    // which in our test's SimpleProvider throws to make the regression
    // visible. The Shell should fail at the part PUT stage, before that.
    const el = document.createElement("s3-uploader") as S3;
    el.setAttribute("multipart-threshold", String(8 * 1024 * 1024));
    const core = new S3Core(new SimpleProvider());
    core.bucket = "b";
    el.attachLocalCore(core);
    document.body.appendChild(el);
    try {
      el.file = new Blob([new Uint8Array(20 * 1024 * 1024)]);
      const rejection = await el.upload().catch(e => e);
      expect(rejection).toBeInstanceOf(Error);
      // The first failing part surfaces the missing-ETag message.
      expect(String(rejection.message)).toMatch(/no ETag header/);
      expect(el.completed).toBe(false);
    } finally {
      el.remove();
    }
  });
});
