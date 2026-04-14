import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ClientTransport, ServerTransport, ClientMessage, ServerMessage } from "@wc-bindable/remote";
import { RemoteShellProxy } from "@wc-bindable/remote";
import { Ai } from "../src/components/Ai";
import { AiCore } from "../src/core/AiCore";
import { registerComponents } from "../src/registerComponents";
import { setConfig } from "../src/config";

registerComponents();

// --- Mock transport pair ---

function createMockTransportPair(): {
  client: ClientTransport;
  server: ServerTransport;
} {
  let clientHandler: ((msg: ServerMessage) => void) | null = null;
  let serverHandler: ((msg: ClientMessage) => void) | null = null;

  const client: ClientTransport = {
    send: (msg) => {
      if (serverHandler) Promise.resolve().then(() => { try { serverHandler!(msg); } catch { /* handled by RemoteShellProxy */ } });
    },
    onMessage: (handler) => { clientHandler = handler; },
  };

  const server: ServerTransport = {
    send: (msg) => {
      if (clientHandler) Promise.resolve().then(() => { try { clientHandler!(msg); } catch { /* handled by RemoteCoreProxy */ } });
    },
    onMessage: (handler) => { serverHandler = handler; },
  };

  return { client, server };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// --- Helpers ---

function createMockResponse(body: any): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "Content-Type": "application/json" }),
    body: null,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function createMockStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return {
    ok: true, status: 200, statusText: "OK",
    headers: new Headers({ "Content-Type": "text/event-stream" }),
    body: stream,
    json: () => Promise.reject(new Error("streaming")),
    text: () => Promise.reject(new Error("streaming")),
  } as unknown as Response;
}

function sseData(data: string): string {
  return `data: ${data}\n\n`;
}

/**
 * Create a remote Ai element connected to a real AiCore via mock transport.
 * Returns the element, the server-side core, and a cleanup function.
 */
function createRemoteAi(): {
  el: Ai;
  core: AiCore;
  shell: RemoteShellProxy;
  cleanup: () => void;
} {
  const core = new AiCore();
  const { client, server } = createMockTransportPair();
  const shell = new RemoteShellProxy(core, server);

  const el = document.createElement("hawc-ai") as Ai;
  (el as any)._connectRemote(client);

  return {
    el,
    core,
    shell,
    cleanup: () => {
      shell.dispose();
      el.remove();
    },
  };
}

