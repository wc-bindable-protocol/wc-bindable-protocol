import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { S3 } from "../src/components/S3";
import { S3Core } from "../src/core/S3Core";
import {
  IS3Provider, S3RequestOptions, PresignedUpload, PresignedDownload, MultipartPart,
} from "../src/types";

beforeAll(() => {
  if (!customElements.get("hawc-s3")) customElements.define("hawc-s3", S3);
});

class FailingProvider implements IS3Provider {
  failureMessage: string;
  constructor(message = "presign failed") { this.failureMessage = message; }
  async presignUpload(_k: string, _o: S3RequestOptions): Promise<PresignedUpload> {
    throw new Error(this.failureMessage);
  }
  async presignDownload(_k: string, _o: S3RequestOptions): Promise<PresignedDownload> {
    return { url: "x", method: "GET", expiresAt: 0 };
  }
  async deleteObject(_k: string, _o: S3RequestOptions): Promise<void> {}
  async initiateMultipart(_k: string, _o: S3RequestOptions): Promise<{ uploadId: string }> { throw new Error(this.failureMessage); }
  async presignPart(_k: string, _u: string, _n: number, _o: S3RequestOptions): Promise<PresignedUpload> { throw new Error(this.failureMessage); }
  async completeMultipart(_k: string, _u: string, _p: MultipartPart[], _o: S3RequestOptions): Promise<{ etag: string }> { throw new Error(this.failureMessage); }
  async abortMultipart(_k: string, _u: string, _o: S3RequestOptions): Promise<void> {}
}

describe("S3 upload() re-entry bookkeeping", () => {
  let unhandled: Array<{ reason: unknown }> = [];
  const handler = (reason: unknown): void => { unhandled.push({ reason }); };

  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", handler);
  });

  afterEach(() => {
    process.off("unhandledRejection", handler);
  });

  /** Settle any pending microtasks AND macrotasks where unhandledRejection fires. */
  async function drainUnhandled(): Promise<void> {
    // Two macrotask ticks: Node only emits unhandledRejection after the current
    // microtask queue drains, then schedules the event on the next tick.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  function makeShell(): S3 {
    const s3 = document.createElement("hawc-s3") as S3;
    const core = new S3Core(new FailingProvider());
    core.bucket = "b";
    s3.attachLocalCore(core);
    document.body.appendChild(s3);
    return s3;
  }

  it("a failed upload() does not produce an unhandledrejection from the bookkeeping chain", async () => {
    const s3 = makeShell();
    s3.file = new Blob(["x"], { type: "text/plain" });
    s3.key = "k";

    // The caller awaits and catches — this is the contract. The bug was that
    // even a properly-caught upload() left a separate rejected promise from
    // promise.finally(...) floating off into unhandledrejection.
    await expect(s3.upload()).rejects.toThrow("presign failed");
    await drainUnhandled();
    expect(unhandled).toEqual([]);

    document.body.removeChild(s3);
  });

  it("trigger=true (which fire-and-forgets the upload) also does not leak", async () => {
    const s3 = makeShell();
    s3.file = new Blob(["x"], { type: "text/plain" });
    s3.key = "k";

    // trigger setter wraps upload() with `.catch(() => {})`, so the public
    // promise is handled. We assert no internal bookkeeping rejection escapes.
    s3.trigger = true;
    await drainUnhandled();
    // Wait a bit more for the upload pipeline + bookkeeping to settle.
    await new Promise((r) => setTimeout(r, 10));
    await drainUnhandled();
    expect(unhandled).toEqual([]);

    document.body.removeChild(s3);
  });

  it("re-entry while a prior upload is in flight does not leak rejections", async () => {
    const s3 = makeShell();
    s3.file = new Blob(["x"], { type: "text/plain" });
    s3.key = "k1";
    const first = s3.upload();
    // Kick off a second upload before the first settles. The second's
    // re-entry guard aborts + awaits the first, so both flows ultimately
    // unwind through the same bookkeeping path.
    s3.key = "k2";
    const second = s3.upload();
    await Promise.allSettled([first, second]);
    await drainUnhandled();
    expect(unhandled).toEqual([]);

    document.body.removeChild(s3);
  });
});
