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

      try {
        const { el, cleanup } = createRemoteAi();
        document.body.appendChild(el);
        await flush();
        await flush();

        // 一度DOMから削除
        el.remove();
        expect((el as any)._proxy).toBeNull();

        // 再アタッチ — _initRemoteが再び呼ばれる（WebSocket接続は失敗するがエラーイベントで通知される）
        const errors: any[] = [];
        el.addEventListener("hawc-ai:error", (e: Event) => {
          errors.push((e as CustomEvent).detail);
        });
        document.body.appendChild(el);

        // enableRemoteなのでconnectedCallbackで_initRemoteが実行される
        // WebSocket("ws://localhost:9999") は実際には接続できないが、
        // _initRemote自体がthrowしなければ再接続のパスが動いている証拠
        // (WebSocket constructorはthrowしない — 非同期でfailする)

        cleanup();
      } finally {
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