describe("Ai (remote mode)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    document.body.innerHTML = "";
  });

  describe("_initRemote エラー", () => {
    it("remoteCoreUrl未設定時はconnectedCallbackでerrorイベントを発火する", () => {
      setConfig({ remote: { enableRemote: true, remoteSettingType: "config", remoteCoreUrl: "" } });
      try {
        const el = document.createElement("hawc-ai") as Ai;
        const errors: Error[] = [];

        el.addEventListener("hawc-ai:error", (e: Event) => {
          errors.push((e as CustomEvent).detail);
        });

        expect(() => document.body.appendChild(el)).not.toThrow();
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain("remoteCoreUrl is empty");
        expect(el.error).toBe(errors[0]);
      } finally {
        setConfig({ remote: { enableRemote: false } });
      }
    });

    it("open後の切断はconnection lostとして通知する", () => {
      setConfig({ remote: { enableRemote: true, remoteSettingType: "config", remoteCoreUrl: "ws://localhost:9999" } });

      class FakeWebSocket extends EventTarget {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        readonly CONNECTING = 0;
        readonly OPEN = 1;
        readyState = 0;
        url: string;
        constructor(url: string) {
          super();
          this.url = url;
        }
        send(): void { /* noop */ }
        close(): void { /* noop */ }
      }

      const realWs = globalThis.WebSocket;
      (globalThis as any).WebSocket = FakeWebSocket;

      try {
        const el = document.createElement("hawc-ai") as Ai;
        const errors: Error[] = [];
        el.addEventListener("hawc-ai:error", (e: Event) => {
          errors.push((e as CustomEvent).detail);
        });

        document.body.appendChild(el);
        const ws = (el as any)._ws as EventTarget;
        ws.dispatchEvent(new Event("open"));
        ws.dispatchEvent(new Event("error"));

        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain("connection lost");
      } finally {
        (globalThis as any).WebSocket = realWs;
        setConfig({ remote: { enableRemote: false, remoteSettingType: "config", remoteCoreUrl: "" } });
      }
    });

    it("パッシブな切断でloading/streamingが立っていてもリセットされる", () => {
      setConfig({ remote: { enableRemote: true, remoteSettingType: "config", remoteCoreUrl: "ws://localhost:9999" } });

      class FakeWebSocket extends EventTarget {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        readonly CONNECTING = 0;
        readonly OPEN = 1;
        readyState = 0;
        url: string;
        constructor(url: string) {
          super();
          this.url = url;
        }
        send(): void { /* noop */ }
        close(): void { /* noop */ }
      }
      const realWs = globalThis.WebSocket;
      (globalThis as any).WebSocket = FakeWebSocket;

      try {
        const el = document.createElement("hawc-ai") as Ai;
        const loadingEvents: boolean[] = [];
        const streamingEvents: boolean[] = [];
        el.addEventListener("hawc-ai:loading-changed", (e: Event) => {
          loadingEvents.push((e as CustomEvent).detail);
        });
        el.addEventListener("hawc-ai:streaming-changed", (e: Event) => {
          streamingEvents.push((e as CustomEvent).detail);
        });

        document.body.appendChild(el);

        // サーバー側同期でloading/streamingが立っている状態を模擬
        (el as any)._remoteValues.loading = true;
        (el as any)._remoteValues.streaming = true;
        expect(el.loading).toBe(true);
        expect(el.streaming).toBe(true);

        // send()の外側でソケットがドロップ（パッシブな切断）
        const ws = (el as any)._ws as EventTarget;
        ws.dispatchEvent(new Event("open"));
        ws.dispatchEvent(new Event("close"));

        // 以降UIが固まらないようbusy状態がリセットされる
        expect(el.loading).toBe(false);
        expect(el.streaming).toBe(false);
        expect(loadingEvents).toEqual([false]);
        expect(streamingEvents).toEqual([false]);
      } finally {
        (globalThis as any).WebSocket = realWs;
        setConfig({ remote: { enableRemote: false, remoteSettingType: "config", remoteCoreUrl: "" } });
      }
    });

    it("disconnectedCallbackのclose()が同期的にcloseを発火しても偽のconnection失敗通知が出ない", () => {
      setConfig({ remote: { enableRemote: true, remoteSettingType: "config", remoteCoreUrl: "ws://localhost:9999" } });

      // close()が同期的にcloseイベントを発火するWebSocket — 意図的teardownがerror通知を
      // 誤発火させないかを確認する
      class SyncCloseWebSocket extends EventTarget {
        static readonly CONNECTING = 0;
        readonly CONNECTING = 0;
        readyState = 0;
        url: string;
        constructor(url: string) {
          super();
          this.url = url;
        }
        send(): void { /* noop */ }
        close(): void {
          this.dispatchEvent(new Event("close"));
        }
      }
      const realWs = globalThis.WebSocket;
      (globalThis as any).WebSocket = SyncCloseWebSocket;

      try {
        const el = document.createElement("hawc-ai") as Ai;
        const errors: Error[] = [];
        el.addEventListener("hawc-ai:error", (e: Event) => {
          errors.push((e as CustomEvent).detail);
        });

        document.body.appendChild(el);
        el.remove();

        expect(errors).toHaveLength(0);
      } finally {
        (globalThis as any).WebSocket = realWs;
        setConfig({ remote: { enableRemote: false, remoteSettingType: "config", remoteCoreUrl: "" } });
      }
    });

    it("古いWebSocketのerrorは現在の接続に紐付かないので無視する", () => {
      setConfig({ remote: { enableRemote: true, remoteSettingType: "config", remoteCoreUrl: "ws://localhost:9999" } });

      class FakeWebSocket extends EventTarget {
        static readonly CONNECTING = 0;
        readonly CONNECTING = 0;
        readyState = 0;
        url: string;
        constructor(url: string) {
          super();
          this.url = url;
        }
        send(): void { /* noop */ }
        close(): void { /* noop */ }
      }

      const realWs = globalThis.WebSocket;
      (globalThis as any).WebSocket = FakeWebSocket;

      try {
        const el = document.createElement("hawc-ai") as Ai;
        const errors: Error[] = [];
        el.addEventListener("hawc-ai:error", (e: Event) => {
          errors.push((e as CustomEvent).detail);
        });

        document.body.appendChild(el);
        const oldWs = (el as any)._ws as EventTarget;
        (el as any)._ws = new FakeWebSocket("ws://other");
        oldWs.dispatchEvent(new Event("error"));

        expect(errors).toHaveLength(0);
      } finally {
        (globalThis as any).WebSocket = realWs;
        setConfig({ remote: { enableRemote: false, remoteSettingType: "config", remoteCoreUrl: "" } });
      }
    });
  });

  describe("sync — 初期状態の同期", () => {
    it("サーバーの現在値がクライアントに同期される", async () => {
      const { el, core, cleanup } = createRemoteAi();

      // サーバー側Coreに初期状態をセット
      core.provider = "openai";

      // sync request → response を待つ
      await flush();
      await flush();

      // content, loading etc. はCoreのデフォルト値で同期される
      expect(el.content).toBe("");
      expect(el.loading).toBe(false);
      expect(el.streaming).toBe(false);
      expect(el.error).toBeNull();
      expect(el.usage).toBeNull();
      expect(el.messages).toEqual([]);

      cleanup();
    });
  });

  describe("output state — リアルタイム更新", () => {
    it("サーバー側Coreのプロパティ変更がクライアントに伝播する", async () => {
      const { el, core, cleanup } = createRemoteAi();
      await flush();
      await flush();

      // サーバー側でloading状態を変更
      (core as any)._setLoading(true);
      await flush();

      expect(el.loading).toBe(true);

      cleanup();
    });

    it("プロパティ変更がHTMLElement上のイベントとして発火する", async () => {
      const { el, core, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await flush();
      await flush();

      const events: Array<{ name: string; detail: any }> = [];
      el.addEventListener("hawc-ai:loading-changed", (e: Event) => {
        events.push({ name: "loading", detail: (e as CustomEvent).detail });
      });

      (core as any)._setLoading(true);
      await flush();

      expect(events).toEqual([{ name: "loading", detail: true }]);

      cleanup();
    });
  });

  describe("send — リモートコマンド呼び出し", () => {
    it("send()がリモートCoreのsend()を呼び出す", async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        choices: [{ message: { content: "Remote hello!" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }));

      const { el, core, cleanup } = createRemoteAi();
      await flush();
      await flush();

      core.provider = "openai";
      el.prompt = "Hello";
      el.setAttribute("model", "gpt-4o");
      el.stream = false;

      const resultPromise = el.send();

      // メッセージ配送を待つ (client→server cmd, server処理, server→client updates + return)
      await flush();
      await flush();
      const result = await resultPromise;

      expect(result).toBe("Remote hello!");

      // 状態更新がクライアントに伝播するまで待つ
      await flush();
      await flush();

      expect(el.content).toBe("Remote hello!");
      expect(el.loading).toBe(false);

      cleanup();
    });

    it("サーバー側のcommandエラーはrejectとして伝搬する（localと同じ契約）", async () => {
      const { el, core, cleanup } = createRemoteAi();
      await flush();
      await flush();

      // providerを設定するが、model未設定でsend → サーバー側でvalidationエラー
      core.provider = "openai";
      el.prompt = "Hello";
      el.stream = false;
      // model未設定

      // サーバー側のvalidationエラーがrejectとして伝搬する
      // Attach .catch immediately to prevent PromiseRejectionHandledWarning
      let caughtError: any = null;
      const sendPromise = el.send().catch((e: any) => { caughtError = e; });
      // メッセージ配送を待つ
      await flush();
      await flush();
      await flush();
      await flush();
      await sendPromise;

      expect(caughtError).not.toBeNull();
      expect(caughtError.message).toContain("model is required");

      cleanup();
    });
  });

  describe("send — 競合/resend（リモート経路）", () => {
    it("重なったsend()の1回目のuserメッセージが残らず、2回目の結果が返る", async () => {
      // 1回目: abort されるまで解決しない
      fetchSpy.mockImplementationOnce((_url, init) => {
        return new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      });
      // 2回目: 即応答
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        choices: [{ message: { content: "Second response" } }],
      }));

      const { el, core, cleanup } = createRemoteAi();
      await flush();
      await flush();
      core.provider = "openai";
      el.setAttribute("model", "gpt-4o");
      el.stream = false;

      el.prompt = "First";
      const first = el.send();
      el.prompt = "Second";
      const second = el.send();

      const [r1, r2] = await Promise.all([first, second]);

      // 状態更新の伝搬を待つ
      await flush();
      await flush();
      await flush();
      await flush();

      expect(r1).toBeNull();
      expect(r2).toBe("Second response");
      expect(el.loading).toBe(false);
      expect(el.messages).toEqual([
        { role: "user", content: "Second" },
        { role: "assistant", content: "Second response" },
      ]);
    });

    it("ストリーミング中にresendすると1回目のuserメッセージが履歴に残らない", async () => {
      // 1回目: ストリームを開き、abort(=signalのabort)でcontroller.close()して自然終了
      fetchSpy.mockImplementationOnce((_url, init) => {
        const signal = (init as RequestInit).signal!;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener("abort", () => {
              try { controller.close(); } catch { /* already closed */ }
            });
          },
        });
        return Promise.resolve({
          ok: true, status: 200, statusText: "OK",
          headers: new Headers({ "Content-Type": "text/event-stream" }),
          body: stream,
          json: () => Promise.reject(), text: () => Promise.reject(),
        } as unknown as Response);
      });
      // 2回目: 非ストリーミングで即座に成功
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        choices: [{ message: { content: "OK" } }],
      }));

      const { el, core, cleanup } = createRemoteAi();
      await flush();
      await flush();
      core.provider = "openai";
      el.setAttribute("model", "gpt-4o");

      el.prompt = "First";
      el.stream = true;
      const first = el.send();
      // 1回目のfetchが解決するまで少し待つ（ストリーミング開始）
      await new Promise(r => setTimeout(r, 10));

      el.prompt = "Second";
      el.stream = false;
      const second = el.send();

      const [r1, r2] = await Promise.all([first, second]);

      // 状態更新の伝搬を待つ
      await flush();
      await flush();
      await flush();
      await flush();

      expect(r1).toBeNull();
      expect(r2).toBe("OK");
      expect(el.streaming).toBe(false);
      expect(el.loading).toBe(false);
      expect(el.messages).toEqual([
        { role: "user", content: "Second" },
        { role: "assistant", content: "OK" },
      ]);

      cleanup();
    });

    it("重なったストリーミングsend()でも1回目のメッセージが残らない", async () => {
      // 1回目: abortされるまで解決しない
      fetchSpy.mockImplementationOnce((_url, init) => {
        return new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      });
      // 2回目: ストリーミング応答
      const chunks = [
        sseData('{"choices":[{"delta":{"content":"Streamed"}}]}'),
        sseData("[DONE]"),
      ];
      fetchSpy.mockResolvedValueOnce(createMockStreamResponse(chunks));

      const { el, core, cleanup } = createRemoteAi();
      await flush();
      await flush();
      core.provider = "openai";
      el.setAttribute("model", "gpt-4o");
      el.stream = true;

      el.prompt = "First";
      const first = el.send();
      el.prompt = "Second";
      const second = el.send();

      const [r1, r2] = await Promise.all([first, second]);

      await flush();
      await flush();
      await flush();
      await flush();

      expect(r1).toBeNull();
      expect(r2).toBe("Streamed");
      expect(el.streaming).toBe(false);
      expect(el.loading).toBe(false);
      expect(el.messages).toEqual([
        { role: "user", content: "Second" },
        { role: "assistant", content: "Streamed" },
      ]);

      cleanup();
    });
  });

  describe("abort — リモートabort呼び出し", () => {
    it("abort()がエラーなく実行できる", async () => {
      const { el, cleanup } = createRemoteAi();
      await flush();
      await flush();

      expect(() => el.abort()).not.toThrow();

      cleanup();
    });
  });

  describe("messages setter — リモートinput設定", () => {
    it("messages代入がサーバー側Coreに伝播する", async () => {
      const { el, core, cleanup } = createRemoteAi();
      await flush();
      await flush();

      const history = [{ role: "user" as const, content: "Hi" }];
      el.messages = history;

      await flush();

      expect(core.messages).toEqual(history);

      cleanup();
    });

    it("messages getterは防御コピーを返す", async () => {
      const { el, core, cleanup } = createRemoteAi();
      await flush();
      await flush();

      // サーバー側にメッセージを設定
      core.messages = [{ role: "user", content: "Hi" }];
      await flush();

      const msgs = el.messages;
      msgs.push({ role: "assistant", content: "injected" });

      // 内部キャッシュが汚染されていないこと
      expect(el.messages).toHaveLength(1);

      cleanup();
    });
  });

  describe("attributeChangedCallback — provider設定", () => {
    it("provider属性変更がサーバー側Coreに伝播する", async () => {
      const { el, core, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await flush();
      await flush();

      el.setAttribute("provider", "anthropic");
      await flush();
      await flush();

      expect(core.provider).not.toBeNull();

      cleanup();
    });

    it("provider属性をremoveAttributeするとサーバー側Coreのproviderがクリアされる", async () => {
      const { el, core, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await flush();
      await flush();

      // まずproviderを設定
      el.setAttribute("provider", "openai");
      await flush();
      await flush();
      expect(core.provider).not.toBeNull();

      // providerをクリア
      el.removeAttribute("provider");
      await flush();
      await flush();

      expect(core.provider).toBeNull();

      cleanup();
    });
  });

  describe("disconnectedCallback — クリーンアップ", () => {
    it("DOM削除時にproxy参照がクリアされる", async () => {
      const { el, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await flush();
      await flush();

      el.remove();

      // proxy, unbind, remoteValuesがクリアされている
      expect((el as any)._proxy).toBeNull();
      expect((el as any)._unbind).toBeNull();
      expect((el as any)._remoteValues).toEqual({});

      cleanup();
    });

    it("DOM削除時にWebSocketがcloseされる", async () => {
      const { el, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await flush();
      await flush();

      // _initRemote経由で作られたWebSocketをシミュレート
      const mockWs = { close: vi.fn() };
      (el as any)._ws = mockWs;

      el.remove();

      expect(mockWs.close).toHaveBeenCalledOnce();
      expect((el as any)._ws).toBeNull();

      cleanup();
    });

    it("DOM再アタッチ後に再接続され正常に動作する", async () => {
      setConfig({ remote: { enableRemote: true, remoteSettingType: "config", remoteCoreUrl: "ws://localhost:9999" } });

      // 実WebSocketに依存すると接続試行のタイミングで自発的にerror/closeが
      // 飛んでテストが不安定になる。CONNECTINGのまま何も発火しないスタブに差し替える。
      class FakeWebSocket extends EventTarget {
        static readonly CONNECTING = 0;
        readonly CONNECTING = 0;
        readyState = 0;
        url: string;
        constructor(url: string) {
          super();
          this.url = url;
        }
        send(): void { /* noop */ }
        close(): void { /* noop */ }
      }
      const realWs = globalThis.WebSocket;
      (globalThis as any).WebSocket = FakeWebSocket;

      try {
        const { el, cleanup } = createRemoteAi();
        document.body.appendChild(el);
        await flush();
        await flush();

        // 一度DOMから削除
        el.remove();
        expect((el as any)._proxy).toBeNull();

        // 再アタッチ — _initRemoteが再び呼ばれる
        const errors: any[] = [];
        el.addEventListener("hawc-ai:error", (e: Event) => {
          errors.push((e as CustomEvent).detail);
        });
        document.body.appendChild(el);

        // ブラウザは接続失敗でerror→closeを両方発火するため、
        // _wsに直接ディスパッチして二重通知ガードを検証する
        const ws = (el as any)._ws as EventTarget;
        ws.dispatchEvent(new Event("error"));
        ws.dispatchEvent(new Event("close"));

        // error/closeが両方発火してもhawc-ai:errorは1回だけ
        expect(errors.length).toBe(1);
        expect(errors[0]).toBeInstanceOf(Error);
        expect((errors[0] as Error).message).toMatch(/WebSocket connection (failed|lost)/);

        cleanup();
      } finally {
        (globalThis as any).WebSocket = realWs;
        setConfig({ remote: { enableRemote: false, remoteSettingType: "config", remoteCoreUrl: "" } });
      }
    });
  });

  describe("setWithAck — エラー伝搬", () => {
    it("不正なprovider設定がerrorイベントとして伝搬する", async () => {
      const { el, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await flush();
      await flush();

      const errors: any[] = [];
      el.addEventListener("hawc-ai:error", (e: Event) => {
        errors.push((e as CustomEvent).detail);
      });

      // 不正なプロバイダを設定 — setWithAckでサーバー側のエラーが返る
      (el as any)._applyProvider("invalid-provider");
      // setWithAck round-trip: client→server (flush) → server process + response (flush) → client handle (flush)
      await flush();
      await flush();
      await flush();
      await flush();

      expect(errors.length).toBeGreaterThan(0);

      cleanup();
    });

    it("不正なprovider設定後のsendは旧providerで送信せずrejectする", async () => {
      const { el, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      el.setAttribute("provider", "openai");
      el.setAttribute("model", "gpt-4o");
      await flush();
      await flush();
      await flush();
      await flush();

      // 不正なproviderへ変更 — setWithAckが非同期にrejectする
      el.setAttribute("provider", "invalid-provider");
      await flush();
      await flush();
      await flush();
      await flush();

      el.prompt = "Hi";
      await expect(el.send()).rejects.toThrow(/Unknown provider|invalid/i);

      cleanup();
    });

    it("invalid→validへ戻してackを待たずにsendしても旧エラーで落ちない", async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        choices: [{ message: { content: "recovered" } }],
      }));

      const { el, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      el.setAttribute("provider", "openai");
      el.setAttribute("model", "gpt-4o");
      el.stream = false;
      await flush();
      await flush();
      await flush();
      await flush();

      // 1. 不正provider → ackがrejectするまで待ち、エラー状態を確立
      el.setAttribute("provider", "invalid-provider");
      await flush();
      await flush();
      await flush();
      await flush();
      expect(el.error).toBeInstanceOf(Error);

      // 2. valid providerへ戻す。ack前にsend()を発火（flushなし）
      el.setAttribute("provider", "openai");
      el.prompt = "Hi";
      const resultPromise = el.send();

      // 3. send()はin-flightな最新provider更新を待ち、旧エラーで拒否しない
      await flush();
      await flush();
      await flush();
      await flush();
      await expect(resultPromise).resolves.toBe("recovered");

      cleanup();
    });

    it("setWithAckエラー後に正しい値を設定するとerrorがクリアされる", async () => {
      const { el, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await flush();
      await flush();

      // 不正なプロバイダでエラーを発生させる
      (el as any)._applyProvider("invalid-provider");
      await flush();
      await flush();
      await flush();
      await flush();

      expect(el.error).not.toBeNull();

      // 正しいプロバイダを設定
      (el as any)._applyProvider("openai");
      await flush();
      await flush();
      await flush();
      await flush();

      // ローカルエラーがクリアされている
      expect(el.error).toBeNull();

      cleanup();
    });

    it("setWithAck成功時にサーバー由来のerrorはクリアされない", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false, status: 401, statusText: "Unauthorized",
        headers: new Headers(), body: null,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve("Unauthorized"),
      } as unknown as Response);

      const { el, core, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await flush();
      await flush();

      // サーバー側でsendを実行してHTTPエラーを発生させる
      core.provider = "openai";
      await core.send("Hi", { model: "gpt-4o", stream: false });
      await flush();
      await flush();

      // サーバーのerrorがクライアントに同期されている
      expect(el.error).not.toBeNull();
      expect(el.error.status).toBe(401);

      // providerを正常に更新
      (el as any)._applyProvider("anthropic");
      await flush();
      await flush();
      await flush();
      await flush();

      // サーバー由来のerrorはクリアされていない
      expect(el.error).not.toBeNull();
      expect(el.error.status).toBe(401);

      cleanup();
    });

    it("messages setter のエラーがerrorイベントとして伝搬する", async () => {
      const { el, core, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await flush();
      await flush();

      // Core側のmessagesセッターをエラーにする
      Object.defineProperty(core, "messages", {
        set: () => { throw new Error("invalid messages"); },
        get: () => [],
      });

      const errors: any[] = [];
      el.addEventListener("hawc-ai:error", (e: Event) => {
        errors.push((e as CustomEvent).detail);
      });

      el.messages = [{ role: "user", content: "test" }];
      await flush();
      await flush();
      await flush();
      await flush();

      expect(errors.length).toBeGreaterThan(0);

      cleanup();
    });
  });

  describe("error revive — リモートError復元", () => {
    it("サーバー側のErrorがリモートクライアントでもErrorインスタンスとして復元される", async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError("Network failure"));

      const { el, core, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await flush();
      await flush();

      core.provider = "openai";
      el.prompt = "Hello";
      el.setAttribute("model", "gpt-4o");
      el.stream = false;

      const resultPromise = el.send();
      await flush();
      await flush();
      await resultPromise;
      await flush();
      await flush();

      expect(el.error).toBeInstanceOf(Error);
      expect(el.error.name).toBe("TypeError");
      expect(el.error.message).toBe("Network failure");

      cleanup();
    });

    it("AiHttpErrorはプレーンオブジェクトのまま復元されない", async () => {
      const { el, core, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await flush();
      await flush();

      // AiHttpError相当のオブジェクトをサーバー側で設定
      (core as any)._setError({ status: 500, statusText: "Internal Server Error", body: "error" });
      await flush();

      expect(el.error).not.toBeInstanceOf(Error);
      expect(el.error.status).toBe(500);

      cleanup();
    });
  });

  describe("error state — リモートエラー状態管理", () => {
    it("サーバーがerror=nullを送信した後にstaleなローカルエラーが残らない", async () => {
      const { el, core, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await flush();
      await flush();

      // sync完了後、_remoteValuesにerrorキーが存在する
      // ここでローカルエラーを設定
      (el as any)._errorState = new Error("local error");

      // サーバーからerror: nullが送信される（send成功時）
      (core as any)._setError(null);
      await flush();

      // bindコールバックが_errorStateをクリアし、_remoteValues.error = null
      // "error" in _remoteValues → true なので null が返る（_errorStateにフォールバックしない）
      expect(el.error).toBeNull();
      expect((el as any)._errorState).toBeNull();

      cleanup();
    });

    it("provider更新失敗中のサーバーerror=null同期はローカルprovider errorを消さない", async () => {
      const { el, core, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      el.setAttribute("provider", "openai");
      el.setAttribute("model", "gpt-4o");
      await flush();
      await flush();
      await flush();
      await flush();

      // provider更新を失敗させてローカルprovider errorを確立
      el.setAttribute("provider", "invalid-provider");
      await flush();
      await flush();
      await flush();
      await flush();

      expect(el.error).toBeInstanceOf(Error);
      expect((el.error as Error).message).toMatch(/Unknown provider/);

      // サーバー側が（別要因で）error=nullを同期してくる
      (core as any)._setError(null);
      await flush();

      // UI上のerrorはprovider errorのまま残り、send()も引き続きreject
      expect(el.error).toBeInstanceOf(Error);
      expect((el.error as Error).message).toMatch(/Unknown provider/);

      el.prompt = "Hi";
      await expect(el.send()).rejects.toThrow(/Unknown provider/);

      cleanup();
    });

    it("リモート接続前はローカルエラーが返される", () => {
      const el = document.createElement("hawc-ai") as Ai;
      (el as any)._errorState = new Error("init error");
      (el as any)._proxy = { fake: true }; // _isRemote = true にする
      // _remoteValuesにerrorキーがない → ローカルエラーにフォールバック
      expect(el.error).toBeInstanceOf(Error);
      expect(el.error.message).toBe("init error");
    });
  });

  describe("send — トランスポートエラー", () => {
    it("dispose済みproxyでsend()するとエラーがerrorイベントで通知される", async () => {
      const { el, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await flush();
      await flush();

      // クライアント側proxyをdispose（invokeが即座にrejectするようになる）
      (el as any)._proxy.dispose();

      const errors: any[] = [];
      el.addEventListener("hawc-ai:error", (e: Event) => {
        errors.push((e as CustomEvent).detail);
      });

      el.prompt = "Hello";
      el.setAttribute("model", "gpt-4o");
      const result = await el.send();

      expect(result).toBeNull();
      expect(errors.length).toBeGreaterThan(0);
      expect(el.error).not.toBeNull();

      cleanup();
    });

    it("ws.sendのraw DOMException(InvalidStateError)はtransport error扱いでloading/streamingをリセットする", async () => {
      const { el, core, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await flush();
      await flush();

      // サーバー側でloading/streamingを立てクライアントに伝播させる
      (core as any)._setLoading(true);
      (core as any)._setStreaming(true);
      await flush();
      expect(el.loading).toBe(true);
      expect(el.streaming).toBe(true);

      // native WebSocket.sendが投げうるraw DOMException
      // （WebSocketClientTransport._closedが立つ前の競合窓）をシミュレート
      const rawErr = new DOMException("Failed to execute 'send' on 'WebSocket'", "InvalidStateError");
      (el as any)._proxy.invokeWithOptions = () => Promise.reject(rawErr);

      const errors: any[] = [];
      el.addEventListener("hawc-ai:error", (e: Event) => {
        errors.push((e as CustomEvent).detail);
      });

      el.prompt = "Hello";
      el.setAttribute("model", "gpt-4o");
      const result = await el.send();

      // transport failure として扱われ、reject されず null が返り、状態がリセットされる
      expect(result).toBeNull();
      expect(errors.length).toBeGreaterThan(0);
      expect(el.loading).toBe(false);
      expect(el.streaming).toBe(false);

      cleanup();
    });

    it("サーバー由来の業務エラー（'closed'/'disposed'を含む）はreject伝搬する", async () => {
      const { el, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await flush();
      await flush();

      // proxy.invokeWithOptionsが業務エラーでrejectする状況を模擬
      // メッセージにclosed/disposedが含まれていてもtransport errorとして扱わないこと
      const businessErrors = [
        new Error("database connection closed"),
        new Error("session disposed"),
      ];
      for (const err of businessErrors) {
        (el as any)._proxy.invokeWithOptions = () => Promise.reject(err);

        el.prompt = "Hi";
        el.setAttribute("model", "gpt-4o");
        await expect(el.send()).rejects.toBe(err);
      }

      cleanup();
    });

    it("transport failure後にloading/streamingがfalseにリセットされる", async () => {
      const { el, core, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await flush();
      await flush();

      // サーバー側でloading=trueを設定してクライアントに伝播させる
      (core as any)._setLoading(true);
      (core as any)._setStreaming(true);
      await flush();

      expect(el.loading).toBe(true);
      expect(el.streaming).toBe(true);

      // クライアント側proxyをdispose（transport切断をシミュレート）
      (el as any)._proxy.dispose();

      el.prompt = "Hello";
      el.setAttribute("model", "gpt-4o");
      await el.send();

      // loading/streamingがリセットされていること
      expect(el.loading).toBe(false);
      expect(el.streaming).toBe(false);

      cleanup();
    });
  });

  describe("trigger — リモートモードでのtrigger", () => {
    it("trigger=trueでリモートsendが実行される", async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        choices: [{ message: { content: "Triggered!" } }],
      }));

      const { el, core, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await flush();
      await flush();

      core.provider = "openai";
      el.prompt = "Hello";
      el.setAttribute("model", "gpt-4o");
      el.stream = false;

      el.trigger = true;

      // コマンド配送 + レスポンス待ち
      await flush();
      await flush();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(el.trigger).toBe(false);

      cleanup();
    });
  });
});
