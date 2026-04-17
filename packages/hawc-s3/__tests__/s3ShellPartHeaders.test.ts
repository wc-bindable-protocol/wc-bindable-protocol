import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { S3 } from "../src/components/S3";
import { S3Core } from "../src/core/S3Core";
import {
  IS3Provider, S3RequestOptions, PresignedUpload, PresignedDownload, MultipartPart,
} from "../src/types";

/**
 * Fake XHR that records every setRequestHeader call and auto-succeeds the
 * PUT on `send()`. Covers only the paths the Shell actually touches:
 * open / setRequestHeader / upload.addEventListener / add*Listener /
 * getResponseHeader / send / abort.
 *
 * Built from scratch (rather than piggy-backing on happy-dom's XHR) because
 * we need white-box visibility into the header list and zero real I/O.
 */
interface RecordedXhr {
  url: string;
  method: string;
  headers: Record<string, string>;
}

const recorded: RecordedXhr[] = [];

class FakeXhr {
  status = 200;
  statusText = "OK";
  responseText = "";
  upload = {
    addEventListener: (_name: string, _fn: (ev: any) => void) => { /* ignore progress */ },
  };
  private _method = "";
  private _url = "";
  private _headers: Record<string, string> = {};
  private _listeners: Record<string, Array<() => void>> = {};

  open(method: string, url: string, _async?: boolean): void {
    this._method = method;
    this._url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this._headers[name] = value;
  }
  addEventListener(name: string, handler: () => void): void {
    (this._listeners[name] ??= []).push(handler);
  }
  getResponseHeader(name: string): string | null {
    // S3 returns the part ETag on the PUT response. Quotes are expected.
    if (name === "ETag") return `"etag-for-${this._url.split("/").pop()}"`;
    return null;
  }
  send(_body: unknown): void {
    recorded.push({ url: this._url, method: this._method, headers: { ...this._headers } });
    // Defer so the caller has finished wiring up state before load fires.
    queueMicrotask(() => {
      for (const fn of this._listeners["load"] ?? []) fn();
    });
  }
  abort(): void {
    for (const fn of this._listeners["abort"] ?? []) fn();
  }
}

class HeaderProvider implements IS3Provider {
  async presignUpload(key: string, _o: S3RequestOptions): Promise<PresignedUpload> {
    return {
      url: `https://example/upload/${key}`,
      method: "PUT",
      headers: { "x-amz-server-side-encryption": "AES256" },
      expiresAt: Date.now() + 60_000,
    };
  }
  async presignDownload(key: string, _o: S3RequestOptions): Promise<PresignedDownload> {
    return { url: `https://example/download/${key}`, method: "GET", expiresAt: Date.now() + 60_000 };
  }
  async deleteObject(_k: string, _o: S3RequestOptions): Promise<void> {}
  async initiateMultipart(_k: string, _o: S3RequestOptions): Promise<{ uploadId: string }> {
    return { uploadId: "u1" };
  }
  async presignPart(_key: string, _uploadId: string, partNumber: number, _opts: S3RequestOptions): Promise<PresignedUpload> {
    return {
      url: `https://example/part/${partNumber}`,
      method: "PUT",
      headers: {
        "x-amz-server-side-encryption-customer-algorithm": "AES256",
        "x-amz-server-side-encryption-customer-key-md5": `md5-part-${partNumber}`,
      },
      expiresAt: Date.now() + 60_000,
    };
  }
  async completeMultipart(_k: string, _u: string, _p: MultipartPart[], _o: S3RequestOptions): Promise<{ etag: string }> {
    return { etag: "merged" };
  }
  async abortMultipart(_k: string, _u: string, _o: S3RequestOptions): Promise<void> {}
}

let originalXhr: typeof XMLHttpRequest;

beforeAll(() => {
  if (!customElements.get("hawc-s3")) customElements.define("hawc-s3", S3);
});

beforeEach(() => {
  originalXhr = globalThis.XMLHttpRequest;
  (globalThis as any).XMLHttpRequest = FakeXhr;
  recorded.length = 0;
});

afterEach(() => {
  (globalThis as any).XMLHttpRequest = originalXhr;
});

describe("S3 Shell applies presigned headers to the XHR", () => {
  it("single-PUT path echoes presigned headers on the PUT", async () => {
    // Baseline for symmetry: single-PUT already worked, but lock it in so the
    // multipart test below is meaningful against a known-good reference.
    const el = document.createElement("hawc-s3") as S3;
    const core = new S3Core(new HeaderProvider());
    core.bucket = "b";
    el.attachLocalCore(core);
    document.body.appendChild(el);
    try {
      el.file = new Blob(["small"]);
      await el.upload();
      const puts = recorded.filter(r => r.method === "PUT" && r.url.includes("/upload/"));
      expect(puts).toHaveLength(1);
      expect(puts[0].headers["x-amz-server-side-encryption"]).toBe("AES256");
    } finally {
      el.remove();
    }
  });

  it("multipart part PUTs echo per-part presigned headers (fix for the asymmetry)", async () => {
    // The regression guard. Before the fix, the Shell called
    // `_doPutOnce("PUT", url, {}, blob, ...)` with empty headers on every
    // part, so SSE-C or custom-auth providers failed multipart silently
    // while single-PUT worked. After the fix, each part PUT carries the
    // headers the provider returned for that specific part.
    const el = document.createElement("hawc-s3") as S3;
    // 20 MiB at the default 8 MiB threshold → 3 parts.
    const body = new Uint8Array(20 * 1024 * 1024);
    el.setAttribute("multipart-threshold", String(8 * 1024 * 1024));
    const core = new S3Core(new HeaderProvider());
    core.bucket = "b";
    el.attachLocalCore(core);
    document.body.appendChild(el);
    try {
      el.file = new Blob([body]);
      await el.upload();
      const partPuts = recorded.filter(r => r.url.startsWith("https://example/part/"));
      expect(partPuts).toHaveLength(3);
      for (const put of partPuts) {
        const partNumber = Number(put.url.split("/").pop());
        expect(put.headers["x-amz-server-side-encryption-customer-algorithm"]).toBe("AES256");
        expect(put.headers["x-amz-server-side-encryption-customer-key-md5"]).toBe(`md5-part-${partNumber}`);
      }
    } finally {
      el.remove();
    }
  });
});
