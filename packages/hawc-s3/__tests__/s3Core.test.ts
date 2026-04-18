import { describe, it, expect, vi, beforeEach } from "vitest";
import { S3Core } from "../src/core/S3Core";
import {
  IS3Provider, S3RequestOptions, PresignedUpload, PresignedDownload, MultipartPart,
} from "../src/types";

class FakeProvider implements IS3Provider {
  uploadCalls: Array<{ key: string; opts: S3RequestOptions }> = [];
  downloadCalls: Array<{ key: string; opts: S3RequestOptions }> = [];
  deleteCalls: Array<{ key: string; opts: S3RequestOptions }> = [];
  initiateCalls: Array<{ key: string; opts: S3RequestOptions }> = [];
  partCalls: Array<{ key: string; uploadId: string; partNumber: number }> = [];
  completeCalls: Array<{ key: string; uploadId: string; parts: MultipartPart[] }> = [];
  abortCalls: Array<{ key: string; uploadId: string }> = [];
  presignError: Error | null = null;
  deleteError: Error | null = null;
  initiateError: Error | null = null;
  presignPartError: Error | null = null;
  completeMultipartError: Error | null = null;
  nextUploadId: string = "upload-1";

  async presignUpload(key: string, opts: S3RequestOptions): Promise<PresignedUpload> {
    if (this.presignError) throw this.presignError;
    this.uploadCalls.push({ key, opts });
    return {
      url: `https://example.com/upload/${key}`,
      method: "PUT",
      headers: opts.contentType ? { "Content-Type": opts.contentType } : {},
      expiresAt: Date.now() + 60_000,
    };
  }

  async presignDownload(key: string, opts: S3RequestOptions): Promise<PresignedDownload> {
    this.downloadCalls.push({ key, opts });
    return {
      url: `https://example.com/download/${key}`,
      method: "GET",
      expiresAt: Date.now() + 60_000,
    };
  }

  async deleteObject(key: string, opts: S3RequestOptions): Promise<void> {
    if (this.deleteError) throw this.deleteError;
    this.deleteCalls.push({ key, opts });
  }

  async initiateMultipart(key: string, opts: S3RequestOptions): Promise<{ uploadId: string }> {
    if (this.initiateError) throw this.initiateError;
    this.initiateCalls.push({ key, opts });
    return { uploadId: this.nextUploadId };
  }

  async presignPart(key: string, uploadId: string, partNumber: number, _opts: S3RequestOptions): Promise<PresignedUpload> {
    if (this.presignPartError) throw this.presignPartError;
    this.partCalls.push({ key, uploadId, partNumber });
    return {
      url: `https://example.com/upload/${key}?partNumber=${partNumber}&uploadId=${uploadId}`,
      method: "PUT",
      headers: {},
      expiresAt: Date.now() + 60_000,
    };
  }

  async completeMultipart(key: string, uploadId: string, parts: MultipartPart[], _opts: S3RequestOptions): Promise<{ etag: string }> {
    if (this.completeMultipartError) throw this.completeMultipartError;
    this.completeCalls.push({ key, uploadId, parts });
    return { etag: "merged-etag" };
  }

  async abortMultipart(key: string, uploadId: string, _opts: S3RequestOptions): Promise<void> {
    this.abortCalls.push({ key, uploadId });
  }
}

function flushRaf(): Promise<void> {
  // happy-dom rAF polyfill is setTimeout(0); two macrotask ticks let it drain.
  return new Promise(r => setTimeout(r, 0));
}

