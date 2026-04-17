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

  it("completeMultipart refuses empty parts", async () => {
    await core.requestMultipartUpload("k", 20 * MIB);
    await expect(core.completeMultipart("k", "mp-1", [])).rejects.toThrow(/non-empty/);
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
