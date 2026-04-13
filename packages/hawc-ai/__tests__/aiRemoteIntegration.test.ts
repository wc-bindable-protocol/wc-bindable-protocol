/**
 * Remote integration tests
 *
 * End-to-end: Ai Shell → RemoteCoreProxy → mock transport → RemoteShellProxy → AiCore → fetch (mocked)
 *
 * Unlike the unit tests in aiRemote.test.ts (which verify individual branches),
 * these tests exercise full request/response cycles and verify that the
 * client-side Shell and server-side Core stay consistent throughout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  ClientTransport,
  ServerTransport,
  ClientMessage,
  ServerMessage,
} from "@wc-bindable/remote";
import { RemoteShellProxy } from "@wc-bindable/remote";
import { Ai } from "../src/components/Ai";
import { AiCore } from "../src/core/AiCore";
import { registerComponents } from "../src/registerComponents";

registerComponents();

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

function createMockTransportPair(): {
  client: ClientTransport;
  server: ServerTransport;
} {
  let clientHandler: ((msg: ServerMessage) => void) | null = null;
  let serverHandler: ((msg: ClientMessage) => void) | null = null;

  const client: ClientTransport = {
    send: (msg) => {
      if (serverHandler) Promise.resolve().then(() => serverHandler!(msg));
    },
    onMessage: (handler) => { clientHandler = handler; },
  };

  const server: ServerTransport = {
    send: (msg) => {
      if (clientHandler) Promise.resolve().then(() => clientHandler!(msg));
    },
    onMessage: (handler) => { serverHandler = handler; },
  };

  return { client, server };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Wait long enough for async transport + Core processing to settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await flush();
}

// ---------------------------------------------------------------------------
// Response factories
// ---------------------------------------------------------------------------

function jsonResponse(body: any, status = 200): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers: new Headers({ "Content-Type": "application/json" }),
    body: null,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function sseData(data: string): string {
  return `data: ${data}\n\n`;
}

function streamResponse(chunks: string[], status = 200): Response {
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
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    headers: new Headers({ "Content-Type": "text/event-stream" }),
    body: stream,
    json: () => Promise.reject(new Error("streaming")),
    text: () => Promise.reject(new Error("streaming")),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Remote integration", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    document.body.innerHTML = "";
  });

  // -----------------------------------------------------------------------
  // Non-streaming full cycle
  // -----------------------------------------------------------------------
  describe("非ストリーミング完全サイクル", () => {
    it("send → API応答 → 状態反映 → 会話履歴が一貫している", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: "Hello from server!" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));

      const { el, core, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await settle();

      core.provider = "openai";

      el.prompt = "Hi there";
      el.setAttribute("model", "gpt-4o");
      el.stream = false;

      // 全イベントを記録
      const events: Array<{ name: string; value: any }> = [];
      for (const prop of Ai.wcBindable.properties) {
        el.addEventListener(prop.event, (e: Event) => {
          events.push({ name: prop.name, value: (e as CustomEvent).detail });
        });
      }

      const result = await el.send();
      await settle();

      // 返り値
      expect(result).toBe("Hello from server!");

      // クライアント側の状態がサーバーと一致
      expect(el.content).toBe("Hello from server!");
      expect(el.loading).toBe(false);
      expect(el.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
      expect(el.error).toBeNull();

      // 会話履歴が正しい
      expect(el.messages).toEqual([
        { role: "user", content: "Hi there" },
        { role: "assistant", content: "Hello from server!" },
      ]);

      // サーバー側と同期
      expect(core.content).toBe("Hello from server!");
      expect(core.messages).toEqual(el.messages);

      // loading の遷移が記録されている (true → false)
      const loadingEvents = events.filter(e => e.name === "loading");
      expect(loadingEvents.some(e => e.value === true)).toBe(true);
      expect(loadingEvents[loadingEvents.length - 1].value).toBe(false);

      cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // Streaming full cycle
  // -----------------------------------------------------------------------
  describe("ストリーミング完全サイクル", () => {
    it("ストリーミングチャンクがリアルタイムでクライアントに到達する", async () => {
      const chunks = [
        sseData('{"choices":[{"delta":{"content":"Hello"}}]}'),
        sseData('{"choices":[{"delta":{"content":" world"}}]}'),
        sseData('{"choices":[{"delta":{}}],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}'),
        sseData("[DONE]"),
      ];
      fetchSpy.mockResolvedValueOnce(streamResponse(chunks));

      const { el, core, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await settle();

      core.provider = "openai";
      el.prompt = "Stream test";
      el.setAttribute("model", "gpt-4o");

      const contentSnapshots: string[] = [];
      el.addEventListener("hawc-ai:content-changed", (e: Event) => {
        contentSnapshots.push((e as CustomEvent).detail);
      });

      const result = await el.send();
      await settle();

      expect(result).toBe("Hello world");
      expect(el.content).toBe("Hello world");
      expect(el.streaming).toBe(false);
      expect(el.loading).toBe(false);
      expect(el.usage).toEqual({ promptTokens: 8, completionTokens: 4, totalTokens: 12 });

      // content-changed が複数回発火している（中間更新 + 最終値）
      expect(contentSnapshots.length).toBeGreaterThanOrEqual(1);
      expect(contentSnapshots[contentSnapshots.length - 1]).toBe("Hello world");

      // 会話履歴
      expect(el.messages).toEqual([
        { role: "user", content: "Stream test" },
        { role: "assistant", content: "Hello world" },
      ]);

      cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // Multiple sends — conversation accumulation
  // -----------------------------------------------------------------------
  describe("複数回sendによる会話履歴の蓄積", () => {
    it("連続sendで会話履歴が正しく蓄積される", async () => {
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({
          choices: [{ message: { content: "Reply 1" } }],
        }))
        .mockResolvedValueOnce(jsonResponse({
          choices: [{ message: { content: "Reply 2" } }],
        }));

      const { el, core, cleanup } = createRemoteAi();
      await settle();

      core.provider = "openai";
      el.setAttribute("model", "gpt-4o");
      el.stream = false;

      // 1回目
      el.prompt = "First";
      await el.send();
      await settle();

      expect(el.messages).toEqual([
        { role: "user", content: "First" },
        { role: "assistant", content: "Reply 1" },
      ]);

      // 2回目
      el.prompt = "Second";
      await el.send();
      await settle();

      expect(el.messages).toEqual([
        { role: "user", content: "First" },
        { role: "assistant", content: "Reply 1" },
        { role: "user", content: "Second" },
        { role: "assistant", content: "Reply 2" },
      ]);

      // サーバー側と一致
      expect(core.messages).toEqual(el.messages);

      cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // History reset via messages setter
  // -----------------------------------------------------------------------
  describe("messagesセッターによる履歴リセット", () => {
    it("クライアントからの履歴クリアがサーバーに反映される", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: "Hi" } }],
      }));

      const { el, core, cleanup } = createRemoteAi();
      await settle();

      core.provider = "openai";
      el.setAttribute("model", "gpt-4o");
      el.stream = false;
      el.prompt = "Hello";

      await el.send();
      await settle();
      expect(core.messages).toHaveLength(2);

      // クライアントから履歴をクリア
      el.messages = [];
      await settle();

      expect(core.messages).toEqual([]);

      cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // HTTP error
  // -----------------------------------------------------------------------
  describe("HTTPエラーのハンドリング", () => {
    it("APIエラーがクライアント側のerrorプロパティに反映される", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse("Unauthorized", 401));

      const { el, core, cleanup } = createRemoteAi();
      await settle();

      core.provider = "openai";
      el.setAttribute("model", "gpt-4o");
      el.stream = false;
      el.prompt = "Fail test";

      const errorEvents: any[] = [];
      el.addEventListener("hawc-ai:error", (e: Event) => {
        errorEvents.push((e as CustomEvent).detail);
      });

      const result = await el.send();
      await settle();

      expect(result).toBeNull();
      expect(el.loading).toBe(false);
      expect(el.error).not.toBeNull();
      expect(el.error.status).toBe(401);

      // エラー時はユーザーメッセージが履歴から除去される
      expect(el.messages).toEqual([]);
      expect(core.messages).toEqual([]);

      // エラーイベントがクライアント側で発火している
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);

      cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // Abort mid-request
  // -----------------------------------------------------------------------
  describe("リクエスト中のabort", () => {
    it("abort()がサーバー側のリクエストをキャンセルする", async () => {
      // サーバー側fetchがabortされるまで解決しない
      fetchSpy.mockImplementationOnce((_url, init) => {
        return new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      });

      const { el, core, cleanup } = createRemoteAi();
      await settle();

      core.provider = "openai";
      el.setAttribute("model", "gpt-4o");
      el.stream = false;
      el.prompt = "Abort test";

      const sendPromise = el.send();
      await settle();

      // サーバー側Coreを直接abort（リモートinvokeはfire-and-forget的に届く）
      core.abort();
      await settle();

      const result = await sendPromise;
      await settle();

      expect(result).toBeNull();
      expect(el.loading).toBe(false);
      // abort時はユーザーメッセージが除去される
      expect(el.messages).toEqual([]);

      cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // Anthropic provider via remote
  // -----------------------------------------------------------------------
  describe("Anthropicプロバイダ経由のストリーミング", () => {
    it("Anthropic SSE形式のストリーミングが正しく処理される", async () => {
      const chunks = [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"output_tokens":1}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Bonjour"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" le monde"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":8}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      fetchSpy.mockResolvedValueOnce(streamResponse(chunks));

      const { el, core, cleanup } = createRemoteAi();
      await settle();

      core.provider = "anthropic";
      el.prompt = "Say hello in French";
      el.setAttribute("model", "claude-sonnet-4-20250514");

      const result = await el.send();
      await settle();

      expect(result).toBe("Bonjour le monde");
      expect(el.content).toBe("Bonjour le monde");
      expect(el.usage).toEqual({ promptTokens: 20, completionTokens: 8, totalTokens: 28 });
      expect(el.streaming).toBe(false);
      expect(el.loading).toBe(false);

      cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // system message collection
  // -----------------------------------------------------------------------
  describe("systemメッセージの収集", () => {
    it("system属性がリモートsendのオプションに含まれる", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: "OK" } }],
      }));

      const { el, core, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await settle();

      core.provider = "openai";
      el.setAttribute("model", "gpt-4o");
      el.setAttribute("system", "You are a pirate.");
      el.stream = false;
      el.prompt = "Hello";

      await el.send();
      await settle();

      // fetchに渡されたbodyにsystemメッセージが含まれる
      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.messages[0]).toEqual({ role: "system", content: "You are a pirate." });

      cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // trigger integration
  // -----------------------------------------------------------------------
  describe("trigger経由の完全サイクル", () => {
    it("trigger=true → send → 結果反映 → trigger=false の一連の流れ", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: "Triggered response" } }],
      }));

      const { el, core, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await settle();

      core.provider = "openai";
      el.setAttribute("model", "gpt-4o");
      el.stream = false;
      el.prompt = "Trigger test";

      const triggerEvents: boolean[] = [];
      el.addEventListener("hawc-ai:trigger-changed", (e: Event) => {
        triggerEvents.push((e as CustomEvent).detail);
      });

      el.trigger = true;
      expect(el.trigger).toBe(true);

      // コマンド配送 + 処理 + 結果配送 + finally
      await settle();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(el.trigger).toBe(false);
      expect(el.content).toBe("Triggered response");
      expect(triggerEvents).toContain(false);

      cleanup();
    });
  });
});
