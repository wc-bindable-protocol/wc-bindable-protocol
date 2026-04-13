import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AiCore } from "../src/core/AiCore";

function createMockResponse(body: any, options: { status?: number; ok?: boolean } = {}): Response {
  const { status = 200, ok = true } = options;
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

function createMockStreamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
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

function sseData(data: string): string {
  return `data: ${data}\n\n`;
}

describe("AiCore", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("EventTargetを継承している", () => {
    const core = new AiCore();
    expect(core).toBeInstanceOf(EventTarget);
  });

  it("wcBindableプロパティが正しく定義されている", () => {
    expect(AiCore.wcBindable.protocol).toBe("wc-bindable");
    expect(AiCore.wcBindable.version).toBe(1);
    expect(AiCore.wcBindable.properties).toHaveLength(6);
    const names = AiCore.wcBindable.properties.map(p => p.name);
    expect(names).toEqual(["content", "messages", "usage", "loading", "streaming", "error"]);
  });

  it("初期状態が正しい", () => {
    const core = new AiCore();
    expect(core.content).toBe("");
    expect(core.messages).toEqual([]);
    expect(core.usage).toBeNull();
    expect(core.loading).toBe(false);
    expect(core.streaming).toBe(false);
    expect(core.error).toBeNull();
    expect(core.provider).toBeNull();
  });

  describe("provider", () => {
    it("文字列でプロバイダを設定できる (openai)", () => {
      const core = new AiCore();
      core.provider = "openai";
      expect(core.provider).not.toBeNull();
    });

    it("文字列でプロバイダを設定できる (anthropic)", () => {
      const core = new AiCore();
      core.provider = "anthropic";
      expect(core.provider).not.toBeNull();
    });

    it("文字列でプロバイダを設定できる (azure-openai)", () => {
      const core = new AiCore();
      core.provider = "azure-openai";
      expect(core.provider).not.toBeNull();
    });

    it("カスタムプロバイダオブジェクトを設定できる", () => {
      const core = new AiCore();
      const custom = {
        buildRequest: vi.fn(),
        parseResponse: vi.fn(),
        parseStreamChunk: vi.fn(),
      };
      core.provider = custom;
      expect(core.provider).toBe(custom);
    });

    it("nullを設定できる", () => {
      const core = new AiCore();
      core.provider = "openai";
      core.provider = null;
      expect(core.provider).toBeNull();
    });

    it("不明なプロバイダ名でエラーをスローする", () => {
      const core = new AiCore();
      expect(() => { core.provider = "unknown"; }).toThrow('[@wc-bindable/hawc-ai] Unknown provider');
    });
  });

  describe("messages", () => {
    it("メッセージの設定と取得ができる", () => {
      const core = new AiCore();
      core.messages = [{ role: "user", content: "Hello" }];
      expect(core.messages).toEqual([{ role: "user", content: "Hello" }]);
    });

    it("設定時にイベントが発火する", () => {
      const core = new AiCore();
      const events: any[] = [];
      core.addEventListener("hawc-ai:messages-changed", (e: Event) => {
        events.push((e as CustomEvent).detail);
      });
      core.messages = [{ role: "user", content: "Hi" }];
      expect(events).toHaveLength(1);
    });

    it("取得値は防御コピーされる", () => {
      const core = new AiCore();
      core.messages = [{ role: "user", content: "Hello" }];
      const msgs = core.messages;
      msgs.push({ role: "assistant", content: "Hi" });
      expect(core.messages).toHaveLength(1);
    });

    it("存在しないメッセージの削除は無視される", () => {
      const core = new AiCore();
      const coreAny = core as any;
      const events: any[] = [];

      core.messages = [{ role: "user", content: "Hello" }];
      core.addEventListener("hawc-ai:messages-changed", (e: Event) => {
        events.push((e as CustomEvent).detail);
      });

      coreAny._removeMessage({ role: "assistant", content: "Missing" });

      expect(core.messages).toEqual([{ role: "user", content: "Hello" }]);
      expect(events).toEqual([]);
    });
  });

  describe("internal helpers", () => {
    it("rAF未提供でもflushを一度だけ予約して実行できる", async () => {
      const core = new AiCore();
      const coreAny = core as any;
      const contents: string[] = [];
      const originalRaf = globalThis.requestAnimationFrame;
      const originalCancel = globalThis.cancelAnimationFrame;

      vi.useFakeTimers();
      globalThis.requestAnimationFrame = undefined as any;
      globalThis.cancelAnimationFrame = undefined as any;

      core.addEventListener("hawc-ai:content-changed", (e: Event) => {
        contents.push((e as CustomEvent).detail);
      });

      coreAny._content = "buffered";
      coreAny._scheduleFlush();
      coreAny._scheduleFlush();

      expect(coreAny._flushScheduled).toBe(true);

      await vi.advanceTimersByTimeAsync(16);

      expect(contents).toEqual(["buffered"]);
      expect(coreAny._flushScheduled).toBe(false);
      expect(coreAny._rafId).toBe(0);

      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancel;
      vi.useRealTimers();
    });

    it("予約済みflushをキャンセルできる", async () => {
      const core = new AiCore();
      const coreAny = core as any;
      const contents: string[] = [];
      const originalRaf = globalThis.requestAnimationFrame;
      const originalCancel = globalThis.cancelAnimationFrame;

      vi.useFakeTimers();
      globalThis.requestAnimationFrame = undefined as any;
      globalThis.cancelAnimationFrame = undefined as any;

      core.addEventListener("hawc-ai:content-changed", (e: Event) => {
        contents.push((e as CustomEvent).detail);
      });

      coreAny._content = "buffered";
      coreAny._scheduleFlush();
      coreAny._cancelFlush();

      await vi.advanceTimersByTimeAsync(16);

      expect(contents).toEqual([]);
      expect(coreAny._flushScheduled).toBe(false);
      expect(coreAny._rafId).toBe(0);

      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancel;
      vi.useRealTimers();
    });

    it("古いストリームはflushせずに早期終了する", async () => {
      const core = new AiCore();
      const coreAny = core as any;
      const contents: string[] = [];
      const encoder = new TextEncoder();
      const staleAbortController = new AbortController();

      core.provider = "openai";
      core.addEventListener("hawc-ai:content-changed", (e: Event) => {
        contents.push((e as CustomEvent).detail);
      });

      coreAny._abortController = new AbortController();

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sseData('{"choices":[{"delta":{"content":"stale"}}]}')));
          controller.enqueue(encoder.encode(sseData("[DONE]")));
          controller.close();
        }
      });

      const result = await coreAny._processStream(body, staleAbortController);

      // stale なストリームは null を返す
      expect(result).toBeNull();
      expect(contents).toEqual([]);
    });

    it("空のストリームでも正常終了できる", async () => {
      const core = new AiCore();
      const coreAny = core as any;
      const abortController = new AbortController();

      core.provider = "openai";
      coreAny._abortController = abortController;

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        }
      });

      const result = await coreAny._processStream(body, abortController);

      expect(result).toBe("");
      expect(core.content).toBe("");
      expect(core.streaming).toBe(false);
      expect(core.loading).toBe(false);
    });

    it("usageマージ時に0トークン値を保持する", () => {
      const core = new AiCore();
      const coreAny = core as any;

      const merged = coreAny._mergeUsage(
        { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
        { promptTokens: 0, completionTokens: 5, totalTokens: 5 }
      );

      expect(merged).toEqual({ promptTokens: 0, completionTokens: 5, totalTokens: 5 });
    });

    it("解釈不能なSSEイベントを無視して継続できる", async () => {
      const core = new AiCore();
      const coreAny = core as any;
      const encoder = new TextEncoder();
      const abortController = new AbortController();

      core.provider = {
        buildRequest: vi.fn(),
        parseResponse: vi.fn(),
        parseStreamChunk: vi
          .fn()
          .mockReturnValueOnce(null)
          .mockReturnValueOnce({ done: true }),
      };
      coreAny._abortController = abortController;

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("event: ignored\ndata: noop\n\n"));
          controller.enqueue(encoder.encode("event: done\ndata: noop\n\n"));
          controller.close();
        }
      });

      const result = await coreAny._processStream(body, abortController);

      expect(result).toBe("");
      expect(core.messages).toEqual([{ role: "assistant", content: "" }]);
    });
  });

  describe("send (非ストリーミング)", () => {
    it("prompt未指定時にエラーをスローする", () => {
      const core = new AiCore();
      core.provider = "openai";
      expect(() => core.send("", { model: "gpt-4o" })).toThrow("[@wc-bindable/hawc-ai] prompt is required.");
    });

    it("provider未設定時にエラーをスローする", () => {
      const core = new AiCore();
      expect(() => core.send("Hello", { model: "gpt-4o" })).toThrow("[@wc-bindable/hawc-ai] provider is required.");
    });

    it("model未指定時にエラーをスローする", () => {
      const core = new AiCore();
      core.provider = "openai";
      expect(() => core.send("Hello", { model: "" })).toThrow("[@wc-bindable/hawc-ai] model is required.");
    });

    it("非ストリーミングリクエストを送信できる", async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        choices: [{ message: { content: "Hi there!" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }));

      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("Hello", { model: "gpt-4o", stream: false });

      expect(result).toBe("Hi there!");
      expect(core.content).toBe("Hi there!");
      expect(core.messages).toEqual([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ]);
      expect(core.usage).toEqual({ promptTokens: 5, completionTokens: 3, totalTokens: 8 });
      expect(core.loading).toBe(false);
    });

    it("systemメッセージをAPIリクエストに含める", async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        choices: [{ message: { content: "OK" } }],
      }));

      const core = new AiCore();
      core.provider = "openai";
      await core.send("Hello", { model: "gpt-4o", stream: false, system: "Be helpful" });

      const [_url, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.messages[0]).toEqual({ role: "system", content: "Be helpful" });
      expect(body.messages[1]).toEqual({ role: "user", content: "Hello" });
    });

    it("HTTPエラーレスポンスを処理できる", async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse("Bad Request", { status: 400, ok: false }));

      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("Hello", { model: "gpt-4o", stream: false });

      expect(result).toBeNull();
      expect(core.error).not.toBeNull();
      expect(core.error.status).toBe(400);
      expect(core.messages).toEqual([]);
      expect(core.loading).toBe(false);
    });

    it("新しいリクエスト開始時に前回のusageがリセットされる", async () => {
      // 1回目: usageありで成功
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        choices: [{ message: { content: "OK" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));

      const core = new AiCore();
      core.provider = "openai";
      await core.send("Hello", { model: "gpt-4o", stream: false });
      expect(core.usage).not.toBeNull();

      // 2回目: エラーで失敗
      fetchSpy.mockResolvedValueOnce(createMockResponse("Error", { status: 500, ok: false }));
      await core.send("Hello again", { model: "gpt-4o", stream: false });

      // 前回のusageが残っていないこと
      expect(core.usage).toBeNull();
    });

    it("新しいリクエスト開始時にusage-changedイベントでnullが通知される", async () => {
      // 1回目: usageありで成功
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        choices: [{ message: { content: "OK" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));

      const core = new AiCore();
      core.provider = "openai";
      await core.send("Hello", { model: "gpt-4o", stream: false });

      const usageEvents: any[] = [];
      core.addEventListener("hawc-ai:usage-changed", (e: Event) => {
        usageEvents.push((e as CustomEvent).detail);
      });

      // 2回目: エラーで失敗
      fetchSpy.mockResolvedValueOnce(createMockResponse("Error", { status: 500, ok: false }));
      await core.send("Hello again", { model: "gpt-4o", stream: false });

      // リクエスト開始時にnullが通知されていること
      expect(usageEvents[0]).toBeNull();
    });

    it("HTTPエラー本文の読み取り失敗時は空文字を使う", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        headers: new Headers({ "Content-Type": "text/plain" }),
        body: null,
        json: () => Promise.reject(new Error("unused")),
        text: () => Promise.reject(new Error("text failed")),
      } as unknown as Response);

      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("Hello", { model: "gpt-4o", stream: false });

      expect(result).toBeNull();
      expect(core.error).toEqual({
        status: 502,
        statusText: "Bad Gateway",
        body: "",
      });
      expect(core.messages).toEqual([]);
      expect(core.loading).toBe(false);
    });

    it("ネットワークエラーを処理できる", async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("Hello", { model: "gpt-4o", stream: false });

      expect(result).toBeNull();
      expect(core.error).toBeInstanceOf(TypeError);
      expect(core.error.message).toBe("Failed to fetch");
      expect(core.messages).toEqual([]);
      expect(core.loading).toBe(false);
    });

    it("buildRequestの例外でもloadingとmessagesが正しくリセットされる", async () => {
      const core = new AiCore();
      core.provider = "azure-openai";
      // base-url未設定でAzureOpenAiProviderがthrowする
      const result = await core.send("Hello", { model: "gpt-4o", stream: false });

      expect(result).toBeNull();
      expect(core.error).not.toBeNull();
      expect(core.loading).toBe(false);
      expect(core.messages).toEqual([]);
    });

    it("ErrorにtoJSONが付与されリモート直列化で情報が保持される", async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError("Network error"));

      const core = new AiCore();
      core.provider = "openai";
      await core.send("Hello", { model: "gpt-4o", stream: false });

      // instanceofが維持されている
      expect(core.error).toBeInstanceOf(TypeError);
      // toJSONが付与されている
      expect(typeof core.error.toJSON).toBe("function");
      // JSON.stringifyで情報が保持される
      const serialized = JSON.parse(JSON.stringify(core.error));
      expect(serialized.name).toBe("TypeError");
      expect(serialized.message).toBe("Network error");
      expect(serialized.stack).toBeDefined();
    });
  });

  describe("send (ストリーミング)", () => {
    it("ストリーミングレスポンスを処理できる", async () => {
      const chunks = [
        sseData('{"choices":[{"delta":{"content":"Hello"}}]}'),
        sseData('{"choices":[{"delta":{"content":" world"}}]}'),
        sseData("[DONE]"),
      ];
      fetchSpy.mockResolvedValueOnce(createMockStreamResponse(chunks));

      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("Hi", { model: "gpt-4o" });

      expect(result).toBe("Hello world");
      expect(core.content).toBe("Hello world");
      expect(core.messages).toEqual([
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello world" },
      ]);
      expect(core.streaming).toBe(false);
      expect(core.loading).toBe(false);
    });

    it("ストリーミング中にloading/streamingイベントが発火する", async () => {
      const chunks = [
        sseData('{"choices":[{"delta":{"content":"Hi"}}]}'),
        sseData("[DONE]"),
      ];
      fetchSpy.mockResolvedValueOnce(createMockStreamResponse(chunks));

      const core = new AiCore();
      core.provider = "openai";
      const events: Array<{ name: string; detail: any }> = [];
      core.addEventListener("hawc-ai:loading-changed", (e: Event) => {
        events.push({ name: "loading", detail: (e as CustomEvent).detail });
      });
      core.addEventListener("hawc-ai:streaming-changed", (e: Event) => {
        events.push({ name: "streaming", detail: (e as CustomEvent).detail });
      });

      await core.send("Hello", { model: "gpt-4o" });

      expect(events.some(e => e.name === "loading" && e.detail === true)).toBe(true);
      expect(events.some(e => e.name === "streaming" && e.detail === true)).toBe(true);
      expect(events.some(e => e.name === "streaming" && e.detail === false)).toBe(true);
      expect(events.some(e => e.name === "loading" && e.detail === false)).toBe(true);
    });

    it("rAFバッチングでストリーミング中にcontent-changedが発火する", async () => {
      // チャンク間で遅延を入れてrAFコールバックが発火する時間を確保
      const encoder = new TextEncoder();
      let chunkIndex = 0;
      const chunkData = [
        sseData('{"choices":[{"delta":{"content":"A"}}]}'),
        sseData('{"choices":[{"delta":{"content":"B"}}]}'),
        sseData("[DONE]"),
      ];
      const stream = new ReadableStream({
        pull(controller) {
          return new Promise(resolve => {
            setTimeout(() => {
              if (chunkIndex < chunkData.length) {
                controller.enqueue(encoder.encode(chunkData[chunkIndex++]));
              } else {
                controller.close();
              }
              resolve();
            }, 20);
          });
        }
      });
      const response = {
        ok: true, status: 200, statusText: "OK",
        headers: new Headers({ "Content-Type": "text/event-stream" }),
        body: stream, json: () => Promise.reject(), text: () => Promise.reject(),
      } as unknown as Response;
      fetchSpy.mockResolvedValueOnce(response);

      const core = new AiCore();
      core.provider = "openai";
      const contentEvents: string[] = [];
      core.addEventListener("hawc-ai:content-changed", (e: Event) => {
        contentEvents.push((e as CustomEvent).detail);
      });

      await core.send("Hi", { model: "gpt-4o" });

      // rAFバッチング経由の中間更新 + 最終フラッシュ
      expect(contentEvents.length).toBeGreaterThanOrEqual(2);
      expect(contentEvents[contentEvents.length - 1]).toBe("AB");
    });

    it("ストリーミングでusageを収集する", async () => {
      const chunks = [
        sseData('{"choices":[{"delta":{"content":"Hi"}}]}'),
        sseData('{"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}'),
        sseData("[DONE]"),
      ];
      fetchSpy.mockResolvedValueOnce(createMockStreamResponse(chunks));

      const core = new AiCore();
      core.provider = "openai";
      await core.send("Hello", { model: "gpt-4o" });

      expect(core.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    });

    it("usage値が0のみのストリーミングでmergeが正しく動作する", async () => {
      // usage.prompt_tokens=0, completion_tokens=0 のみのチャンク
      const chunks = [
        sseData('{"choices":[{"delta":{"content":"X"}}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}'),
        sseData("[DONE]"),
      ];
      fetchSpy.mockResolvedValueOnce(createMockStreamResponse(chunks));

      const core = new AiCore();
      core.provider = "openai";
      await core.send("Hi", { model: "gpt-4o" });

      expect(core.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    });

    it("Anthropicプロバイダでストリーミングできる", async () => {
      const chunks = [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" from Claude"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":10}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      fetchSpy.mockResolvedValueOnce(createMockStreamResponse(chunks));

      const core = new AiCore();
      core.provider = "anthropic";
      const result = await core.send("Hi", { model: "claude-sonnet-4-20250514" });

      expect(result).toBe("Hello from Claude");
      expect(core.usage).toEqual({ promptTokens: 25, completionTokens: 10, totalTokens: 35 });
    });

    it("末尾の空行なしで閉じたストリームでも最後のdeltaが反映される", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // 正規の空行付きチャンク
          controller.enqueue(encoder.encode(sseData('{"choices":[{"delta":{"content":"Hello"}}]}')));
          // 末尾の空行なしで閉じるチャンク（\n のみ、\n\n ではない）
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" world"}}]}\n'));
          controller.close();
        },
      });
      const response = {
        ok: true, status: 200, statusText: "OK",
        headers: new Headers({ "Content-Type": "text/event-stream" }),
        body: stream, json: () => Promise.reject(), text: () => Promise.reject(),
      } as unknown as Response;
      fetchSpy.mockResolvedValueOnce(response);

      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("Hi", { model: "gpt-4o" });

      expect(result).toBe("Hello world");
    });

    it("末尾の空行なしで閉じたストリームでもusageが反映される", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sseData('{"choices":[{"delta":{"content":"Hi"}}]}')));
          // usageチャンクが空行なしで閉じる
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n'));
          controller.close();
        },
      });
      const response = {
        ok: true, status: 200, statusText: "OK",
        headers: new Headers({ "Content-Type": "text/event-stream" }),
        body: stream, json: () => Promise.reject(), text: () => Promise.reject(),
      } as unknown as Response;
      fetchSpy.mockResolvedValueOnce(response);

      const core = new AiCore();
      core.provider = "openai";
      await core.send("Hi", { model: "gpt-4o" });

      expect(core.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    });

    it("stream=trueでもサーバーがJSONを返した場合はJSONとして処理する", async () => {
      // サーバーがstreamリクエストを無視してJSONで返すケース
      const response = {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "Content-Type": "application/json" }),
        body: new ReadableStream(), // bodyは存在するがContent-TypeがSSEではない
        json: () => Promise.resolve({
          choices: [{ message: { content: "JSON fallback" } }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
        text: () => Promise.resolve(""),
      } as unknown as Response;
      fetchSpy.mockResolvedValueOnce(response);

      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("Hi", { model: "gpt-4o" });

      expect(result).toBe("JSON fallback");
      expect(core.content).toBe("JSON fallback");
      expect(core.usage).toEqual({ promptTokens: 5, completionTokens: 3, totalTokens: 8 });
    });

    it("マルチバイト文字がチャンク境界で分割されても欠落しない", async () => {
      const encoder = new TextEncoder();
      // "こんにちは" の UTF-8 バイト列をチャンク境界でマルチバイト文字の途中で分割する
      const fullText = 'data: {"choices":[{"delta":{"content":"こんにちは"}}]}\n\ndata: [DONE]\n\n';
      const bytes = encoder.encode(fullText);
      // UTF-8 の "こ" は 3 バイト (E3 81 93)。2バイト目で切る
      const splitAt = bytes.indexOf(0x81);
      const chunk1 = bytes.slice(0, splitAt);
      const chunk2 = bytes.slice(splitAt);

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk1);
          controller.enqueue(chunk2);
          controller.close();
        },
      });
      const response = {
        ok: true, status: 200, statusText: "OK",
        headers: new Headers({ "Content-Type": "text/event-stream" }),
        body: stream, json: () => Promise.reject(), text: () => Promise.reject(),
      } as unknown as Response;
      fetchSpy.mockResolvedValueOnce(response);

      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("Hi", { model: "gpt-4o" });

      expect(result).toBe("こんにちは");
    });
  });

  describe("abort", () => {
    it("ストリーミング中にabortできる", async () => {
      fetchSpy.mockImplementationOnce((_url, init) => {
        return new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      });

      const core = new AiCore();
      core.provider = "openai";
      const promise = core.send("Hello", { model: "gpt-4o" });
      core.abort();

      const result = await promise;
      expect(result).toBeNull();
      expect(core.loading).toBe(false);
    });

    it("abort時にユーザーメッセージが履歴から除去される", async () => {
      fetchSpy.mockImplementationOnce((_url, init) => {
        return new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      });

      const core = new AiCore();
      core.provider = "openai";
      const promise = core.send("Hello", { model: "gpt-4o" });
      core.abort();

      await promise;
      expect(core.messages).toEqual([]);
    });

    it("重なったsend()が状態を壊さない", async () => {
      // 1回目: abortされるまで解決しない
      fetchSpy.mockImplementationOnce((_url, init) => {
        return new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      });
      // 2回目: 即座に応答
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        choices: [{ message: { content: "Second response" } }],
      }));

      const core = new AiCore();
      core.provider = "openai";

      const first = core.send("First", { model: "gpt-4o", stream: false });
      const second = core.send("Second", { model: "gpt-4o", stream: false });

      const [result1, result2] = await Promise.all([first, second]);

      expect(result1).toBeNull();
      expect(result2).toBe("Second response");
      expect(core.loading).toBe(false);
      // 1回目のユーザーメッセージは除去され、2回目のやり取りのみ残る
      expect(core.messages).toEqual([
        { role: "user", content: "Second" },
        { role: "assistant", content: "Second response" },
      ]);
      expect(core.content).toBe("Second response");
    });

    it("重なったsend()でabortControllerが潰されない", async () => {
      // 1回目: abortされるまで解決しない
      fetchSpy.mockImplementationOnce((_url, init) => {
        return new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      });
      // 2回目: やや遅延して応答
      fetchSpy.mockImplementationOnce(() => {
        return new Promise(resolve => {
          setTimeout(() => resolve(createMockResponse({
            choices: [{ message: { content: "OK" } }],
          })), 50);
        });
      });

      const core = new AiCore();
      core.provider = "openai";

      const first = core.send("First", { model: "gpt-4o", stream: false });
      const second = core.send("Second", { model: "gpt-4o", stream: false });

      // 1回目のAbortError catchが2回目のloadingをfalseにしないことを確認
      await first;
      expect(core.loading).toBe(true); // 2回目がまだ進行中

      await second;
      expect(core.loading).toBe(false);
    });

    it("ストリーミング中にresendするとstreamingがリセットされる", async () => {
      // 1回目: ストリーミングで開始、abortされるまでハング
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

      const core = new AiCore();
      core.provider = "openai";

      const first = core.send("First", { model: "gpt-4o" });
      // 1回目のfetchが解決するまで少し待つ（ストリーミング開始）
      await new Promise(r => setTimeout(r, 10));

      // 2回目を開始（1回目をabort）
      const second = core.send("Second", { model: "gpt-4o", stream: false });

      const [result1, result2] = await Promise.all([first, second]);
      expect(result1).toBeNull();
      expect(result2).toBe("OK");
      // streamingがfalseにリセットされていること
      expect(core.streaming).toBe(false);
      expect(core.loading).toBe(false);
    });

    it("重なったストリーミングsend()でも正しく動作する", async () => {
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

      const core = new AiCore();
      core.provider = "openai";

      const first = core.send("First", { model: "gpt-4o" });
      const second = core.send("Second", { model: "gpt-4o" });

      const [result1, result2] = await Promise.all([first, second]);

      expect(result1).toBeNull();
      expect(result2).toBe("Streamed");
      expect(core.streaming).toBe(false);
      expect(core.loading).toBe(false);
      expect(core.messages).toEqual([
        { role: "user", content: "Second" },
        { role: "assistant", content: "Streamed" },
      ]);
    });

    it("1回目がHTTPエラーで遅延完了しても2回目の状態を壊さない", async () => {
      // 1回目: 遅延して500応答
      fetchSpy.mockImplementationOnce(() => {
        return new Promise(resolve => {
          setTimeout(() => resolve(createMockResponse("Internal Server Error", { status: 500, ok: false })), 50);
        });
      });
      // 2回目: さらに遅延して成功
      fetchSpy.mockImplementationOnce(() => {
        return new Promise(resolve => {
          setTimeout(() => resolve(createMockResponse({
            choices: [{ message: { content: "Success" } }],
          })), 100);
        });
      });

      const core = new AiCore();
      core.provider = "openai";

      const first = core.send("First", { model: "gpt-4o", stream: false });
      const second = core.send("Second", { model: "gpt-4o", stream: false });

      const [result1, result2] = await Promise.all([first, second]);

      // 1回目はAbortErrorでnull（abortされた場合）またはnull（HTTPエラー）
      expect(result1).toBeNull();
      expect(result2).toBe("Success");
      // 1回目のHTTPエラーが2回目のloading/errorを上書きしていないこと
      expect(core.loading).toBe(false);
      expect(core.error).toBeNull();
      expect(core.messages).toEqual([
        { role: "user", content: "Second" },
        { role: "assistant", content: "Success" },
      ]);
    });

    it("1回目が一般例外で遅延完了しても2回目の状態を壊さない", async () => {
      // 1回目: 遅延してネットワークエラー
      fetchSpy.mockImplementationOnce(() => {
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(new TypeError("Network error")), 50);
        });
      });
      // 2回目: さらに遅延して成功
      fetchSpy.mockImplementationOnce(() => {
        return new Promise(resolve => {
          setTimeout(() => resolve(createMockResponse({
            choices: [{ message: { content: "OK" } }],
          })), 100);
        });
      });

      const core = new AiCore();
      core.provider = "openai";

      const first = core.send("First", { model: "gpt-4o", stream: false });
      const second = core.send("Second", { model: "gpt-4o", stream: false });

      const [result1, result2] = await Promise.all([first, second]);

      expect(result1).toBeNull();
      expect(result2).toBe("OK");
      expect(core.loading).toBe(false);
      expect(core.error).toBeNull();
      expect(core.messages).toEqual([
        { role: "user", content: "Second" },
        { role: "assistant", content: "OK" },
      ]);
    });

    it("1回目が非ストリーミング成功で遅延完了しても2回目を壊さない", async () => {
      // 1回目: 遅延して成功
      fetchSpy.mockImplementationOnce(() => {
        return new Promise(resolve => {
          setTimeout(() => resolve(createMockResponse({
            choices: [{ message: { content: "Stale" } }],
          })), 50);
        });
      });
      // 2回目: さらに遅延して成功
      fetchSpy.mockImplementationOnce(() => {
        return new Promise(resolve => {
          setTimeout(() => resolve(createMockResponse({
            choices: [{ message: { content: "Fresh" } }],
          })), 100);
        });
      });

      const core = new AiCore();
      core.provider = "openai";

      const first = core.send("First", { model: "gpt-4o", stream: false });
      const second = core.send("Second", { model: "gpt-4o", stream: false });

      const [result1, result2] = await Promise.all([first, second]);

      // 1回目はabortされてnull
      expect(result1).toBeNull();
      expect(result2).toBe("Fresh");
      expect(core.loading).toBe(false);
      expect(core.content).toBe("Fresh");
      // 1回目のassistantメッセージが履歴に混入していないこと
      expect(core.messages).toEqual([
        { role: "user", content: "Second" },
        { role: "assistant", content: "Fresh" },
      ]);
    });

    it("ストリームAの遅延チャンクがストリームBのcontentを汚染しない", async () => {
      const encoder = new TextEncoder();
      let streamAController: ReadableStreamDefaultController<Uint8Array> | null = null;

      // 1回目: チャンクを手動で送れるストリーム
      fetchSpy.mockImplementationOnce((_url, init) => {
        const signal = (init as RequestInit).signal!;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamAController = controller;
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

      // 2回目: 即座に応答する非ストリーミング
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        choices: [{ message: { content: "Fresh" } }],
      }));

      const core = new AiCore();
      core.provider = "openai";

      // ストリームAを開始
      const firstPromise = core.send("First", { model: "gpt-4o" });

      // ストリームAにチャンクを送り込む
      await new Promise(r => setTimeout(r, 10));
      streamAController!.enqueue(encoder.encode(
        sseData('{"choices":[{"delta":{"content":"STALE"}}]}')
      ));
      await new Promise(r => setTimeout(r, 10));

      // ストリームBを開始（Aをabortする）
      const secondPromise = core.send("Second", { model: "gpt-4o", stream: false });

      // Aのストリームが閉じた後にさらにチャンクが残っていた場合をシミュレート
      // (abort によりストリームは閉じられるが、イベントループの順序で
      //  既にバッファされたチャンクが処理される可能性がある)
      await new Promise(r => setTimeout(r, 10));

      const [result1, result2] = await Promise.all([firstPromise, secondPromise]);

      // abort されたストリームは null を返す
      expect(result1).toBeNull();
      expect(result2).toBe("Fresh");
      // 重要: ストリームAの "STALE" delta がストリームBの content に混入していないこと
      expect(core.content).toBe("Fresh");
      expect(core.content).not.toContain("STALE");
    });
  });

  describe("target指定", () => {
    it("target未指定時はイベントが自身にディスパッチされる", async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        choices: [{ message: { content: "Hi" } }],
      }));

      const core = new AiCore();
      core.provider = "openai";
      const events: string[] = [];
      core.addEventListener("hawc-ai:content-changed", () => events.push("content"));

      await core.send("Hello", { model: "gpt-4o", stream: false });
      expect(events.length).toBeGreaterThan(0);
    });

    it("target指定時はイベントがtargetにディスパッチされる", async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        choices: [{ message: { content: "Hi" } }],
      }));

      const target = new EventTarget();
      const core = new AiCore(target);
      core.provider = "openai";
      const coreEvents: string[] = [];
      const targetEvents: string[] = [];

      core.addEventListener("hawc-ai:content-changed", () => coreEvents.push("content"));
      target.addEventListener("hawc-ai:content-changed", () => targetEvents.push("content"));

      await core.send("Hello", { model: "gpt-4o", stream: false });
      expect(coreEvents).toEqual([]);
      expect(targetEvents.length).toBeGreaterThan(0);
    });
  });

  describe("会話履歴", () => {
    it("複数のsendで履歴が蓄積される", async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        choices: [{ message: { content: "Hi!" } }],
      }));
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        choices: [{ message: { content: "I'm fine." } }],
      }));

      const core = new AiCore();
      core.provider = "openai";
      await core.send("Hello", { model: "gpt-4o", stream: false });
      await core.send("How are you?", { model: "gpt-4o", stream: false });

      expect(core.messages).toEqual([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "How are you?" },
        { role: "assistant", content: "I'm fine." },
      ]);
    });

    it("messagesを直接設定して履歴をリセットできる", async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        choices: [{ message: { content: "Hi!" } }],
      }));

      const core = new AiCore();
      core.provider = "openai";
      await core.send("Hello", { model: "gpt-4o", stream: false });
      expect(core.messages).toHaveLength(2);

      core.messages = [];
      expect(core.messages).toHaveLength(0);
    });
  });
});
