import { describe, it, expect, beforeAll } from "vitest";
import { S3 } from "../src/components/S3";
import { S3Core } from "../src/core/S3Core";
import {
  IS3Provider, S3RequestOptions, PresignedUpload, PresignedDownload, MultipartPart,
} from "../src/types";

class FakeProvider implements IS3Provider {
  async presignUpload(key: string, _opts: S3RequestOptions): Promise<PresignedUpload> {
    return { url: `https://example/upload/${key}`, method: "PUT", headers: {}, expiresAt: Date.now() + 60_000 };
  }
  async presignDownload(key: string, _opts: S3RequestOptions): Promise<PresignedDownload> {
    return { url: `https://example/download/${key}`, method: "GET", expiresAt: Date.now() + 60_000 };
  }
  async deleteObject(_key: string, _opts: S3RequestOptions): Promise<void> {}
  async initiateMultipart(_key: string, _opts: S3RequestOptions): Promise<{ uploadId: string }> {
    return { uploadId: "u1" };
  }
  async presignPart(_key: string, _uploadId: string, _partNumber: number, _opts: S3RequestOptions): Promise<PresignedUpload> {
    return { url: "https://example/part", method: "PUT", headers: {}, expiresAt: Date.now() + 60_000 };
  }
  async completeMultipart(_key: string, _uploadId: string, _parts: MultipartPart[], _opts: S3RequestOptions): Promise<{ etag: string }> {
    return { etag: "merged" };
  }
  async abortMultipart(_key: string, _uploadId: string, _opts: S3RequestOptions): Promise<void> {}
}

beforeAll(() => {
  if (!customElements.get("s3-uploader")) customElements.define("s3-uploader", S3);
});

describe("S3 key input/output semantics", () => {
  it("reads resolved key from Core state when available", async () => {
    const s3 = document.createElement("s3-uploader") as S3;
    const core = new S3Core(new FakeProvider());
    core.bucket = "b";
    s3.attachLocalCore(core);

    expect(s3.key).toBe("");
    await core.requestUpload("resolved.txt", 1, "text/plain");
    expect(s3.key).toBe("resolved.txt");
  });

  it("derives upload key from requested key, not previous resolved key", async () => {
    const s3 = document.createElement("s3-uploader") as S3;
    const core = new S3Core(new FakeProvider());
    core.bucket = "b";
    s3.attachLocalCore(core);

    await core.requestUpload("previous.txt", 1, "text/plain");
    s3.setAttribute("key", "next.txt");

    const derived = (s3 as any)._deriveKey(new Blob(["x"]));
    expect(derived).toBe("next.txt");
  });
});
