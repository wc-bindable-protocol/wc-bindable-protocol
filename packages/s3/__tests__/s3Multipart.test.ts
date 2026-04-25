import { describe, it, expect, beforeEach, vi } from "vitest";
import { S3Core } from "../src/core/S3Core";
import {
  IS3Provider, S3RequestOptions, PresignedUpload, PresignedDownload, MultipartPart,
} from "../src/types";

class MultipartFakeProvider implements IS3Provider {
  initiateCalls: Array<{ key: string }> = [];
  partCalls: Array<{ partNumber: number }> = [];
  completeCalls: Array<{ uploadId: string; parts: MultipartPart[] }> = [];
  abortCalls: Array<{ uploadId: string }> = [];
  initiateError: Error | null = null;
  presignPartError: Error | null = null;
  completeError: Error | null = null;
  uploadId = "mp-1";

  async presignUpload(_k: string, _o: S3RequestOptions): Promise<PresignedUpload> {
    return { url: "x", method: "PUT", headers: {}, expiresAt: 0 };
  }
  async presignDownload(key: string, _o: S3RequestOptions): Promise<PresignedDownload> {
    return { url: `https://download/${key}`, method: "GET", expiresAt: 0 };
  }
  async deleteObject(_k: string, _o: S3RequestOptions): Promise<void> {}

  async initiateMultipart(key: string, _o: S3RequestOptions): Promise<{ uploadId: string }> {
    if (this.initiateError) throw this.initiateError;
    this.initiateCalls.push({ key });
    return { uploadId: this.uploadId };
  }

  async presignPart(_k: string, _uid: string, partNumber: number, _o: S3RequestOptions): Promise<PresignedUpload> {
    if (this.presignPartError) throw this.presignPartError;
    this.partCalls.push({ partNumber });
    return { url: `https://part/${partNumber}`, method: "PUT", headers: {}, expiresAt: 0 };
  }

  async completeMultipart(_k: string, uploadId: string, parts: MultipartPart[], _o: S3RequestOptions): Promise<{ etag: string }> {
    if (this.completeError) throw this.completeError;
    this.completeCalls.push({ uploadId, parts });
    return { etag: "merged-etag" };
  }

  async abortMultipart(_k: string, uploadId: string, _o: S3RequestOptions): Promise<void> {
    this.abortCalls.push({ uploadId });
  }
}

const MIB = 1024 * 1024;

