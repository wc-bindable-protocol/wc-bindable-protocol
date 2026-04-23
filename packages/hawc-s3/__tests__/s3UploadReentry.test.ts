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
    // Kick off a second upload before the first settles. Under the current
    // semantics the second call is a no-op and returns the existing
    // in-flight promise — both `first` and `second` settle through the same
    // promise identity, so there should be no extra bookkeeping chain that
    // could leak an unhandled rejection.
    s3.key = "k2";
    const second = s3.upload();
    await Promise.allSettled([first, second]);
    await drainUnhandled();
    expect(unhandled).toEqual([]);

    document.body.removeChild(s3);
  });

  it("upload() while in-flight does not start a replacement run (trigger=true also no-ops)", async () => {
    // Pin the no-op-on-reentry semantics: a concurrent upload() call does not
    // bump `_uploadGeneration` (which would happen on abort-and-replace) and
    // `trigger=true` while an upload is in flight also does not start a
    // second run. This matches the trigger setter's contract and prevents
    // multipart uploadId leakage from racing workers.
    const s3 = makeShell();
    s3.file = new Blob(["x"], { type: "text/plain" });
    s3.key = "k1";

    const first = s3.upload();
    // Reach into private state to observe the generation counter — the
    // alternative (tracking outcome count) is flakier under async timing.
    const genAtStart = (s3 as unknown as { _uploadGeneration: number })._uploadGeneration;

    const second = s3.upload();
    // trigger=true while in-flight must also be a no-op (pre-existing
    // behavior from the trigger setter's `if (this._currentUpload) return;`
    // guard, pinned here to guard against drift).
    s3.trigger = true;
    const third = s3.upload();

    // No replacement run started: the generation counter is unchanged from
    // the moment `first` took the slot.
    const genAfterReentry = (s3 as unknown as { _uploadGeneration: number })._uploadGeneration;
    expect(genAfterReentry).toBe(genAtStart);

    // All concurrent calls ultimately settle through the same underlying
    // pipeline — none leak an unhandled rejection even though the provider
    // rejects presign.
    await Promise.allSettled([first, second, third]);
    await drainUnhandled();
    expect(unhandled).toEqual([]);

    document.body.removeChild(s3);
  });
});
