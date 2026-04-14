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
});
