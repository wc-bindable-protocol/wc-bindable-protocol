import { describe, it, expect } from "vitest";
import { presignS3Url, SkewError } from "../src/signing/sigv4";

describe("presignS3Url (SigV4)", () => {
  // AWS-published reference vector for "Get a presigned URL using query parameters".
  // See: AWS S3 API documentation, sigv4 examples (GET object, query auth).
  const awsExample = {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };

  it("matches AWS reference signature for GET examplebucket/test.txt", async () => {
    // The AWS docs reference vector uses the legacy global host
    // examplebucket.s3.amazonaws.com (not the regional form). Pass an explicit
    // endpoint with virtual-hosted style to reproduce that exact host.
    const fixedNow = Date.UTC(2013, 4, 24, 0, 0, 0);
    const result = await presignS3Url(awsExample, {
      method: "GET",
      region: "us-east-1",
      bucket: "examplebucket",
      key: "test.txt",
      now: fixedNow,
      expiresInSeconds: 86400,
      endpoint: "https://s3.amazonaws.com",
      forcePathStyle: false,
    });
    const url = new URL(result.url);
    expect(url.host).toBe("examplebucket.s3.amazonaws.com");
    expect(url.pathname).toBe("/test.txt");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toBe("AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20130524T000000Z");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("86400");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
    );
  });

  it("default regional URL has the expected shape (no reference signature)", async () => {
    const result = await presignS3Url(awsExample, {
      method: "GET",
      region: "us-east-1",
      bucket: "examplebucket",
      key: "test.txt",
      now: 0,
      expiresInSeconds: 60,
    });
    const url = new URL(result.url);
    expect(url.host).toBe("examplebucket.s3.us-east-1.amazonaws.com");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("includes session token in signed query when provided", async () => {
    const result = await presignS3Url({
      ...awsExample,
      sessionToken: "FAKE/TOKEN+with=chars",
    }, {
      method: "PUT",
      region: "us-east-1",
      bucket: "b",
      key: "k",
      now: Date.UTC(2024, 0, 1),
      expiresInSeconds: 60,
    });
    const url = new URL(result.url);
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe("FAKE/TOKEN+with=chars");
  });

  it("uses path-style URL when forcePathStyle is true", async () => {
    const result = await presignS3Url(awsExample, {
      method: "GET",
      region: "us-east-1",
      bucket: "mybucket",
      key: "a/b.txt",
      now: 0,
      expiresInSeconds: 60,
      forcePathStyle: true,
    });
    const url = new URL(result.url);
    expect(url.host).toBe("s3.us-east-1.amazonaws.com");
    expect(url.pathname).toBe("/mybucket/a/b.txt");
  });

  it("uses custom endpoint with path-style by default", async () => {
    const result = await presignS3Url(awsExample, {
      method: "GET",
      region: "auto",
      bucket: "b",
      key: "k",
      now: 0,
      expiresInSeconds: 60,
      endpoint: "https://example-r2.example.com",
    });
    const url = new URL(result.url);
    expect(url.host).toBe("example-r2.example.com");
    expect(url.pathname).toBe("/b/k");
  });

  it("preserves endpoint pathname for reverse-proxy deployments (path-style)", async () => {
    // A common S3-compatible deployment shape: the store is mounted behind a
    // reverse proxy at `/storage`, and the SigV4 canonicalUri must include
    // that prefix for the signature (and for the actual HTTP request) to hit
    // the right URL. An earlier revision dropped `u.pathname`, so requests
    // went to `/bucket/key` on the proxy root and 404'd.
    const result = await presignS3Url(awsExample, {
      method: "GET",
      region: "auto",
      bucket: "b",
      key: "k",
      now: 0,
      expiresInSeconds: 60,
      endpoint: "https://example.com/storage",
    });
    const url = new URL(result.url);
    expect(url.host).toBe("example.com");
    expect(url.pathname).toBe("/storage/b/k");
  });

  it("preserves endpoint pathname with virtual-hosted style", async () => {
    // Less common but legal: a proxy that uses virtual-hosted addressing under
    // a path prefix. The prefix still belongs between the host and the key.
    const result = await presignS3Url(awsExample, {
      method: "GET",
      region: "auto",
      bucket: "b",
      key: "k",
      now: 0,
      expiresInSeconds: 60,
      endpoint: "https://example.com/storage",
      forcePathStyle: false,
    });
    const url = new URL(result.url);
    expect(url.host).toBe("b.example.com");
    expect(url.pathname).toBe("/storage/k");
  });

  it("treats a bare-origin endpoint (pathname '/') as having no prefix", async () => {
    // `new URL("https://example.com").pathname` is `/`, not `""`. The
    // pathname-preserving branch must not double-slash bucket URLs.
    const result = await presignS3Url(awsExample, {
      method: "GET",
      region: "auto",
      bucket: "b",
      key: "k",
      now: 0,
      expiresInSeconds: 60,
      endpoint: "https://example.com/",
    });
    const url = new URL(result.url);
    expect(url.pathname).toBe("/b/k");
  });

  it("rejects expiry above AWS 7-day limit loudly", async () => {
    // Prior behaviour silently clamped via `Math.min(..., 604800)` after an
    // `int32 | 0` coercion. 2^31 + 1 wraps negative and was then rescued by
    // `Math.max(1, ...)` to a 1-second lifetime — a silent UX bug where the
    // caller's stated intent ("valid for a week or so") produced a URL that
    // expired in one second. Reject any value over the AWS hard cap so the
    // caller sees the misuse instead of debugging an unexplained 403.
    await expect(presignS3Url(awsExample, {
      method: "GET",
      region: "us-east-1",
      bucket: "b",
      key: "k",
      now: 0,
      expiresInSeconds: 999999999,
    })).rejects.toThrow(/exceeds AWS limit/);
  });

  it("clamps expiry at the 604800 boundary", async () => {
    const result = await presignS3Url(awsExample, {
      method: "GET",
      region: "us-east-1",
      bucket: "b",
      key: "k",
      now: 0,
      expiresInSeconds: 604800,
    });
    const url = new URL(result.url);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("604800");
  });

  it("rejects non-finite expiry values", async () => {
    await expect(presignS3Url(awsExample, {
      method: "GET",
      region: "us-east-1",
      bucket: "b",
      key: "k",
      now: 0,
      expiresInSeconds: Number.NaN,
    })).rejects.toThrow(/finite/);
  });

  it("floors fractional expiry values", async () => {
    // Prior behaviour used `| 0` which both truncates AND wraps at 2^31.
    // `Math.trunc` keeps the truncation semantics for fractional values so
    // existing callers passing e.g. `3600.5` still get a usable 3600-s URL.
    const result = await presignS3Url(awsExample, {
      method: "GET",
      region: "us-east-1",
      bucket: "b",
      key: "k",
      now: 0,
      expiresInSeconds: 3600.9,
    });
    const url = new URL(result.url);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
  });

  it("rejects missing credentials", async () => {
    await expect(presignS3Url({ accessKeyId: "", secretAccessKey: "" }, {
      method: "GET", region: "us-east-1", bucket: "b", key: "k", expiresInSeconds: 60,
    })).rejects.toThrow();
  });

  describe("UTF-8 key encoding", () => {
    // S3 object keys are full UTF-8. The naive char-by-char encoder splits
    // surrogate pairs and either throws (URIError on lone surrogates from
    // emoji) or emits the wrong byte sequence. These tests pin the byte-level
    // encoding so any regression surfaces immediately.

    it("encodes a 4-byte emoji (😀 = U+1F600) as %F0%9F%98%80", async () => {
      const result = await presignS3Url(awsExample, {
        method: "PUT",
        region: "us-east-1",
        bucket: "b",
        key: "😀.png",
        now: 0,
        expiresInSeconds: 60,
      });
      const url = new URL(result.url);
      expect(url.pathname).toBe("/%F0%9F%98%80.png");
    });

    it("encodes a non-BMP CJK extension (𠮷 = U+20BB7) as %F0%A0%AE%B7", async () => {
      const result = await presignS3Url(awsExample, {
        method: "GET",
        region: "us-east-1",
        bucket: "b",
        key: "𠮷.txt",
        now: 0,
        expiresInSeconds: 60,
      });
      const url = new URL(result.url);
      expect(url.pathname).toBe("/%F0%A0%AE%B7.txt");
    });

    it("encodes 2-byte and 3-byte sequences (é, ñ, あ) per UTF-8", async () => {
      const result = await presignS3Url(awsExample, {
        method: "GET",
        region: "us-east-1",
        bucket: "b",
        key: "café/niño/あ.txt",
        now: 0,
        expiresInSeconds: 60,
      });
      const url = new URL(result.url);
      // / is preserved; é=C3 A9, ñ=C3 B1, あ=E3 81 82.
      expect(url.pathname).toBe("/caf%C3%A9/ni%C3%B1o/%E3%81%82.txt");
    });

    it("does NOT throw URIError for emoji keys (regression guard)", async () => {
      // Pre-fix this would throw `URIError: URI malformed` from the lone
      // surrogate handed to encodeURIComponent.
      await expect(presignS3Url(awsExample, {
        method: "PUT",
        region: "us-east-1",
        bucket: "b",
        key: "🚀/folder/file 1.png",
        now: 0,
        expiresInSeconds: 60,
      })).resolves.toBeDefined();
    });

    it("encodes spaces as %20 (not '+')", async () => {
      const result = await presignS3Url(awsExample, {
        method: "GET",
        region: "us-east-1",
        bucket: "b",
        key: "my file.txt",
        now: 0,
        expiresInSeconds: 60,
      });
      const url = new URL(result.url);
      // SigV4 mandates %20; '+' would be wrong (and would not match the canonical request).
      expect(url.pathname).toBe("/my%20file.txt");
    });

    it("preserves '/' in the key path while still encoding multibyte segments", async () => {
      const result = await presignS3Url(awsExample, {
        method: "GET",
        region: "us-east-1",
        bucket: "b",
        key: "user/😀/avatar.png",
        now: 0,
        expiresInSeconds: 60,
      });
      const url = new URL(result.url);
      expect(url.pathname).toBe("/user/%F0%9F%98%80/avatar.png");
    });

    it("signature is deterministic for a UTF-8 key (snapshot)", async () => {
      // Lock in a known signature for an emoji key so that any change to the
      // encoding (e.g. someone re-introduces the char-by-char form) is caught
      // at the signature level, not just at the path level.
      const result = await presignS3Url(awsExample, {
        method: "GET",
        region: "us-east-1",
        bucket: "examplebucket",
        key: "😀.png",
        now: Date.UTC(2024, 0, 1, 0, 0, 0),
        expiresInSeconds: 3600,
        endpoint: "https://s3.amazonaws.com",
        forcePathStyle: false,
      });
      const url = new URL(result.url);
      expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
      // The signature itself: deterministic for these inputs. Pinning it
      // catches any future encoder change that affects the canonical request.
      expect(url.searchParams.get("X-Amz-Signature")).toBe(
        "696eb4c0154dadb399b67b8fa61dc435a16b5907f324f515962fea161363729a"
      );
    });
  });

  describe("clock-skew guard", () => {
    const creds = {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    };

    it("throws SkewError when `now` drifts beyond `allowableClockSkewMs`", async () => {
      await expect(presignS3Url(creds, {
        method: "GET",
        region: "us-east-1",
        bucket: "b",
        key: "k",
        now: 1_000_000_000_000,
        referenceNow: 1_000_000_300_000, // +5 min
        allowableClockSkewMs: 60_000,    // tolerate 1 min
        expiresInSeconds: 60,
      })).rejects.toBeInstanceOf(SkewError);
    });

    it("signs normally when the drift is within tolerance", async () => {
      const result = await presignS3Url(creds, {
        method: "GET",
        region: "us-east-1",
        bucket: "b",
        key: "k",
        now: 1_000_000_000_000,
        referenceNow: 1_000_000_010_000, // +10 s
        allowableClockSkewMs: 60_000,
        expiresInSeconds: 60,
      });
      expect(new URL(result.url).searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    });

    it("extraQuery cannot override reserved X-Amz-* signature parameters", async () => {
      await expect(presignS3Url(creds, {
        method: "GET",
        region: "us-east-1",
        bucket: "b",
        key: "k",
        expiresInSeconds: 60,
        extraQuery: { "X-Amz-Credential": "forged" },
      })).rejects.toThrow(/reserved SigV4 parameter/);
    });

    it("rejects each reserved SigV4 query key (case-insensitive)", async () => {
      const reserved = [
        "x-amz-algorithm",
        "x-amz-credential",
        "x-amz-date",
        "x-amz-expires",
        "x-amz-signedheaders",
        "x-amz-security-token",
        "x-amz-signature",
      ];
      for (const lower of reserved) {
        await expect(presignS3Url(creds, {
          method: "GET",
          region: "us-east-1",
          bucket: "b",
          key: "k",
          expiresInSeconds: 60,
          extraQuery: { [lower]: "x" },
        })).rejects.toThrow(/reserved SigV4 parameter/);
        // Uppercase / mixed-case variant must also be rejected.
        const upper = lower.replace(/(^|-)[a-z]/g, m => m.toUpperCase());
        await expect(presignS3Url(creds, {
          method: "GET",
          region: "us-east-1",
          bucket: "b",
          key: "k",
          expiresInSeconds: 60,
          extraQuery: { [upper]: "x" },
        })).rejects.toThrow(/reserved SigV4 parameter/);
      }
    });

    it("allows legitimate x-amz-* request parameters (meta / SSE / ACL) in extraQuery", async () => {
      const result = await presignS3Url(creds, {
        method: "PUT",
        region: "us-east-1",
        bucket: "b",
        key: "k",
        expiresInSeconds: 60,
        extraQuery: {
          "x-amz-meta-userid": "u-123",
          "x-amz-server-side-encryption": "AES256",
          "x-amz-acl": "private",
        },
      });
      const params = new URL(result.url).searchParams;
      expect(params.get("x-amz-meta-userid")).toBe("u-123");
      expect(params.get("x-amz-server-side-encryption")).toBe("AES256");
      expect(params.get("x-amz-acl")).toBe("private");
      // Signature must still be present and well-formed — the legitimate
      // params are part of the canonical request and bound to the signature.
      expect(params.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