describe("S3Core multipart", () => {
  let provider: MultipartFakeProvider;
  let core: S3Core;

  beforeEach(() => {
    provider = new MultipartFakeProvider();
    core = new S3Core(provider);
    core.bucket = "test-bucket";
  });

  it("declares multipart commands in wcBindable", () => {
    const names = (S3Core.wcBindable.commands ?? []).map(c => c.name);
    expect(names).toContain("requestMultipartUpload");
    expect(names).toContain("completeMultipart");
    expect(names).toContain("abortMultipart");
  });

  it("requestMultipartUpload returns presigned parts and tracks upload state", async () => {
    const size = 20 * MIB; // 20 MiB at 8 MiB part size = 3 parts
    const init = await core.requestMultipartUpload("big.bin", size, "application/octet-stream");
    expect(init.uploadId).toBe("mp-1");
    expect(init.partSize).toBe(8 * MIB);
    expect(init.parts).toHaveLength(3);
    expect(init.parts[0].range).toEqual([0, 8 * MIB]);
    expect(init.parts[1].range).toEqual([8 * MIB, 16 * MIB]);
    expect(init.parts[2].range).toEqual([16 * MIB, size]);
    expect(init.parts.every((p, i) => p.partNumber === i + 1)).toBe(true);
    expect(core.uploading).toBe(true);
    expect(core.key).toBe("big.bin");
    expect(provider.partCalls.map(c => c.partNumber)).toEqual([1, 2, 3]);
  });

  it("auto-scales partSize so part count stays under 10000", async () => {
    // 100 GiB, requested partSize 1 byte → must scale to fit S3's 10k-part cap.
    const size = 100 * 1024 * MIB;
    const init = await core.requestMultipartUpload("huge.bin", size, undefined, 1);
    expect(init.parts.length).toBeLessThanOrEqual(10000);
    expect(init.partSize).toBeGreaterThanOrEqual(size / 9999);
  });

  it("rejects size <= 0", async () => {
    await expect(core.requestMultipartUpload("k", 0)).rejects.toThrow(/size/);
  });

  it("aborts the orphaned multipart if presignPart fails mid-init", async () => {
    let count = 0;
    const origPresign = provider.presignPart.bind(provider);
    provider.presignPart = async (k, uid, n, o) => {
      count++;
      if (count > 1) throw new Error("presign part 2 failed");
      return origPresign(k, uid, n, o);
    };
    await expect(core.requestMultipartUpload("k", 20 * MIB)).rejects.toThrow(/presign/);
    expect(provider.abortCalls).toHaveLength(1);
    expect(provider.abortCalls[0].uploadId).toBe("mp-1");
    expect(core.uploading).toBe(false);
  });

  it("completeMultipart calls hooks then exposes a download URL", async () => {
    await core.requestMultipartUpload("k", 20 * MIB);
    const seen: string[] = [];
    core.registerPostProcess(({ etag }) => { seen.push(`hook:${etag}`); });
    const url = await core.completeMultipart("k", "mp-1", [
      { partNumber: 1, etag: "\"a\"" },
      { partNumber: 2, etag: "\"b\"" },
      { partNumber: 3, etag: "\"c\"" },
    ]);
    expect(provider.completeCalls).toHaveLength(1);
    expect(provider.completeCalls[0].parts).toHaveLength(3);
    expect(seen).toEqual(["hook:merged-etag"]);
    expect(url).toBe("https://download/k");
    expect(core.url).toBe(url);
    expect(core.completed).toBe(true);
    expect(core.uploading).toBe(false);
    expect(core.etag).toBe("merged-etag");
  });

  it("mid-upload deleteObject(sameKey) does NOT strip size/contentType from the multipart post-process ctx", async () => {
    // Multipart counterpart to the single-PUT regression guard in
    // s3Core.test.ts. `deleteObject(key)` side-effects `this._metadata` to
    // null on key match, and the old code built the completeMultipart ctx
    // straight from `this._metadata?.size` / `.contentType`. A caller
    // (direct Core user or a misbehaving remote proxy client) that issued
    // `deleteObject("k")` between `requestMultipartUpload("k", ...)` and
    // `completeMultipart("k", ...)` saw the post-process hook receive
    // `undefined` for both, even though the upload itself merged fine on
    // S3. The fix snapshots size/contentType on `_multipart` at init time.
    await core.requestMultipartUpload("k", 20 * MIB, "image/png");
    await core.deleteObject("k");
    const received: any[] = [];
    core.registerPostProcess(ctx => { received.push({ ...ctx }); });
    await core.completeMultipart("k", "mp-1", [
      { partNumber: 1, etag: "\"a\"" },
      { partNumber: 2, etag: "\"b\"" },
      { partNumber: 3, etag: "\"c\"" },
    ]);
    expect(received).toHaveLength(1);
    expect(received[0].size).toBe(20 * MIB);
    expect(received[0].contentType).toBe("image/png");
    expect(received[0].etag).toBe("merged-etag");
    expect(received[0].key).toBe("k");
  });

  it("completeMultipart aborts on provider failure", async () => {
    await core.requestMultipartUpload("k", 20 * MIB);
    provider.completeError = new Error("merge failed");
    await expect(core.completeMultipart("k", "mp-1", [
      { partNumber: 1, etag: "a" }, { partNumber: 2, etag: "b" }, { partNumber: 3, etag: "c" },
    ])).rejects.toThrow("merge failed");
    expect(provider.abortCalls).toHaveLength(1);
    expect(provider.abortCalls[0].uploadId).toBe("mp-1");
    expect(core.uploading).toBe(false);
    expect(core.error).toBeInstanceOf(Error);
  });

  it("completeMultipart refuses key/uploadId mismatch", async () => {
    await core.requestMultipartUpload("k", 20 * MIB);
    await expect(core.completeMultipart("other", "mp-1", [{ partNumber: 1, etag: "a" }])).rejects.toThrow(/key mismatch/);
    await expect(core.completeMultipart("k", "wrong", [{ partNumber: 1, etag: "a" }])).rejects.toThrow(/uploadId mismatch/);
  });

  it("completeMultipart validates against _multipart.key snapshot, not mutable _key", async () => {
    // Regression guard, symmetric with the single-PUT complete() case.
    // `requestDownload` is a legal public command that mutates `_key` via
    // `_setKey`. If completeMultipart validated against `this._key` (the
    // previous behavior) and a download was issued mid-upload, the real
    // multipart's `completeMultipart(originalKey, ...)` would fail with a
    // spurious mismatch even though everything about the upload is fine.
    await core.requestMultipartUpload("big.bin", 20 * MIB);
    await core.requestDownload("unrelated.bin"); // clobbers `this._key`
    const url = await core.completeMultipart("big.bin", "mp-1", [
      { partNumber: 1, etag: "\"a\"" },
      { partNumber: 2, etag: "\"b\"" },
      { partNumber: 3, etag: "\"c\"" },
    ]);
    expect(url).toContain("big.bin");
    expect(core.completed).toBe(true);
  });

  it("complete() refuses to run while a multipart upload is active", async () => {
    // Regression guard: `complete()` is the single-PUT finalizer. During a
    // multipart, `_uploading` is true but `_singleUpload` is null, so the
    // old code fell through to `_baseRequestOptions()` — silently routing
    // the post-process ctx.bucket and the download GET presign to CURRENT
    // inputs instead of the multipart's snapshotted bucket/prefix. This
    // test pins the misuse detection: complete() must throw and must NOT
    // overwrite the download URL or call presignDownload.
    await core.requestMultipartUpload("big.bin", 20 * MIB);
    // Mutate inputs so current values differ from the snapshot — if the
    // fix regresses, this is what would leak into the (wrong) code path.
    core.bucket = "DIFFERENT-BUCKET";
    core.prefix = "injected/";
    await expect(core.complete("big.bin", "etag"))
      .rejects.toThrow(/multipart upload is active — use completeMultipart/);
    // Multipart tracking must remain intact so the caller can still call
    // completeMultipart() with the correct snapshot afterwards.
    expect((core as any)._multipart?.uploadId).toBe("mp-1");
    expect(core.uploading).toBe(true);

    // Actually perform the recovery. The misuse must not have poisoned the
    // in-flight multipart, so finalizing against the captured snapshot has
    // to succeed — and critically, the merge/presign must route to the
    // ORIGINAL bucket ("test-bucket"), not the mutated current inputs.
    const url = await core.completeMultipart("big.bin", "mp-1", [
      { partNumber: 1, etag: "\"a\"" },
      { partNumber: 2, etag: "\"b\"" },
      { partNumber: 3, etag: "\"c\"" },
    ]);
    expect(core.completed).toBe(true);
    expect(core.uploading).toBe(false);
    // `MultipartFakeProvider.presignDownload` returns `https://download/<key>`
    // without encoding the bucket, so this assertion pins completion rather
    // than routing. We still assert on internal state to catch a regression
    // where completeMultipart reached the wrong bucket/prefix: the
    // provider's completeCalls reflect the uploadId we snapshotted, not
    // anything derived from the mutated current inputs.
    expect(url).toContain("big.bin");
    expect(provider.completeCalls.at(-1)?.uploadId).toBe("mp-1");
  });

  it("completeMultipart rejects the download's key after an interleaving requestDownload", async () => {
    // Mirror: the mutable `this._key` now reads "unrelated.bin", but passing
    // that key to completeMultipart must still fail — the snapshot, not the
    // mutable slot, is the source of truth for what upload we are finishing.
    await core.requestMultipartUpload("big.bin", 20 * MIB);
    await core.requestDownload("unrelated.bin");
    await expect(core.completeMultipart("unrelated.bin", "mp-1", [
      { partNumber: 1, etag: "a" },
    ])).rejects.toThrow(/key mismatch: expected big.bin/);
  });

  it("completeMultipart refuses empty parts", async () => {
    await core.requestMultipartUpload("k", 20 * MIB);
    await expect(core.completeMultipart("k", "mp-1", [])).rejects.toThrow(/non-empty/);
  });

  it("completeMultipart refuses out-of-range partNumber (< 1, > 10000, non-integer)", async () => {
    // Catches the class of misuse that previously only surfaced as an S3
    // InvalidPart after a network round-trip. Early local failure is both
    // faster feedback and a better error message (points at the offending
    // index in the caller's parts array).
    await core.requestMultipartUpload("k", 20 * MIB);
    await expect(core.completeMultipart("k", "mp-1", [{ partNumber: 0, etag: "a" }]))
      .rejects.toThrow(/partNumber/);
    await expect(core.completeMultipart("k", "mp-1", [{ partNumber: 10001, etag: "a" }]))
      .rejects.toThrow(/partNumber/);
    await expect(core.completeMultipart("k", "mp-1", [{ partNumber: 1.5 as any, etag: "a" }]))
      .rejects.toThrow(/partNumber/);
    await expect(core.completeMultipart("k", "mp-1", [{ partNumber: -1, etag: "a" }]))
      .rejects.toThrow(/partNumber/);
  });

  it("completeMultipart refuses duplicate partNumbers", async () => {
    // Duplicates are a classic concurrency bug: two workers each think they
    // completed part N and both push to `completed[]`. S3 would return a
    // 400 after the round-trip, but the caller's stack trace is already
    // gone by then. Fail locally with the offending partNumber in the
    // message instead.
    await core.requestMultipartUpload("k", 20 * MIB);
    await expect(core.completeMultipart("k", "mp-1", [
      { partNumber: 1, etag: "a" },
      { partNumber: 1, etag: "b" },
    ])).rejects.toThrow(/duplicate partNumber 1/);
  });

  it("completeMultipart refuses empty or non-string etag", async () => {
    // The symmetric check to the single-PUT `MissingEtagError` path: a part
    // with no etag would serialize as `<ETag></ETag>` in the complete XML
    // and S3 returns InvalidPart. An S3-compatible store might not, so we
    // guard at the Core boundary to keep behavior uniform across providers.
    await core.requestMultipartUpload("k", 20 * MIB);
    await expect(core.completeMultipart("k", "mp-1", [{ partNumber: 1, etag: "" }]))
      .rejects.toThrow(/non-empty string/);
    await expect(core.completeMultipart("k", "mp-1", [{ partNumber: 1, etag: null as any }]))
      .rejects.toThrow(/non-empty string/);
    await expect(core.completeMultipart("k", "mp-1", [{ partNumber: 1, etag: 42 as any }]))
      .rejects.toThrow(/non-empty string/);
  });

  it("completeMultipart refuses non-object entries in parts", async () => {
    await core.requestMultipartUpload("k", 20 * MIB);
    await expect(core.completeMultipart("k", "mp-1", [null as any]))
      .rejects.toThrow(/parts\[0\] is not an object/);
  });

  it("completeMultipart never calls the provider when validation fails", async () => {
    // Fast-fail is only useful if it actually avoids the server round-trip.
    // Verify the provider's completeMultipart is not invoked on bad input.
    await core.requestMultipartUpload("k", 20 * MIB);
    const priorCalls = provider.completeCalls.length;
    await expect(core.completeMultipart("k", "mp-1", [{ partNumber: 0, etag: "a" }]))
      .rejects.toThrow();
    expect(provider.completeCalls.length).toBe(priorCalls);
  });

  it("completeMultipart refuses when no multipart is active", async () => {
    await expect(core.completeMultipart("k", "mp-1", [{ partNumber: 1, etag: "a" }])).rejects.toThrow(/without an active/);
  });

  it("abort() of an in-flight multipart fires abortMultipart", async () => {
    await core.requestMultipartUpload("k", 20 * MIB);
    core.abort();
    // abortMultipart is fire-and-forget; await a microtask so its catch handler attaches.
    await Promise.resolve();
    expect(provider.abortCalls.map(a => a.uploadId)).toContain("mp-1");
    expect(core.uploading).toBe(false);
    expect(core.progress.phase).toBe("idle");
  });

  it("abortMultipart command performs explicit cleanup", async () => {
    await core.requestMultipartUpload("k", 20 * MIB);
    await core.abortMultipart("k", "mp-1");
    expect(provider.abortCalls.map(a => a.uploadId)).toContain("mp-1");
    expect(core.uploading).toBe(false);
  });

  it("abortMultipart refuses a key mismatch against the tracked uploadId", async () => {
    // The regression this guards: when identifying the active multipart by
    // uploadId, the Core used to accept whatever `key` the caller passed
    // and forward it to the provider — tearing internal tracking down
    // while asking S3 to abort a DIFFERENT object path. Net effect: the
    // real multipart survives and keeps accruing storage cost, and the
    // Core believes it is gone. Symmetric with signMultipartPart and
    // completeMultipart, which already enforce this.
    await core.requestMultipartUpload("k", 20 * MIB);
    await expect(core.abortMultipart("wrong-key", "mp-1"))
      .rejects.toThrow(/key mismatch: expected k, got wrong-key/);
    // Must NOT have torn tracking down — the caller can retry with the
    // correct key (or fall back to abort()) once they notice the error.
    expect(core.uploading).toBe(true);
    expect((core as any)._multipart?.uploadId).toBe("mp-1");
    // And we must NOT have asked the provider to abort the wrong key.
    expect(provider.abortCalls).toHaveLength(0);
  });

  it("abortMultipart still accepts an untracked (key, uploadId) pair", async () => {
    // Counterpart to the mismatch test: when the Core does NOT track this
    // uploadId, we have no snapshot to validate against, and the existing
    // contract is that the caller is responsible for the arguments. A
    // caller recovering a stale uploadId from external state must still
    // be able to ask S3 to clean it up.
    await core.abortMultipart("external-key", "external-uploadId");
    expect(provider.abortCalls).toEqual([{ uploadId: "external-uploadId" }]);
  });

  it("a fresh requestMultipartUpload aborts the prior multipart on S3 (different key)", async () => {
    // Mid-flight multipart for k1, then a new multipart for k2 starts without
    // any explicit abort() in between. The Core must fire abortMultipart for
    // the k1 uploadId — otherwise S3 keeps the orphan parts and bills for them.
    await core.requestMultipartUpload("k1", 20 * MIB);
    provider.uploadId = "mp-2";
    await core.requestMultipartUpload("k2", 20 * MIB);
    // Best-effort cleanup is fire-and-forget; let microtasks drain.
    await Promise.resolve();
    expect(provider.abortCalls).toHaveLength(1);
    expect(provider.abortCalls[0]).toEqual({ uploadId: "mp-1" });
    // The new multipart is fully set up under the new uploadId.
    expect(core.key).toBe("k2");
  });

  it("a fresh requestUpload aborts the prior multipart on S3 too", async () => {
    // Edge case: the user switches from a multipart-sized file to a small one
    // mid-flight. requestUpload (not requestMultipartUpload) must still clean
    // up the orphan multipart.
    await core.requestMultipartUpload("k1", 20 * MIB);
    await core.requestUpload("k2", 100);
    await Promise.resolve();
    expect(provider.abortCalls).toHaveLength(1);
    expect(provider.abortCalls[0]).toEqual({ uploadId: "mp-1" });
  });

  it("requestMultipartUpload without a prior multipart does NOT call abortMultipart", async () => {
    await core.requestMultipartUpload("k", 20 * MIB);
    expect(provider.abortCalls).toHaveLength(0);
  });

  it("multipart parts carry the provider's expiresAt so the Shell can refresh near-expiry URLs", async () => {
    const now = Date.now();
    provider.presignPart = async (_k, _uid, partNumber, _o) => {
      provider.partCalls.push({ partNumber });
      // Deliberately short TTL: the Shell needs this value to decide whether
      // to eagerly re-sign before PUTing. Without `expiresAt` propagating
      // through `MultipartPartUrl`, a large multipart that spans past the
      // initial window would 403 on its tail parts.
      return { url: `https://part/${partNumber}`, method: "PUT", headers: {}, expiresAt: now + 5_000 };
    };
    const init = await core.requestMultipartUpload("big.bin", 20 * MIB);
    expect(init.parts.every(p => typeof p.expiresAt === "number")).toBe(true);
    expect(init.parts[0].expiresAt).toBeGreaterThan(now);
    expect(init.parts[0].expiresAt).toBeLessThan(now + 10_000);
  });

  it("signMultipartPart re-presigns a single part against the active uploadId", async () => {
    await core.requestMultipartUpload("k", 20 * MIB);
    const before = provider.partCalls.length;
    const refreshed = await core.signMultipartPart("k", "mp-1", 2);
    expect(refreshed.url).toBe("https://part/2");
    expect(provider.partCalls.length).toBe(before + 1);
    expect(provider.partCalls[provider.partCalls.length - 1].partNumber).toBe(2);
  });

  it("signMultipartPart refuses when no multipart is active", async () => {
    await expect(core.signMultipartPart("k", "mp-1", 1)).rejects.toThrow(/without an active/);
  });

  it("signMultipartPart refuses a mismatched uploadId or key", async () => {
    await core.requestMultipartUpload("k", 20 * MIB);
    await expect(core.signMultipartPart("k", "wrong-id", 1)).rejects.toThrow(/uploadId mismatch/);
    await expect(core.signMultipartPart("other", "mp-1", 1)).rejects.toThrow(/key mismatch/);
  });

  it("forwards provider-supplied per-part headers through to MultipartPartUrl", async () => {
    // Providers that need SSE-C / custom auth / anything beyond a plain PUT
    // return per-part headers via PresignedUpload.headers. Dropping them at
    // the Core/Shell boundary (as an earlier revision did) silently broke any
    // non-default IS3Provider on the multipart path while single-PUT kept
    // working, which is the exact asymmetry the review flagged.
    provider.presignPart = async (_k, uid, partNumber, _o) => {
      provider.partCalls.push({ partNumber });
      return {
        url: `https://part/${partNumber}`,
        method: "PUT",
        headers: {
          "x-amz-server-side-encryption-customer-algorithm": "AES256",
          "x-amz-server-side-encryption-customer-key-md5": `k-${partNumber}-${uid}`,
        },
        expiresAt: Date.now() + 60_000,
      };
    };
    const init = await core.requestMultipartUpload("k", 20 * MIB);
    expect(init.parts).toHaveLength(3);
    for (const p of init.parts) {
      expect(p.headers?.["x-amz-server-side-encryption-customer-algorithm"]).toBe("AES256");
      expect(p.headers?.["x-amz-server-side-encryption-customer-key-md5"]).toBe(`k-${p.partNumber}-mp-1`);
    }
  });

  it("omits the headers field when the provider returns no extra headers", async () => {
    // Keep the wire payload minimal when there is nothing to forward. The
    // Shell treats missing `headers` as "empty", so the init response should
    // not carry an empty object for every part on the common AWS SigV4 path.
    const init = await core.requestMultipartUpload("k", 20 * MIB);
    for (const p of init.parts) {
      expect(p.headers).toBeUndefined();
    }
  });

  it("signMultipartPart surfaces refreshed headers to the Shell", async () => {
    // Some providers rotate signed headers on every presign (e.g. SSE-C key
    // material bound to the signature). The re-sign path in the Shell reads
    // `refreshed.headers`, so the Core must expose the full PresignedUpload.
    let calls = 0;
    provider.presignPart = async (_k, _u, partNumber, _o) => {
      provider.partCalls.push({ partNumber });
      calls++;
      return {
        url: `https://part/${partNumber}`,
        method: "PUT",
        headers: { "x-custom-header": `v${calls}` },
        expiresAt: Date.now() + 60_000,
      };
    };
    await core.requestMultipartUpload("k", 20 * MIB);
    const refreshed = await core.signMultipartPart("k", "mp-1", 2);
    expect(refreshed.headers?.["x-custom-header"]).toMatch(/^v\d+$/);
  });
});

