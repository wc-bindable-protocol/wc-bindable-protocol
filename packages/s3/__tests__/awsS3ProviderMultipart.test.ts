import { describe, it, expect, vi, afterEach } from "vitest";
import { AwsS3Provider } from "../src/providers/AwsS3Provider";

const CREDS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

function mockResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    text: () => Promise.resolve(body),
    headers: new Headers(),
  } as unknown as Response;
}

describe("AwsS3Provider multipart", () => {
  afterEach(() => vi.restoreAllMocks());

  function newProvider() {
    return new AwsS3Provider({ region: "us-east-1", credentials: CREDS });
  }

  it("initiateMultipart POSTs to <key>?uploads and parses the UploadId from XML", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(
      `<?xml version="1.0" encoding="UTF-8"?>
       <InitiateMultipartUploadResult>
         <Bucket>b</Bucket><Key>k</Key>
         <UploadId>VXBsb2FkSUQtMQ==</UploadId>
       </InitiateMultipartUploadResult>`
    ));
    const p = newProvider();
    const out = await p.initiateMultipart("photo.jpg", { bucket: "my-bucket", contentType: "image/jpeg" });
    expect(out.uploadId).toBe("VXBsb2FkSUQtMQ==");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("image/jpeg");
    const u = new URL(url);
    expect(u.host).toBe("my-bucket.s3.us-east-1.amazonaws.com");
    expect(u.pathname).toBe("/photo.jpg");
    expect(u.searchParams.has("uploads")).toBe(true);
  });

  it("initiateMultipart parses namespaced UploadId tags", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(
      `<x:InitiateMultipartUploadResult><x:UploadId>NS-id</x:UploadId></x:InitiateMultipartUploadResult>`
    ));
    const out = await newProvider().initiateMultipart("k", { bucket: "b" });
    expect(out.uploadId).toBe("NS-id");
  });

  it("initiateMultipart throws on HTTP error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse("denied", 403));
    await expect(newProvider().initiateMultipart("k", { bucket: "b" })).rejects.toThrow(/403/);
  });

  it("presignPart returns a URL with partNumber + uploadId in query", async () => {
    const out = await newProvider().presignPart("k", "U1", 3, { bucket: "b" });
    const u = new URL(out.url);
    expect(out.method).toBe("PUT");
    expect(u.searchParams.get("partNumber")).toBe("3");
    expect(u.searchParams.get("uploadId")).toBe("U1");
  });

  it("presignPart validates partNumber range", async () => {
    const p = newProvider();
    await expect(p.presignPart("k", "U", 0, { bucket: "b" })).rejects.toThrow(/partNumber/);
    await expect(p.presignPart("k", "U", 10001, { bucket: "b" })).rejects.toThrow(/partNumber/);
  });

  it("completeMultipart POSTs sorted parts as quoted-ETag XML and parses the merged ETag", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init: any) => {
      captured.url = String(url);
      captured.init = init;
      return mockResponse(
        `<CompleteMultipartUploadResult><ETag>"abc-2"</ETag></CompleteMultipartUploadResult>`
      );
    });
    const out = await newProvider().completeMultipart("k", "U", [
      { partNumber: 2, etag: "et2" },
      { partNumber: 1, etag: "\"et1\"" },
    ], { bucket: "b" });
    expect(out.etag).toBe("abc-2");
    expect(captured.init?.method).toBe("POST");
    const body = String(captured.init?.body ?? "");
    // Parts must be in ascending PartNumber order with quoted ETags.
    expect(body).toBe(
      `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"et1"</ETag></Part><Part><PartNumber>2</PartNumber><ETag>"et2"</ETag></Part></CompleteMultipartUpload>`
    );
    expect(new URL(captured.url!).searchParams.get("uploadId")).toBe("U");
  });

  it("completeMultipart throws on S3 error body even when HTTP 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(
      `<Error><Code>InternalError</Code><Message>oops</Message></Error>`
    ));
    await expect(newProvider().completeMultipart("k", "U", [{ partNumber: 1, etag: "a" }], { bucket: "b" }))
      .rejects.toThrow(/InternalError/);
  });

  it("completeMultipart rejects empty parts list", async () => {
    await expect(newProvider().completeMultipart("k", "U", [], { bucket: "b" }))
      .rejects.toThrow(/at least one part/);
  });

  it("completeMultipart rejects a 200 response with no <ETag> tag", async () => {
    // An S3-compatible implementation (or a misbehaving proxy) can return
    // 200 without an `<Error>` body AND without an `<ETag>` tag. The old
    // code silently coerced the missing tag to "" and reported success,
    // which let the upload pass completion with a blank ETag — corrupting
    // every downstream integrity check and every post-process hook that
    // trusts `ctx.etag`. The caller must see this as a failure.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(
      `<CompleteMultipartUploadResult><Bucket>b</Bucket><Key>k</Key></CompleteMultipartUploadResult>`
    ));
    await expect(newProvider().completeMultipart("k", "U", [{ partNumber: 1, etag: "a" }], { bucket: "b" }))
      .rejects.toThrow(/no ETag/);
  });

  it("completeMultipart rejects a 200 response with an empty <ETag> tag", async () => {
    // `extractTag` matches `<ETag></ETag>` and returns "". That degenerate
    // form must fail for the same reason a missing tag does.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(
      `<CompleteMultipartUploadResult><ETag></ETag></CompleteMultipartUploadResult>`
    ));
    await expect(newProvider().completeMultipart("k", "U", [{ partNumber: 1, etag: "a" }], { bucket: "b" }))
      .rejects.toThrow(/no ETag/);
  });

  it("abortMultipart DELETEs <key>?uploadId=<id> and tolerates 404", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse("", 404));
    await expect(newProvider().abortMultipart("k", "U", { bucket: "b" })).resolves.toBeUndefined();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("DELETE");
    expect(new URL(url).searchParams.get("uploadId")).toBe("U");
  });

  it("abortMultipart throws on non-204/404 errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse("denied", 403));
    await expect(newProvider().abortMultipart("k", "U", { bucket: "b" })).rejects.toThrow(/403/);
  });

  it("abortMultipart accepts 200 and other 2xx responses", async () => {
    // Real S3 returns 204, but S3-compatible stores (and proxies in front of
    // real S3) sometimes return a plain 200 on abort. The `!res.ok` branch
    // already covers "anything non-success", but this pins the behaviour
    // that 200 specifically is not treated as an error — a prior revision
    // whitelisted only 204 and 404 explicitly and would have thrown on 200
    // even though the upload was correctly cancelled upstream.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse("", 200));
    await expect(newProvider().abortMultipart("k", "U", { bucket: "b" })).resolves.toBeUndefined();
  });
});
