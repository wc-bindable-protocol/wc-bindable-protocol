import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { S3 } from "../src/components/S3";
import { S3Core } from "../src/core/S3Core";
import { setConfig } from "../src/config";
import {
  RemoteShellProxy,
  type ClientMessage,
  type ClientTransport,
  type ServerMessage,
  type ServerTransport,
} from "@wc-bindable/remote";
import type {
  IS3Provider,
  PresignedDownload,
  PresignedUpload,
  MultipartPart,
  S3RequestOptions,
} from "../src/types";

/**
 * A transport that never acks — used to prove that, BEFORE the failure
 * teardown, the Shell would hang on infinite-timeout RPCs against a dead
 * proxy. After the teardown, `_isRemote` flips to false and the Shell fast-
 * fails at "no core attached" instead of waiting forever.
 */
class SilentTransport implements ClientTransport {
  private _onMessage: ((m: ServerMessage) => void) | null = null;
  send(message: ClientMessage): void {
    // Auto-resolve only the initial sync handshake so the proxy can finish
    // constructing. Everything after that is silently dropped — simulating
    // a WebSocket that opened but then died mid-session.
    if (message.type === "sync") {
      queueMicrotask(() => this._onMessage?.({ type: "sync", values: {}, capabilities: {} }));
    }
  }
  onMessage(handler: (m: ServerMessage) => void): void { this._onMessage = handler; }
}

beforeAll(() => {
  if (!customElements.get("s3-uploader")) customElements.define("s3-uploader", S3);
});

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

describe("S3 Shell — WebSocket failure teardown", () => {
  it("a failure handler disposes proxy/unbind/ws so _isRemote flips false", async () => {
    // The regression this guards is the one the review flagged:
    //   1. ws.on("error") / ws.on("close") fires before open → onFail runs.
    //   2. Old code set _aborted + error + busy-state reset, but LEFT the
    //      proxy in place.
    //   3. `_isRemote` stayed true, and every subsequent upload()/abort()
    //      tried to drive the dead proxy with `timeoutMs: 0` — hanging the
    //      caller forever instead of surfacing the error.
    const el = document.createElement("s3-uploader") as S3;
    const transport = new SilentTransport();
    document.body.appendChild(el);
    try {
      (el as any)._connectRemote(transport);
      await flush();

      // Sanity: after _connectRemote the proxy is live.
      expect((el as any)._proxy).not.toBeNull();

      // Simulate the "WebSocket dropped" path that `_initRemote`'s onFail
      // would run. We cannot route through the real WebSocket here, so we
      // exercise the teardown helper directly — this is the code path that
      // onFail now chains into, and the one that was previously missing.
      (el as any)._disposeRemote();

      expect((el as any)._proxy).toBeNull();
      expect((el as any)._unbind).toBeNull();
      expect((el as any)._ws).toBeNull();
      expect((el as any)._remoteValues).toEqual({});
    } finally {
      el.remove();
    }
  });

  it("after teardown, upload() fails fast instead of hanging on the dead proxy", async () => {
    // The whole point of the fix: once remote state is torn down, _isRemote
    // goes false and `_requestUpload` bottoms out in the "no core attached"
    // branch. Without this, the infinite-timeout invokeWithOptions against
    // a disposed proxy is unobservable failure — the await never resolves.
    const el = document.createElement("s3-uploader") as S3;
    document.body.appendChild(el);
    try {
      (el as any)._connectRemote(new SilentTransport());
      await flush();
      (el as any)._disposeRemote();

      el.file = new Blob(["x"]);
      // upload() reports the failure through the error state rather than
      // re-throwing (the Shell catches + surfaces on `error`), so the
      // assertion is on the thrown rejection reaching us via the promise
      // path or on `el.error`. upload() rejects because `_requestUpload`
      // reaches "no core attached" when neither proxy nor local core exist.
      await expect(el.upload()).rejects.toThrow(/no core attached/);
    } finally {
      el.remove();
    }
  });

  it("_disposeRemote is idempotent (double-call is a no-op)", async () => {
    // onFail fires once, but `disconnectedCallback` can run afterwards —
    // both paths now chain into `_disposeRemote`. Double-dispose must not
    // throw and must leave state consistent.
    const el = document.createElement("s3-uploader") as S3;
    document.body.appendChild(el);
    try {
      (el as any)._connectRemote(new SilentTransport());
      await flush();

      (el as any)._disposeRemote();
      expect(() => (el as any)._disposeRemote()).not.toThrow();
      expect((el as any)._proxy).toBeNull();
    } finally {
      el.remove();
    }
  });
});

