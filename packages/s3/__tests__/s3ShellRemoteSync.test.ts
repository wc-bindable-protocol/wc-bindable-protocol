import { describe, it, expect, beforeAll } from "vitest";
import { S3 } from "../src/components/S3";
import type { ClientMessage, ClientTransport, ServerMessage } from "@wc-bindable/remote";

/**
 * Records every ClientMessage sent by the Shell so tests can assert which
 * inputs were synced at remote-connect time. The "sync" reply is returned
 * with empty values so the proxy initializes without any pre-seeded state —
 * the point of these tests is strictly the Shell's upstream `set` messages,
 * not the bind callback.
 */
class RecordingTransport implements ClientTransport {
  sent: ClientMessage[] = [];
  private _onMessage: ((m: ServerMessage) => void) | null = null;

  send(message: ClientMessage): void {
    this.sent.push(message);
    // Auto-respond to the proxy's initial "sync" so the handshake resolves.
    if (message.type === "sync") {
      queueMicrotask(() => {
        this._onMessage?.({ type: "sync", values: {}, capabilities: { setAck: true } });
      });
    } else if (message.type === "set" && message.id) {
      // Ack every setWithAck; the Shell relies on the promise to surface
      // transport-level failures, but for this test we do not care.
      const { id } = message;
      queueMicrotask(() => {
        this._onMessage?.({ type: "return", id, value: undefined });
      });
    }
  }

  onMessage(handler: (m: ServerMessage) => void): void {
    this._onMessage = handler;
  }
}

beforeAll(() => {
  if (!customElements.get("s3-uploader")) customElements.define("s3-uploader", S3);
});

// Give microtasks + the proxy's internal queues a tick to drain.
const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

describe("S3 Shell remote input sync", () => {
  it("syncs empty-string attributes to the server on connect", async () => {
    // The regression this guards: the Shell used to gate sync on truthy
    // values, so an explicit `prefix=""` (a legitimate way to override a
    // server-side default prefix back to empty) was silently dropped. The
    // server's pre-seeded `core.prefix = "user/123/"` would then survive
    // connection setup and every subsequent upload would route to the wrong
    // key — exactly the scenario the review called out.
    const el = document.createElement("s3-uploader") as S3;
    el.setAttribute("bucket", "b");
    el.setAttribute("prefix", ""); // empty but explicit — must be synced
    el.setAttribute("content-type", "");
    const transport = new RecordingTransport();
    document.body.appendChild(el);
    try {
      (el as any)._connectRemote(transport);
      await flush();
      await flush();

      const setMessages = transport.sent.filter(m => m.type === "set") as Array<Extract<ClientMessage, { type: "set" }>>;
      const byName = new Map(setMessages.map(m => [m.name, m.value]));
      expect(byName.get("bucket")).toBe("b");
      expect(byName.get("prefix")).toBe("");
      expect(byName.get("contentType")).toBe("");
    } finally {
      el.remove();
    }
  });

  it("does NOT sync attributes that were never set", async () => {
    // When the author did not set `prefix` at all, the Shell must leave the
    // Core's pre-seeded value alone. This is the counterpart to the empty-
    // string case — an unset attribute is "no opinion", not "clear to empty".
    const el = document.createElement("s3-uploader") as S3;
    el.setAttribute("bucket", "b");
    // prefix / content-type intentionally unset
    const transport = new RecordingTransport();
    document.body.appendChild(el);
    try {
      (el as any)._connectRemote(transport);
      await flush();
      await flush();

      const setMessages = transport.sent.filter(m => m.type === "set") as Array<Extract<ClientMessage, { type: "set" }>>;
      const names = setMessages.map(m => m.name);
      expect(names).toContain("bucket");
      expect(names).not.toContain("prefix");
      expect(names).not.toContain("contentType");
    } finally {
      el.remove();
    }
  });
});