describe("S3Core multipart — option snapshot semantics", () => {
  // The provider here records the options it was called with so we can assert
  // that prior-cleanup, completeMultipart, and presignDownload all see the
  // bucket/prefix that were active *at init time*, not whatever the inputs
  // hold now.
  class RecordingProvider implements IS3Provider {
    initiateOpts: S3RequestOptions[] = [];
    completeOpts: S3RequestOptions[] = [];
    abortOpts: Array<{ uploadId: string; opts: S3RequestOptions }> = [];
    downloadOpts: S3RequestOptions[] = [];
    nextUploadId = "mp-1";

    async presignUpload(_k: string, _o: S3RequestOptions): Promise<PresignedUpload> {
      return { url: "x", method: "PUT", headers: {}, expiresAt: 0 };
    }
    async presignDownload(k: string, o: S3RequestOptions): Promise<PresignedDownload> {
      this.downloadOpts.push({ ...o });
      return { url: `https://download/${o.prefix ?? ""}_${k}`, method: "GET", expiresAt: 0 };
    }
    async deleteObject(_k: string, _o: S3RequestOptions): Promise<void> {}
    async initiateMultipart(_k: string, o: S3RequestOptions): Promise<{ uploadId: string }> {
      this.initiateOpts.push({ ...o });
      return { uploadId: this.nextUploadId };
    }
    async presignPart(_k: string, _u: string, _n: number, _o: S3RequestOptions): Promise<PresignedUpload> {
      return { url: "x", method: "PUT", headers: {}, expiresAt: 0 };
    }
    async completeMultipart(_k: string, _u: string, _p: MultipartPart[], o: S3RequestOptions): Promise<{ etag: string }> {
      this.completeOpts.push({ ...o });
      return { etag: "merged" };
    }
    async abortMultipart(_k: string, uploadId: string, o: S3RequestOptions): Promise<void> {
      this.abortOpts.push({ uploadId, opts: { ...o } });
    }
  }

  let provider: RecordingProvider;
  let core: S3Core;

  beforeEach(() => {
    provider = new RecordingProvider();
    core = new S3Core(provider);
    core.bucket = "bucket-A";
    core.prefix = "a/";
  });

  it("prior-multipart cleanup uses the bucket/prefix the upload was started with", async () => {
    // Start an upload under (bucket-A, a/). Mutate inputs. Start a second.
    // The cleanup of the first MUST hit (bucket-A, a/), not the new values.
    await core.requestMultipartUpload("k1", 20 * MIB);
    core.bucket = "bucket-B";
    core.prefix = "b/";
    provider.nextUploadId = "mp-2";
    await core.requestMultipartUpload("k2", 20 * MIB);
    await Promise.resolve();

    expect(provider.abortOpts).toHaveLength(1);
    expect(provider.abortOpts[0]).toEqual({
      uploadId: "mp-1",
      opts: expect.objectContaining({ bucket: "bucket-A", prefix: "a/" }),
    });
    // And the second multipart was initiated under the new values.
    expect(provider.initiateOpts[1]).toEqual(expect.objectContaining({
      bucket: "bucket-B", prefix: "b/",
    }));
  });

  it("abort() of an in-flight multipart uses the snapshot options", async () => {
    await core.requestMultipartUpload("k1", 20 * MIB);
    core.bucket = "bucket-B";
    core.prefix = "b/";
    core.abort();
    await Promise.resolve();
    expect(provider.abortOpts).toHaveLength(1);
    expect(provider.abortOpts[0].opts).toEqual(expect.objectContaining({
      bucket: "bucket-A", prefix: "a/",
    }));
  });

  it("completeMultipart and the download presign both use the snapshot options", async () => {
    await core.requestMultipartUpload("k", 20 * MIB);
    // Mutate after init — the complete + GET presign must still target the
    // path the bytes actually live at.
    core.bucket = "bucket-B";
    core.prefix = "b/";
    const url = await core.completeMultipart("k", "mp-1", [
      { partNumber: 1, etag: "a" }, { partNumber: 2, etag: "b" }, { partNumber: 3, etag: "c" },
    ]);
    expect(provider.completeOpts).toHaveLength(1);
    expect(provider.completeOpts[0]).toEqual(expect.objectContaining({
      bucket: "bucket-A", prefix: "a/",
    }));
    expect(provider.downloadOpts).toHaveLength(1);
    expect(provider.downloadOpts[0]).toEqual(expect.objectContaining({
      bucket: "bucket-A", prefix: "a/",
    }));
    // Download URL was computed against the old prefix, not the current b/.
    expect(url).toBe("https://download/a/_k");
  });

  it("explicit abortMultipart command uses snapshot when uploadId matches the active one", async () => {
    await core.requestMultipartUpload("k", 20 * MIB);
    core.prefix = "b/";
    await core.abortMultipart("k", "mp-1");
    expect(provider.abortOpts).toHaveLength(1);
    expect(provider.abortOpts[0].opts).toEqual(expect.objectContaining({
      bucket: "bucket-A", prefix: "a/",
    }));
  });

  it("explicit abortMultipart for an unknown uploadId falls back to current inputs", async () => {
    // No active multipart; the caller is cleaning up a foreign uploadId they
    // tracked themselves. We have no snapshot, so current bucket/prefix wins.
    core.prefix = "b/";
    await core.abortMultipart("k", "external-id");
    expect(provider.abortOpts).toHaveLength(1);
    expect(provider.abortOpts[0].opts).toEqual(expect.objectContaining({
      bucket: "bucket-A", prefix: "b/",
    }));
  });
});