/**
 * Minimal WebSocket-compatible stub. Covers the surface `_initRemote` and
 * `WebSocketClientTransport` actually touch:
 *   - readyState (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED)
 *   - addEventListener/removeEventListener for "open" / "close" / "error" / "message"
 *   - send / close
 *
 * Provides `fireClose()` / `fireError()` so the test can simulate a socket
 * dropping without establishing a real connection. All constructed instances
 * register themselves in `fakeWsInstances` so tests can retrieve the current
 * one after `_initRemote()` constructs it internally.
 */
const fakeWsInstances: FakeWebSocket[] = [];

class FakeWebSocket implements Partial<WebSocket> {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = FakeWebSocket.CONNECTING;
  url: string;
  private _listeners: Record<string, Array<{ fn: (e: any) => void; once?: boolean }>> = {};

  constructor(url: string) {
    this.url = url;
    fakeWsInstances.push(this);
  }

  addEventListener(name: string, fn: (e: any) => void, opts?: { once?: boolean }): void {
    (this._listeners[name] ??= []).push({ fn, once: !!opts?.once });
  }
  removeEventListener(name: string, fn: (e: any) => void): void {
    const list = this._listeners[name];
    if (!list) return;
    this._listeners[name] = list.filter(l => l.fn !== fn);
  }
  send(_data: unknown): void { /* ignored; we never exercise open→send here */ }
  close(): void { this.readyState = FakeWebSocket.CLOSED; }

  fireOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this._dispatch("open", { type: "open" });
  }
  fireClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this._dispatch("close", { type: "close" });
  }
  fireError(): void {
    // `error` does not change readyState per the WHATWG spec; it is usually
    // followed by `close`. The Shell's onFail is `{ once: true }` so either
    // event reaching it is enough to trigger teardown.
    this._dispatch("error", { type: "error" });
  }

  private _dispatch(name: string, ev: any): void {
    const list = this._listeners[name];
    if (!list) return;
    const remaining: typeof list = [];
    for (const entry of list) {
      entry.fn(ev);
      if (!entry.once) remaining.push(entry);
    }
    this._listeners[name] = remaining;
  }
}

