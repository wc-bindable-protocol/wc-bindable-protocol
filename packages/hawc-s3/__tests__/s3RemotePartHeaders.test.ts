import { describe, it, expect } from "vitest";
import {
  createRemoteCoreProxy,
  RemoteShellProxy,
  type ClientTransport,
  type ServerTransport,
  type ClientMessage,
  type ServerMessage,
} from "@wc-bindable/remote";
import { S3Core } from "../src/core/S3Core";
import {
  IS3Provider, S3RequestOptions, PresignedUpload, PresignedDownload,
  MultipartPart, MultipartInit,
} from "../src/types";

/**
 * Paired in-memory transport that simulates a text-frame wire.
 *
 * Every message is run through `JSON.stringify` at the sender and
 * `JSON.parse` at the receiver before dispatch, so a field that happens to
 * be non-JSON-safe (Map, Set, a Date instance, `undefined` values, a
 * non-enumerable property, an exotic prototype, etc.) will fail this test
 * exactly as it would on a real WebSocket. An earlier version of this file
 * forwarded the message object by reference, which proved only that the
 * proxy's in-memory contract is stable — not that the payload survives the
 * wire. Keeping the JSON round-trip is the point of the test.
 */
function pairedTransports(): { client: ClientTransport; server: ServerTransport } {
  let clientHandler: ((m: ServerMessage) => void) | null = null;
  let serverHandler: ((m: ClientMessage) => void) | null = null;
  const toWire = (m: unknown): string => JSON.stringify(m);
  const fromWire = <T>(s: string): T => JSON.parse(s) as T;
  const client: ClientTransport = {
    send: (m) => {
      const frame = toWire(m);
      queueMicrotask(() => serverHandler?.(fromWire<ClientMessage>(frame)));
    },
    onMessage: (h) => { clientHandler = h; },
  };
  const server: ServerTransport = {
    send: (m) => {
      const frame = toWire(m);
      queueMicrotask(() => clientHandler?.(fromWire<ServerMessage>(frame)));
    },
    onMessage: (h) => { serverHandler = h; },
  };
  return { client, server };
}

/**
 * Provider that returns distinctive per-part headers the test can identify
 * after a JSON round-trip. SSE-C-shaped keys are representative of the real
 * use case — they are the reason multipart needs headers in the first place.
 */
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
    return { uploadId: "mp-remote-1" };
  }
  async presignPart(_key: string, uploadId: string, partNumber: number, _opts: S3RequestOptions): Promise<PresignedUpload> {
    return {
      url: `https://example/part/${partNumber}`,
      method: "PUT",
      headers: {
        "x-amz-server-side-encryption-customer-algorithm": "AES256",
        "x-amz-server-side-encryption-customer-key-md5": `md5-${uploadId}-${partNumber}`,
      },
      expiresAt: Date.now() + 60_000,
    };
  }
  async completeMultipart(_k: string, _u: string, _p: MultipartPart[], _o: S3RequestOptions): Promise<{ etag: string }> {
    return { etag: "merged" };
  }
  async abortMultipart(_k: string, _u: string, _o: S3RequestOptions): Promise<void> {}
}

const MIB = 1024 * 1024;

describe("multipart headers round-trip through the remote proxy", () => {
  it("MultipartInit returned by requestMultipartUpload carries per-part headers across the wire", async () => {
    // The risk the review flagged: even with Core+Shell fixed, a JSON-only
    // transport (WebSocket text frames) could still drop `parts[].headers`
    // if it were not declared on the wire type. This test drives the full
    // serialization path — RemoteCoreProxy ⇆ RemoteShellProxy ⇆ real
    // S3Core — and asserts the headers survive both hops.
    const { client, server } = pairedTransports();
    const core = new S3Core(new HeaderProvider());
    core.bucket = "b";
    new RemoteShellProxy(core, server);

    const proxy = createRemoteCoreProxy(S3Core.wcBindable, client);
    const init = await proxy.invokeWithOptions(
      "requestMultipartUpload",
      ["remote-big.bin", 20 * MIB, "application/octet-stream"],
      { timeoutMs: 5_000 },
    ) as MultipartInit;

    expect(init.parts).toHaveLength(3);
    for (const p of init.parts) {
      expect(p.headers?.["x-amz-server-side-encryption-customer-algorithm"]).toBe("AES256");
      expect(p.headers?.["x-amz-server-side-encryption-customer-key-md5"])
        .toBe(`md5-mp-remote-1-${p.partNumber}`);
      // Expiry is serialized as a plain number, not a Date — sanity-check the
      // shape the Shell consumes in `_putPart`'s refresh logic.
      expect(typeof p.expiresAt).toBe("number");
    }

    proxy.dispose();
  });

  it("signMultipartPart RPC returns refreshed headers to the client", async () => {
    // After init the Shell may re-presign an individual part (near-expiry
    // eager refresh or 403 fallback). Providers that rotate SSE-C key
    // material per presign return fresh headers each call — those must
    // travel back through the proxy, because the Shell reads
    // `refreshed.headers` when setting headers on the retried PUT.
    const { client, server } = pairedTransports();
    const core = new S3Core(new HeaderProvider());
    core.bucket = "b";
    new RemoteShellProxy(core, server);

    const proxy = createRemoteCoreProxy(S3Core.wcBindable, client);
    await proxy.invokeWithOptions(
      "requestMultipartUpload",
      ["remote-big.bin", 20 * MIB],
      { timeoutMs: 5_000 },
    );
    const refreshed = await proxy.invokeWithOptions(
      "signMultipartPart",
      ["remote-big.bin", "mp-remote-1", 2],
      { timeoutMs: 5_000 },
    ) as PresignedUpload;

    expect(refreshed.url).toBe("https://example/part/2");
    expect(refreshed.headers?.["x-amz-server-side-encryption-customer-algorithm"]).toBe("AES256");
    expect(refreshed.headers?.["x-amz-server-side-encryption-customer-key-md5"])
      .toBe("md5-mp-remote-1-2");

    proxy.dispose();
  });
});