describe("S3Core", () => {
  let provider: FakeProvider;
  let core: S3Core;

  beforeEach(() => {
    provider = new FakeProvider();
    core = new S3Core(provider);
    core.bucket = "test-bucket";
  });

  it("declares the wcBindable protocol", () => {
    expect(S3Core.wcBindable.protocol).toBe("wc-bindable");
    expect(S3Core.wcBindable.version).toBe(1);
    const propNames = S3Core.wcBindable.properties.map(p => p.name);
    expect(propNames).toContain("url");
    expect(propNames).toContain("progress");
    expect(propNames).toContain("completed");
    const cmdNames = (S3Core.wcBindable.commands ?? []).map(c => c.name);
    expect(cmdNames).toContain("requestUpload");
    expect(cmdNames).toContain("complete");
  });

  it("requestUpload returns a presigned URL and updates state", async () => {
    const events: any[] = [];
    core.addEventListener("hawc-s3:url-changed", (e: any) => events.push(["url", e.detail]));
    core.addEventListener("hawc-s3:uploading-changed", (e: any) => events.push(["uploading", e.detail]));

    const result = await core.requestUpload("file.txt", 1000, "text/plain");
    expect(result.url).toBe("https://example.com/upload/file.txt");
    expect(result.method).toBe("PUT");
    expect(core.uploading).toBe(true);
    expect(core.key).toBe("file.txt");
    expect(core.metadata).toEqual({ size: 1000, contentType: "text/plain" });
    // The PUT URL must NOT leak into public state. README documents `url` as
    // the post-completion GET URL; broadcasting the write-capable PUT URL
    // here would violate that contract and expose a credential-bearing
    // token to every binding/logger subscribed to `hawc-s3:url-changed`.
    expect(events.some(e => e[0] === "url")).toBe(false);
    expect(core.url).toBe("");
    expect(events.some(e => e[0] === "uploading" && e[1] === true)).toBe(true);
  });

  it("hawc-s3:url-changed only fires after complete (single PUT)", async () => {
    const urlEvents: any[] = [];
    core.addEventListener("hawc-s3:url-changed", (e: any) => urlEvents.push(e.detail));
    await core.requestUpload("file.txt", 100);
    expect(urlEvents).toEqual([]);
    expect(core.url).toBe("");
    const downloadUrl = await core.complete("file.txt", "abc");
    expect(urlEvents).toEqual([downloadUrl]);
    expect(core.url).toBe(downloadUrl);
    // The exposed URL is the GET URL, not the PUT URL captured during requestUpload.
    expect(downloadUrl).toBe("https://example.com/download/file.txt");
  });

  it("requestUpload throws when bucket is missing", async () => {
    const c = new S3Core(provider);
    await expect(c.requestUpload("k", 0)).rejects.toThrow(/bucket/);
  });

  it("requestUpload propagates provider errors and resets busy state", async () => {
    provider.presignError = new Error("boom");
    await expect(core.requestUpload("k", 1)).rejects.toThrow("boom");
    expect(core.uploading).toBe(false);
    expect(core.loading).toBe(false);
    expect(core.error).toBeInstanceOf(Error);
  });

  it("reportProgress coalesces via rAF and dispatches a snapshot", async () => {
    await core.requestUpload("k", 1000);
    const snapshots: any[] = [];
    core.addEventListener("hawc-s3:progress-changed", (e: any) => snapshots.push(e.detail));
    core.reportProgress(100, 1000);
    core.reportProgress(500, 1000);
    core.reportProgress(900, 1000);
    expect(snapshots).toHaveLength(0); // batched
    await flushRaf();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({ loaded: 900, total: 1000, phase: "uploading" });
  });

  it("reportProgress is ignored when no upload is active", async () => {
    const snapshots: any[] = [];
    core.addEventListener("hawc-s3:progress-changed", (e: any) => snapshots.push(e.detail));
    core.reportProgress(100, 1000);
    await flushRaf();
    expect(snapshots).toHaveLength(0);
  });

  it("complete runs post-process hooks in order then exposes a download URL", async () => {
    await core.requestUpload("file.bin", 10, "application/octet-stream");
    const seen: string[] = [];
    core.registerPostProcess(async (ctx) => { seen.push(`a:${ctx.key}:${ctx.etag}`); });
    core.registerPostProcess(async () => { seen.push("b"); });

    const url = await core.complete("file.bin", "abc123");
    expect(seen).toEqual(["a:file.bin:abc123", "b"]);
    expect(url).toBe("https://example.com/download/file.bin");
    expect(core.url).toBe(url);
    expect(core.completed).toBe(true);
    expect(core.uploading).toBe(false);
    expect(core.etag).toBe("abc123");
  });

  it("complete short-circuits if a hook throws", async () => {
    await core.requestUpload("k", 1);
    const seen: string[] = [];
    core.registerPostProcess(() => { throw new Error("hook fail"); });
    core.registerPostProcess(() => { seen.push("never"); });
    await expect(core.complete("k", "et")).rejects.toThrow("hook fail");
    expect(seen).toEqual([]);
    expect(core.error).toBeInstanceOf(Error);
    expect(core.uploading).toBe(false);
  });

  it("non-fatal hook failure does not abort the chain", async () => {
    await core.requestUpload("k", 1);
    const seen: string[] = [];
    const warnings: any[] = [];
    core.addEventListener("hawc-s3:postprocess-warning", (e) => {
      warnings.push((e as CustomEvent).detail);
    });
    core.registerPostProcess(() => { seen.push("a"); });
    core.registerPostProcess(() => { throw new Error("audit log down"); }, { fatal: false });
    core.registerPostProcess(() => { seen.push("c"); });
    const url = await core.complete("k", "et");
    expect(seen).toEqual(["a", "c"]);
    expect(url).toBe("https://example.com/download/k");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].error.message).toBe("audit log down");
    expect(warnings[0].ctx.key).toBe("k");
    expect(core.completed).toBe(true);
    expect(core.error).toBeNull();
  });

  it("fatal hook (default) still aborts even when a later hook is non-fatal", async () => {
    await core.requestUpload("k", 1);
    const seen: string[] = [];
    core.registerPostProcess(() => { throw new Error("gate fail"); }); // fatal default
    core.registerPostProcess(() => { seen.push("never"); }, { fatal: false });
    await expect(core.complete("k", "et")).rejects.toThrow("gate fail");
    expect(seen).toEqual([]);
  });

  it("complete refuses key mismatch", async () => {
    await core.requestUpload("a", 1);
    await expect(core.complete("b", "x")).rejects.toThrow(/key mismatch/);
  });

  it("complete refuses when no upload is active", async () => {
    await expect(core.complete("k", "x")).rejects.toThrow(/without an active upload/);
  });

  it("complete validates against the upload snapshot key, not the mutable _key slot", async () => {
    // Regression guard: previously, `complete()` checked `key !== this._key`.
    // `requestDownload(otherKey)` is a legal public command and calls
    // `_setKey(otherKey)` — so a download issued mid-upload would clobber
    // `this._key` and cause the subsequent (correct) `complete(uploadKey, ...)`
    // to fail with a spurious "key mismatch". The fix captures the key in
    // `_singleUpload` at requestUpload time and validates against that.
    await core.requestUpload("upload.bin", 1);
    // Simulate an unrelated download issued while the upload is in flight.
    // `presignDownload` setter inside `requestDownload` mutates `_key` to
    // "other.bin", which would have broken the old validator.
    await core.requestDownload("other.bin");
    // The mutable slot is now wrong, but completion with the original key
    // must still succeed because the snapshot remembers "upload.bin".
    const url = await core.complete("upload.bin", "etag-1");
    expect(url).toContain("upload.bin");
    expect(core.completed).toBe(true);
  });

  it("complete rejects the download's key after an interleaving requestDownload", async () => {
    // Mirror of the test above: passing the key that `requestDownload` left
    // in `this._key` must NOT accidentally be accepted. The snapshot is the
    // sole source of truth for "what upload is this completing".
    await core.requestUpload("upload.bin", 1);
    await core.requestDownload("other.bin");
    await expect(core.complete("other.bin", "etag")).rejects.toThrow(/key mismatch: expected upload.bin/);
  });

  it("registerPostProcess returns a disposer", async () => {
    await core.requestUpload("k", 1);
    const seen: string[] = [];
    const dispose = core.registerPostProcess(() => { seen.push("x"); });
    dispose();
    await core.complete("k", "e");
    expect(seen).toEqual([]);
  });

  it("abort drops in-flight uploads silently (stale generation)", async () => {
    await core.requestUpload("k1", 100);
    core.abort();
    expect(core.uploading).toBe(false);
    expect(core.progress.phase).toBe("idle");
    // Stale completion is dropped without throwing.
    // (We cannot call complete because uploading=false fails the precheck —
    // verify by starting a new upload and ensuring generation skip works.)
    await core.requestUpload("k2", 100);
    const slowHook = vi.fn(async () => {
      // Bump generation mid-hook.
      core.abort();
    });
    core.registerPostProcess(slowHook);
    const url = await core.complete("k2", "e");
    expect(slowHook).toHaveBeenCalled();
    expect(url).toBe(""); // stale generation -> empty
  });

  it("requestDownload returns a presigned GET URL", async () => {
    const r = await core.requestDownload("foo.txt");
    expect(r.url).toBe("https://example.com/download/foo.txt");
    expect(core.url).toBe(r.url);
    expect(core.key).toBe("foo.txt");
  });

  it("deleteObject clears state for the matching key", async () => {
    await core.requestUpload("k", 5);
    await core.complete("k", "e");
    expect(core.url).not.toBe("");
    await core.deleteObject("k");
    expect(provider.deleteCalls).toHaveLength(1);
    expect(core.url).toBe("");
    expect(core.etag).toBe("");
    expect(core.completed).toBe(false);
  });

  it("deleteObject surfaces provider errors", async () => {
    provider.deleteError = new Error("nope");
    await expect(core.deleteObject("k")).rejects.toThrow("nope");
    expect(core.error).toBeInstanceOf(Error);
    expect(core.loading).toBe(false);
  });

  it("mid-upload deleteObject(sameKey) does NOT strip size/contentType from the post-process ctx", async () => {
    // Regression guard: `deleteObject` clears `this._metadata` when the
    // key matches. Before the fix, the single-PUT `complete()` built its
    // post-process ctx by reading `this._metadata?.size` etc. directly, so
    // a caller that raced a same-key `deleteObject` against their own
    // upload saw the hook receive `size: undefined`, `contentType:
    // undefined` — a silent integrity failure for any downstream code
    // (DB inserts, virus scans) that relies on those fields. The fix
    // snapshots size/contentType on `_singleUpload` at requestUpload time
    // so the ctx is derived from the upload's actual parameters.
    await core.requestUpload("asset.bin", 4096, "application/octet-stream");
    // Racy same-key delete (e.g. a UI button handler, a dedup pass, or a
    // stale cleanup task). Metadata is cleared by side-effect of this call.
    await core.deleteObject("asset.bin");
    expect(core.metadata).toBeNull(); // demonstrates the cleared side-channel
    const received: any[] = [];
    core.registerPostProcess(ctx => { received.push({ ...ctx }); });
    await core.complete("asset.bin", "etag-xyz");
    expect(received).toHaveLength(1);
    expect(received[0].size).toBe(4096);
    expect(received[0].contentType).toBe("application/octet-stream");
    expect(received[0].etag).toBe("etag-xyz");
    expect(received[0].key).toBe("asset.bin");
  });

  it("requestUpload validates size", async () => {
    await expect(core.requestUpload("k", -1)).rejects.toThrow(/size/);
  });

  it("passes prefix and contentType through to provider", async () => {
    core.prefix = "user/123";
    core.contentType = "image/png";
    await core.requestUpload("avatar.png", 10);
    const opts = provider.uploadCalls[0].opts;
    expect(opts.prefix).toBe("user/123");
    expect(opts.contentType).toBe("image/png");
  });

  describe("single-PUT option snapshot", () => {
    // Mirror of the multipart "option snapshot semantics" suite — covers the
    // single-PUT path. complete() must use the bucket/prefix that were active
    // at requestUpload time, not the current input values.
    it("complete uses snapshot bucket for the post-process hook ctx", async () => {
      core.bucket = "bucket-A";
      core.prefix = "a/";
      await core.requestUpload("k", 100, "text/plain");
      // Mutate inputs after requestUpload — the hook must still see bucket-A.
      core.bucket = "bucket-B";
      core.prefix = "b/";
      let seenBucket = "";
      core.registerPostProcess((ctx) => { seenBucket = ctx.bucket; });
      await core.complete("k", "etag");
      expect(seenBucket).toBe("bucket-A");
    });

    it("complete's presignDownload targets the snapshot bucket/prefix", async () => {
      core.bucket = "bucket-A";
      core.prefix = "a/";
      await core.requestUpload("k", 100);
      core.bucket = "bucket-B";
      core.prefix = "b/";
      await core.complete("k", "etag");
      expect(provider.downloadCalls).toHaveLength(1);
      expect(provider.downloadCalls[0].opts).toEqual(expect.objectContaining({
        bucket: "bucket-A", prefix: "a/",
      }));
    });

    it("a fresh requestUpload clears the prior single-upload snapshot", async () => {
      // After a successful complete the snapshot must already be cleared, so
      // a subsequent complete (without a fresh requestUpload) errors out
      // properly rather than silently consuming stale options.
      await core.requestUpload("k1", 1);
      await core.complete("k1", "e1");
      // No active upload now — the precheck should fire.
      await expect(core.complete("k1", "e2")).rejects.toThrow(/without an active upload/);
    });

    it("abort() clears the single-upload snapshot too", async () => {
      await core.requestUpload("k", 100);
      core.abort();
      // Cannot complete after abort — precheck should fail (uploading=false).
      await expect(core.complete("k", "x")).rejects.toThrow(/without an active upload/);
    });

    it("a failed presignUpload does NOT capture a snapshot", async () => {
      provider.presignError = new Error("nope");
      await expect(core.requestUpload("k", 1)).rejects.toThrow("nope");
      // _singleUpload should still be null; complete() can't be reached anyway
      // (uploading=false), but verify defensively by trying a fresh upload
      // path that succeeds — the failed presign must not have left side state.
      provider.presignError = null;
      core.bucket = "bucket-A";
      core.prefix = "a/";
      await core.requestUpload("k", 1);
      await core.complete("k", "e");
      // Download call uses the fresh-upload snapshot, not anything left over.
      expect(provider.downloadCalls.at(-1)?.opts).toEqual(expect.objectContaining({
        bucket: "bucket-A", prefix: "a/",
      }));
    });
  });
});