describe("S3 Shell — end-to-end onFail teardown via a WebSocket stub", () => {
  let origWs: typeof WebSocket;

  beforeEach(() => {
    origWs = globalThis.WebSocket;
    (globalThis as any).WebSocket = FakeWebSocket;
    fakeWsInstances.length = 0;
    // `_initRemote()` reads the remote URL from config. Turn the feature on
    // and point it at a dummy URL — `new FakeWebSocket(url)` never actually
    // dials out, so the value only needs to be non-empty.
    setConfig({
      remote: {
        enableRemote: true,
        remoteSettingType: "config",
        remoteCoreUrl: "ws://test.invalid/s3",
      },
    });
  });

  afterEach(() => {
    (globalThis as any).WebSocket = origWs;
    setConfig({
      remote: { enableRemote: false, remoteSettingType: "config", remoteCoreUrl: "" },
    });
  });

  it("a 'close' on the stub WebSocket runs the full onFail → _disposeRemote chain", async () => {
    // This is the configuration the review asked for: drive the public path.
    // `connectedCallback` runs `_initRemote()`, which constructs our stub and
    // attaches `onFail` to its close/error events. Firing `close` on the
    // stub must reach `_disposeRemote` (not just `_setErrorState`), leaving
    // the element with `_isRemote === false` and no dangling proxy.
    const el = document.createElement("s3-uploader") as S3;
    document.body.appendChild(el);
    try {
      // The connectedCallback schedule-async nothing; just flush microtasks.
      await flush();
      expect(fakeWsInstances).toHaveLength(1);
      const ws = fakeWsInstances[0];

      // Proxy should be live at this point — onFail has not fired.
      expect((el as any)._proxy).not.toBeNull();
      expect((el as any)._ws).toBe(ws);

      ws.fireClose();
      // onFail is synchronous with respect to the close event; the teardown
      // helper it chains into is synchronous too. No awaits needed — but
      // flush to be explicit about any followup microtasks.
      await flush();

      // End-to-end assertion: the production path bottomed out in teardown.
      expect((el as any)._proxy).toBeNull();
      expect((el as any)._unbind).toBeNull();
      expect((el as any)._ws).toBeNull();
      expect((el as any)._remoteValues).toEqual({});
      // The user-visible error is present and matches the message shape the
      // Shell sets on unopened sockets (close-before-open ⇒ "failed").
      expect(el.error).toBeInstanceOf(Error);
      expect(String((el.error as Error).message)).toMatch(/WebSocket connection failed/);
    } finally {
      el.remove();
    }
  });

  it("a 'close' AFTER 'open' tears down through the 'lost' branch of onFail", async () => {
    // The `opened` flag in `_initRemote` flips the error message from
    // "failed" to "lost" once the socket has handshaken. A prior test only
    // exercised close-before-open; this one confirms the post-open drop
    // path also runs the full teardown chain, not just the message swap.
    const el = document.createElement("s3-uploader") as S3;
    document.body.appendChild(el);
    try {
      await flush();
      const ws = fakeWsInstances[0];

      // Drive the handshake: flipping readyState + firing "open" runs the
      // Shell's `opened = true` listener and the transport's open listener.
      // The transport then flushes its buffered sync frame via ws.send,
      // which is a stub no-op — the remote proxy never receives a reply,
      // but that is fine: we are testing teardown on drop, not a completed
      // session.
      ws.fireOpen();
      await flush();

      ws.fireClose();
      await flush();

      expect((el as any)._proxy).toBeNull();
      expect((el as any)._ws).toBeNull();
      expect(el.error).toBeInstanceOf(Error);
      // "lost" is the post-open branch. If teardown runs but the message
      // still reads "failed", the `opened` tracking regressed.
      expect(String((el.error as Error).message)).toMatch(/WebSocket connection lost/);
    } finally {
      el.remove();
    }
  });

  it("a successful reconnect clears the prior local-error flag and dispatches the transition", async () => {
    // The regression this guards: after a WS drop, `_setErrorState(...)`
    // sets both `_errorState` and `_hasLocalError`. If reconnect only
    // zeroes the value but leaves the flag true, the error getter's remote
    // branch (`if (this._hasLocalError) return this._errorState;`) keeps
    // returning the stale null forever — masking every subsequent real
    // server-side error. Worse, no `s3-uploader:error` event fires to signal
    // the transition, so event subscribers desynchronize from the getter.
    //
    // We exercise the full DOM lifecycle: attach → drop → detach → attach
    // again. After the second attach, `_hasLocalError` must be false and a
    // `s3-uploader:error` clear event must have been dispatched during the
    // reconnect.
    const el = document.createElement("s3-uploader") as S3;
    const errorEvents: any[] = [];
    el.addEventListener("s3-uploader:error", (e: any) => errorEvents.push(e.detail));
    document.body.appendChild(el);
    try {
      await flush();
      expect(fakeWsInstances).toHaveLength(1);
      const firstWs = fakeWsInstances[0];

      // Drop the first socket → `_setErrorState(...)` fires.
      firstWs.fireClose();
      await flush();
      expect((el as any)._hasLocalError).toBe(true);
      // The initial close-before-open dispatch is the "failed" error.
      expect(errorEvents.at(-1)).toBeInstanceOf(Error);

      // Full DOM cycle → re-init of the remote transport.
      el.remove();
      document.body.appendChild(el);
      await flush();
      expect(fakeWsInstances).toHaveLength(2);

      // After reconnect, the local-error flag MUST be cleared — otherwise
      // any real remote error delivered later would be invisible.
      expect((el as any)._hasLocalError).toBe(false);
      // A `s3-uploader:error` event with detail=null must have been dispatched
      // to notify subscribers of the transition out of the error state.
      expect(errorEvents.at(-1)).toBeNull();
      // And the getter now reflects remote state (null here since the new
      // proxy has not received any server-side error).
      expect(el.error).toBeNull();
    } finally {
      el.remove();
    }
  });

  it("a solitary 'error' event (no close) still triggers the onFail teardown", async () => {
    // WebSocket implementations are not required to pair `error` with
    // `close`, and the Shell registers onFail on both with `{ once: true }`.
    // If the error path were to regress (e.g. the listener attaching only
    // to "close"), this test would fail while the close-path tests still
    // passed, which is the exact failure mode the review called out.
    const el = document.createElement("s3-uploader") as S3;
    document.body.appendChild(el);
    try {
      await flush();
      const ws = fakeWsInstances[0];

      // Note: we intentionally do NOT fire "close" — error alone must be
      // enough for teardown.
      ws.fireError();
      await flush();

      expect((el as any)._proxy).toBeNull();
      expect((el as any)._unbind).toBeNull();
      expect((el as any)._ws).toBeNull();
      expect((el as any)._remoteValues).toEqual({});
      expect(el.error).toBeInstanceOf(Error);
      // `opened` is still false at this point, so the message is the
      // "failed" variant. The point of this test is not the message — it
      // is proving the error-only path reaches teardown at all.
      expect(String((el.error as Error).message)).toMatch(/WebSocket connection failed/);
    } finally {
      el.remove();
    }
  });
});

/**
 * Paired in-memory transport — mirrors `s3RemotePartHeaders.test.ts`. Runs
 * every message through JSON.stringify/parse so any non-JSON-safe field
 * would surface exactly as it would on a real WebSocket. Used to drive the
 * Shell ⇆ RemoteShellProxy ⇆ S3Core loop without a real socket.
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
 * Provider that rejects on `presignUpload`. Drives the `_requestUpload` RPC
 * into its error path on the server, which is the scenario C10-#2 flagged:
 * before the fix, the Core would publish `error` via `bind()` (event #1)
 * AND the Shell's `_doSingle` catch would call `_setErrorState(e)` (event
 * #2) for the same logical failure.
 */
class FailingPresignProvider implements IS3Provider {
  async presignUpload(_k: string, _o: S3RequestOptions): Promise<PresignedUpload> {
    throw new Error("provider: access denied");
  }
  async presignDownload(_k: string, _o: S3RequestOptions): Promise<PresignedDownload> {
    return { url: "https://example/dl", method: "GET", expiresAt: Date.now() + 60_000 };
  }
  async deleteObject(_k: string, _o: S3RequestOptions): Promise<void> {}
  async initiateMultipart(_k: string, _o: S3RequestOptions): Promise<{ uploadId: string }> {
    return { uploadId: "never-called" };
  }
  async presignPart(
    _k: string, _u: string, _p: number, _o: S3RequestOptions,
  ): Promise<PresignedUpload> {
    return { url: "https://example/part", method: "PUT", expiresAt: Date.now() + 60_000 };
  }
  async completeMultipart(
    _k: string, _u: string, _p: MultipartPart[], _o: S3RequestOptions,
  ): Promise<{ etag: string }> {
    return { etag: "never-called" };
  }
  async abortMultipart(_k: string, _u: string, _o: S3RequestOptions): Promise<void> {}
}

const flushMany = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
};

describe("S3 Shell remote mode — error-event de-duplication (C10-#2)", () => {
  beforeAll(() => {
    if (!customElements.get("s3-uploader")) customElements.define("s3-uploader", S3);
  });

  it("a failing Core RPC produces exactly one s3-uploader:error event on the Shell", async () => {
    // Before C10-#2's fix, a remote `_requestUpload` rejection triggered two
    // separate `s3-uploader:error` dispatches for the same logical failure:
    //   1. Core.requestUpload's catch called `_setError(e)`, which pushed an
    //      `update` frame over the wire; the Shell's bind() callback turned
    //      that into a local `s3-uploader:error` CustomEvent.
    //   2. The proxy's rejection propagated back to `_doSingle`, whose
    //      `catch` called `_setErrorState(e)` and dispatched its own
    //      `s3-uploader:error` event.
    // The fix routes RPC catches through `_setRpcErrorState` (which is a
    // no-op in remote mode) so only (1) remains. If the regression returns,
    // `errorEvents.length` will be 2.
    const { client, server } = pairedTransports();
    const core = new S3Core(new FailingPresignProvider());
    core.bucket = "b";
    core.prefix = "p/";
    new RemoteShellProxy(core, server);

    const el = document.createElement("s3-uploader") as S3;
    const errorEvents: unknown[] = [];
    el.addEventListener("s3-uploader:error", (ev: Event) => {
      errorEvents.push((ev as CustomEvent).detail);
    });
    document.body.appendChild(el);
    try {
      (el as any)._connectRemote(client);
      await flushMany();
      el.file = new Blob(["x"]);

      await expect(el.upload()).rejects.toThrow();
      // Drain both proxy ack delivery and any bind() dispatch microtasks.
      await flushMany();

      // Filter out any null-detail events (the `_clearErrorState` transition
      // that fires on `connectedCallback` when no prior error exists is gated,
      // but belt-and-braces in case a future refactor changes that).
      const withPayload = errorEvents.filter(e => e != null);
      expect(withPayload).toHaveLength(1);
      // Still visible through the public getter.
      expect(el.error).not.toBeNull();
    } finally {
      el.remove();
    }
  });

  it("a failing _complete RPC produces exactly one s3-uploader:error event on the Shell", async () => {
    // Mirror of the above for the post-PUT completion RPC. The Shell's
    // `_doSingle` also has a third catch (`_complete`) that used to
    // `_setErrorState` unconditionally. Because this path exercises a real
    // XHR PUT in between, we stub XMLHttpRequest so the PUT "succeeds"
    // synchronously with a fake ETag; the Core's `complete()` then fails
    // because the provider's `presignDownload` path is fine but our custom
    // provider throws on `complete` via the `completeMultipart`/complete
    // post-process flow. Simpler: fail `presignDownload` which is called
    // from `complete()` after the upload succeeds.
    class FailingCompleteProvider extends FailingPresignProvider {
      async presignUpload(key: string, _o: S3RequestOptions): Promise<PresignedUpload> {
        return {
          url: `https://example/upload/${key}`,
          method: "PUT",
          expiresAt: Date.now() + 60_000,
        };
      }
      async presignDownload(_k: string, _o: S3RequestOptions): Promise<PresignedDownload> {
        throw new Error("provider: download denied");
      }
    }

    // Stub XHR just long enough to make the PUT succeed with a fake ETag.
    const RealXHR = globalThis.XMLHttpRequest;
    class FakeXHR {
      upload = { addEventListener: (_n: string, _fn: (e: ProgressEvent) => void) => {} };
      private _listeners: Record<string, Array<(e: Event) => void>> = {};
      open(_m: string, _u: string): void {}
      setRequestHeader(_n: string, _v: string): void {}
      addEventListener(name: string, fn: (e: Event) => void): void {
        (this._listeners[name] ??= []).push(fn);
      }
      send(_body: unknown): void {
        queueMicrotask(() => {
          for (const fn of this._listeners["load"] ?? []) fn(new Event("load"));
        });
      }
      abort(): void {}
      getResponseHeader(name: string): string | null {
        return name.toLowerCase() === "etag" ? '"deadbeef"' : null;
      }
      get status(): number { return 200; }
      get responseText(): string { return ""; }
      get statusText(): string { return "OK"; }
    }
    (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXHR;

    try {
      const { client, server } = pairedTransports();
      const core = new S3Core(new FailingCompleteProvider());
      core.bucket = "b";
      core.prefix = "p/";
      new RemoteShellProxy(core, server);

      const el = document.createElement("s3-uploader") as S3;
      const errorEvents: unknown[] = [];
      el.addEventListener("s3-uploader:error", (ev: Event) => {
        errorEvents.push((ev as CustomEvent).detail);
      });
      document.body.appendChild(el);
      try {
        (el as any)._connectRemote(client);
        await flushMany();
        el.file = new Blob(["payload"]);

        await expect(el.upload()).rejects.toThrow();
        await flushMany();

        const withPayload = errorEvents.filter(e => e != null);
        expect(withPayload).toHaveLength(1);
        expect(el.error).not.toBeNull();
      } finally {
        el.remove();
      }
    } finally {
      (globalThis as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest = RealXHR;
    }
  });
});
