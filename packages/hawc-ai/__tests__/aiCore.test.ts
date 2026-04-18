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

    it("文字列でプロバイダを設定できる (google)", () => {
      const core = new AiCore();
      core.provider = "google";
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

  describe("send — 入力検証", () => {
    it("temperatureがNaN/Infinityの場合エラーをスローする", () => {
      const core = new AiCore();
      core.provider = "openai";
      for (const bad of [NaN, Infinity, -Infinity]) {
        expect(() => core.send("Hi", { model: "gpt-4o", temperature: bad }))
          .toThrow(/temperature must be a finite number/);
      }
    });

    it("maxTokensが0/負/非整数の場合エラーをスローする", () => {
      const core = new AiCore();
      core.provider = "openai";
      for (const bad of [0, -1, 1.5, NaN]) {
        expect(() => core.send("Hi", { model: "gpt-4o", maxTokens: bad }))
          .toThrow(/maxTokens must be a positive integer/);
      }
    });

    it("ストリームが空行なしで閉じてもtrailingイベントを処理できる", async () => {
      fetchSpy.mockResolvedValueOnce(createMockStreamResponse([
        'data: {"choices":[{"delta":{"content":"tail"}}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
      ]));

      const core = new AiCore();
      core.provider = "openai";

      const result = await core.send("Hi", { model: "gpt-4o" });

      expect(result).toBe("tail");
      expect(core.content).toBe("tail");
      expect(core.usage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
      expect(core.messages).toEqual([
        { role: "user", content: "Hi" },
        { role: "assistant", content: "tail" },
      ]);
    });

    it("TextDecoderのremaining経由で完結したイベントも処理できる", async () => {
      const bytes = new Uint8Array([
        ...new TextEncoder().encode("data: hi"),
        0xe2, 0x82,
        0x0a, 0x0a,
      ]);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "Content-Type": "text/event-stream" }),
        body: stream,
        json: () => Promise.reject(new Error("streaming")),
        text: () => Promise.reject(new Error("streaming")),
      } as unknown as Response);

      const parseStreamChunk = vi.fn(() => ({
        delta: "TAIL",
        usage: { promptTokens: 3, completionTokens: 4 },
        done: false,
      }));
      const core = new AiCore();
      core.provider = {
        buildRequest: () => ({ url: "https://example.test", headers: {}, body: "{}" }),
        parseResponse: vi.fn(),
        parseStreamChunk,
      };

      const result = await core.send("Hi", { model: "custom" });

      expect(result).toBe("TAIL");
      expect(parseStreamChunk).toHaveBeenCalledTimes(1);
      expect(parseStreamChunk.mock.calls[0][1]).toContain("hi");
      expect(core.usage).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 });
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

    it("content配列も防御コピーされ、外部からの破壊的変更が内部履歴に波及しない", () => {
      const core = new AiCore();
      const parts: import("../src/types").AiContentPart[] = [
        { type: "text", text: "hello" },
      ];
      core.messages = [{ role: "user", content: parts }];
      // Mutate the source array — must not affect internal state.
      parts.push({ type: "text", text: "injected" });
      expect((core.messages[0].content as any[]).length).toBe(1);

      // Mutate the returned snapshot — must not affect internal state either.
      const snapshot = core.messages;
      (snapshot[0].content as any[]).push({ type: "text", text: "injected-2" });
      expect((core.messages[0].content as any[]).length).toBe(1);
    });

    it("toolCalls配列も防御コピーされ、外部からの破壊的変更が内部履歴に波及しない", () => {
      const core = new AiCore();
      const toolCalls = [{ id: "c1", name: "fn", arguments: "{}" }];
      core.messages = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls },
      ];
      // Mutate source.
      toolCalls.push({ id: "c2", name: "fn2", arguments: "{}" });
      expect(core.messages[1].toolCalls).toHaveLength(1);

      // Mutate snapshot.
      const snapshot = core.messages;
      snapshot[1].toolCalls!.push({ id: "c3", name: "fn3", arguments: "{}" });
      expect(core.messages[1].toolCalls).toHaveLength(1);
    });

    it("providerHintsの入れ子オブジェクトも防御コピーされ、外部からの破壊的変更が内部履歴に波及しない", () => {
      // Regression guard for cloneMessage's JSON-round-trip deep clone of
      // providerHints. The hint surface is a namespaced passthrough, so if a
      // caller reaches into `providerHints.anthropic.cacheControl` after the
      // setter accepted the message, that mutation must not rewrite what the
      // next send() ships to the provider.
      const core = new AiCore();
      const hint = { anthropic: { cacheControl: { type: "ephemeral" } } };
      core.messages = [{
        role: "user",
        content: "stable context",
        providerHints: hint,
      }];

      // Mutate the original nested object — internal history stays intact.
      (hint.anthropic.cacheControl as any).type = "tampered";
      (hint.anthropic as any).extra = "injected";
      expect(core.messages[0].providerHints).toEqual({
        anthropic: { cacheControl: { type: "ephemeral" } },
      });

      // Mutate the returned snapshot — also does not leak back.
      const snapshot = core.messages;
      (snapshot[0].providerHints!.anthropic as any).cacheControl.type = "tampered-2";
      (snapshot[0].providerHints!.anthropic as any).other = "injected-2";
      expect(core.messages[0].providerHints).toEqual({
        anthropic: { cacheControl: { type: "ephemeral" } },
      });
    });

    it("providerHintsがJSON化不能な値を含んでもcloneは投げずbest-effortで受け入れる", () => {
      // cloneMessage's providerHints path deep-clones via JSON round-trip and
      // falls back to a shallow spread when JSON.stringify throws (BigInt,
      // circular refs, functions). The contract the fallback protects is
      // "don't break the setter on an exotic hint payload" — not a specific
      // shape for what survives. Assert only that: (1) the setter does not
      // throw, (2) the namespace key is still reachable so history traversal
      // in the provider pipeline doesn't blow up. The exact contents of the
      // fallback-cloned value are intentionally left unspecified so a future
      // refactor can swap the fallback strategy without breaking this test.
      const core = new AiCore();
      const hintWithBigInt: any = { anthropic: { breakpointCount: BigInt(2) } };
      expect(() => {
        core.messages = [{ role: "user", content: "x", providerHints: hintWithBigInt }];
      }).not.toThrow();
      expect(core.messages[0].providerHints?.anthropic).toBeDefined();

      // Circular reference also forces the JSON-round-trip to throw; same
      // contract applies.
      const cyclic: any = { anthropic: {} };
      cyclic.anthropic.self = cyclic.anthropic;
      expect(() => {
        core.messages = [{ role: "user", content: "y", providerHints: cyclic }];
      }).not.toThrow();
      expect(core.messages[0].providerHints?.anthropic).toBeDefined();
    });

    it("finishReasonは履歴再注入で保持される", () => {
      // A consumer serializes `core.messages` (local storage, server sync,
      // undo stack) and re-assigns it later — the finish reason must round-
      // trip so UI branches built off `finishReason === "safety"` still work
      // after a reload. Covers both the setter's cloneMessage path and the
      // getter's snapshot clone.
      const core = new AiCore();
      core.messages = [
        { role: "user", content: "prompt that gets declined" },
        { role: "assistant", content: "I can't help with that.", finishReason: "safety" },
        { role: "user", content: "follow-up" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "search", arguments: "{}" }],
          finishReason: "tool_use",
        },
        { role: "tool", content: "{}", toolCallId: "call_1" },
        { role: "assistant", content: "done", finishReason: "stop" },
      ];

      const snapshot = core.messages;
      expect(snapshot[1].finishReason).toBe("safety");
      expect(snapshot[3].finishReason).toBe("tool_use");
      expect(snapshot[5].finishReason).toBe("stop");
      // Non-assistant messages have no finishReason and must not gain one
      // through the clone path.
      expect(snapshot[0].finishReason).toBeUndefined();
      expect(snapshot[4].finishReason).toBeUndefined();

      // Round-trip: re-assigning the snapshot must preserve the field on
      // every assistant entry. JSON round-trip simulates a persistence layer.
      core.messages = JSON.parse(JSON.stringify(snapshot));
      expect(core.messages[1].finishReason).toBe("safety");
      expect(core.messages[3].finishReason).toBe("tool_use");
      expect(core.messages[5].finishReason).toBe("stop");
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

    describe("setterバリデーション", () => {
      const core = () => {
        const c = new AiCore();
        return c;
      };

      it("未知のroleは setter で throw", () => {
        expect(() => { core().messages = [{ role: "bot" as any, content: "x" }]; })
          .toThrow(/\.role must be one of/);
      });

      it("content が string/配列 以外は throw", () => {
        expect(() => { core().messages = [{ role: "user", content: 42 as any }]; })
          .toThrow(/\.content must be a string or AiContentPart\[\]/);
      });

      it("未知の content part type は throw", () => {
        expect(() => {
          core().messages = [{
            role: "user",
            content: [{ type: "video" as any, url: "x" }],
          }];
        }).toThrow(/unknown content part type/);
      });

      it("image part で url が空は throw", () => {
        expect(() => {
          core().messages = [{
            role: "user",
            content: [{ type: "image", url: "" }],
          }];
        }).toThrow(/requires a non-empty `url` field/);
      });

      it("role tool で toolCallId が空は throw", () => {
        expect(() => {
          core().messages = [{ role: "tool", content: "{}", toolCallId: "" }];
        }).toThrow(/requires a non-empty string toolCallId/);
      });

      it("role tool で toolCallId 未設定は throw", () => {
        expect(() => {
          core().messages = [{ role: "tool", content: "{}" } as any];
        }).toThrow(/requires a non-empty string toolCallId/);
      });

      it("assistant.toolCalls 要素の shape を検証する", () => {
        expect(() => {
          core().messages = [{
            role: "assistant",
            content: "",
            toolCalls: [{ id: "", name: "fn", arguments: "{}" }],
          }];
        }).toThrow(/\.toolCalls\[0\]\.id must be a non-empty string/);

        expect(() => {
          core().messages = [{
            role: "assistant",
            content: "",
            toolCalls: [{ id: "c1", name: "", arguments: "{}" }],
          }];
        }).toThrow(/\.toolCalls\[0\]\.name must be a non-empty string/);

        expect(() => {
          core().messages = [{
            role: "assistant",
            content: "",
            toolCalls: [{ id: "c1", name: "fn", arguments: {} as any }],
          }];
        }).toThrow(/\.toolCalls\[0\]\.arguments must be a string/);
      });

      it("非assistantでtoolCallsが存在すると throw", () => {
        expect(() => {
          core().messages = [{
            role: "user",
            content: "hi",
            toolCalls: [{ id: "c1", name: "fn", arguments: "{}" }],
          } as any];
        }).toThrow(/\.toolCalls is only valid on assistant messages/);
      });

      it("非toolでtoolCallIdが存在すると throw", () => {
        expect(() => {
          core().messages = [{
            role: "user",
            content: "hi",
            toolCallId: "c1",
          } as any];
        }).toThrow(/\.toolCallId is only valid on tool messages/);
      });

      it("非配列を渡すと throw", () => {
        expect(() => { core().messages = "not-an-array" as any; })
          .toThrow(/messages must be an array/);
      });

      it("孤立した tool メッセージ（対応する assistant.toolCalls が無い）は throw", () => {
        expect(() => {
          core().messages = [
            { role: "user", content: "hi" },
            { role: "tool", content: '{"x":1}', toolCallId: "orphan" },
          ];
        }).toThrow(/references toolCallId "orphan" that does not correlate to any prior assistant tool call/);
      });

      it("先行assistantのtoolCallsと一致しないtoolCallIdは throw", () => {
        expect(() => {
          core().messages = [
            { role: "user", content: "hi" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "c_real", name: "fn", arguments: "{}" }],
            },
            { role: "tool", content: "{}", toolCallId: "c_typo" },
          ];
        }).toThrow(/references toolCallId "c_typo" that does not correlate/);
      });

      it("tool メッセージが対応する assistant より前にあると throw（時系列違反）", () => {
        expect(() => {
          core().messages = [
            { role: "tool", content: "{}", toolCallId: "c1" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "c1", name: "fn", arguments: "{}" }],
            },
          ];
        }).toThrow(/references toolCallId "c1" that does not correlate to any prior assistant tool call/);
      });

      it("同一toolCallIdを2回消費する履歴は throw（replay検出）", () => {
        expect(() => {
          core().messages = [
            { role: "user", content: "hi" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "c1", name: "fn", arguments: "{}" }],
            },
            { role: "tool", content: '{"v":1}', toolCallId: "c1" },
            { role: "tool", content: '{"v":2}', toolCallId: "c1" },
          ];
        }).toThrow(/replays toolCallId "c1" that was already consumed/);
      });

      it("assistant.toolCallsの重複idは throw", () => {
        expect(() => {
          core().messages = [
            { role: "user", content: "hi" },
            {
              role: "assistant",
              content: "",
              toolCalls: [
                { id: "c1", name: "fn", arguments: "{}" },
                { id: "c1", name: "fn", arguments: "{}" },
              ],
            },
          ];
        }).toThrow(/id "c1" duplicates an id already declared earlier/);
      });

      it("後続assistantが過去idを再宣言すると throw", () => {
        expect(() => {
          core().messages = [
            { role: "user", content: "q1" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "c1", name: "fn", arguments: "{}" }],
            },
            { role: "tool", content: "{}", toolCallId: "c1" },
            { role: "assistant", content: "partial" },
            { role: "user", content: "q2" },
            {
              role: "assistant",
              content: "",
              // Re-using "c1" is a shape violation even though it was
              // consumed — each call correlates to a unique id.
              toolCalls: [{ id: "c1", name: "fn", arguments: "{}" }],
            },
          ];
        }).toThrow(/id "c1" duplicates an id already declared earlier/);
      });

      it("異なるidでの複数tool responseは通る（並列tool call）", () => {
        const c = core();
        expect(() => {
          c.messages = [
            { role: "user", content: "hi" },
            {
              role: "assistant",
              content: "",
              toolCalls: [
                { id: "c1", name: "a", arguments: "{}" },
                { id: "c2", name: "b", arguments: "{}" },
              ],
            },
            { role: "tool", content: "{}", toolCallId: "c1" },
            { role: "tool", content: "{}", toolCallId: "c2" },
          ];
        }).not.toThrow();
        expect(c.messages).toHaveLength(4);
      });

      it("有効な混在履歴（multimodal + tool use）は通る", () => {
        const c = core();
        expect(() => {
          c.messages = [
            { role: "system", content: "You are helpful." },
            { role: "user", content: [
              { type: "text", text: "What's in this image?" },
              { type: "image", url: "https://x/y.png" },
            ] },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "c1", name: "lookup", arguments: '{"q":"x"}' }],
            },
            { role: "tool", content: '{"result":"ok"}', toolCallId: "c1" },
            { role: "assistant", content: "here you go" },
          ];
        }).not.toThrow();
        expect(c.messages).toHaveLength(5);
      });
    });
  });

  describe("internal helpers", () => {
    it("Error.toJSONはstackが空ならstackを含めない", () => {
      const core = new AiCore();
      const error = new Error("boom");
      error.stack = "";

      (core as any)._setError(error);

      expect((error as any).toJSON()).toEqual({
        name: "Error",
        message: "boom",
      });
    });

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

      // _processStream now returns a TurnResult object; _doSend pushes the
      // assistant message and clears loading. A direct _processStream call
      // only settles streaming state.
      expect(result).toEqual({ content: "", toolCalls: undefined, usage: undefined });
      expect(core.content).toBe("");
      expect(core.streaming).toBe(false);
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

      // _processStream returns a TurnResult; message-pushing now happens in _doSend.
      expect(result).toEqual({ content: "", toolCalls: undefined, usage: undefined });
      expect(core.messages).toEqual([]);
    });

    it("event-streamでもbodyが無ければjsonレスポンスとして処理する", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "Content-Type": "text/event-stream" }),
        body: null,
        json: () => Promise.resolve({ choices: [{ message: { content: "json-fallback" } }] }),
        text: () => Promise.resolve(""),
      } as unknown as Response);

      const core = new AiCore();
      core.provider = "openai";

      await expect(core.send("Hi", { model: "gpt-4o" })).resolves.toBe("json-fallback");
    });

    it("content-typeがnullでも非ストリーミングとして処理する", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        body: null,
        json: () => Promise.resolve({ choices: [{ message: { content: "no-header" } }] }),
        text: () => Promise.resolve(""),
      } as unknown as Response);

      const core = new AiCore();
      core.provider = "openai";

      await expect(core.send("Hi", { model: "gpt-4o" })).resolves.toBe("no-header");
    });

    it("trailingイベントのparse結果がnullなら無視する", async () => {
      fetchSpy.mockResolvedValueOnce(createMockStreamResponse(["data: trailing"]));

      const core = new AiCore();
      core.provider = {
        buildRequest: () => ({ url: "https://example.test", headers: {}, body: "{}" }),
        parseResponse: vi.fn(),
        parseStreamChunk: vi.fn(() => null),
      };

      await expect(core.send("Hi", { model: "custom" })).resolves.toBe("");
      expect(core.messages).toEqual([
        { role: "user", content: "Hi" },
        { role: "assistant", content: "" },
      ]);
    });

    it("TextDecoderのremainingが返したイベントも処理できる", async () => {
      const OriginalTextDecoder = globalThis.TextDecoder;

      class FakeTextDecoder {
        decode(_value?: Uint8Array, options?: { stream?: boolean }): string {
          if (options?.stream) return "";
          return "data: remain\n\n";
        }
      }

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "Content-Type": "text/event-stream" }),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        }),
        json: () => Promise.reject(new Error("streaming")),
        text: () => Promise.reject(new Error("streaming")),
      } as unknown as Response);

      const core = new AiCore();
      const parseStreamChunk = vi.fn(() => ({
        delta: "remain",
        usage: { promptTokens: 2, completionTokens: 3 },
        done: false,
      }));
      core.provider = {
        buildRequest: () => ({ url: "https://example.test", headers: {}, body: "{}" }),
        parseResponse: vi.fn(),
        parseStreamChunk,
      };

      (globalThis as any).TextDecoder = FakeTextDecoder;
      try {
        await expect(core.send("Hi", { model: "custom" })).resolves.toBe("remain");
      } finally {
        (globalThis as any).TextDecoder = OriginalTextDecoder;
      }

      expect(parseStreamChunk).toHaveBeenCalledWith(undefined, "remain");
      expect(core.usage).toEqual({ promptTokens: 2, completionTokens: 3, totalTokens: 5 });
    });

    it("remaining経由イベントのdelta/usage未設定も処理できる", async () => {
      const OriginalTextDecoder = globalThis.TextDecoder;

      class FakeTextDecoder {
        decode(_value?: Uint8Array, options?: { stream?: boolean }): string {
          if (options?.stream) return "";
          return "data: remain\n\n";
        }
      }

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "Content-Type": "text/event-stream" }),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        }),
        json: () => Promise.reject(new Error("streaming")),
        text: () => Promise.reject(new Error("streaming")),
      } as unknown as Response);

      const parseStreamChunk = vi.fn(() => ({ done: false }));
      const core = new AiCore();
      core.provider = {
        buildRequest: () => ({ url: "https://example.test", headers: {}, body: "{}" }),
        parseResponse: vi.fn(),
        parseStreamChunk,
      };

      (globalThis as any).TextDecoder = FakeTextDecoder;
      try {
        await expect(core.send("Hi", { model: "custom" })).resolves.toBe("");
      } finally {
        (globalThis as any).TextDecoder = OriginalTextDecoder;
      }

      expect(parseStreamChunk).toHaveBeenCalledWith(undefined, "remain");
      expect(core.usage).toBeNull();
    });

    it("remaining経由イベントでparse結果がnullでも継続できる", async () => {
      const OriginalTextDecoder = globalThis.TextDecoder;

      class FakeTextDecoder {
        decode(_value?: Uint8Array, options?: { stream?: boolean }): string {
          if (options?.stream) return "";
          return "data: remain\n\n";
        }
      }

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "Content-Type": "text/event-stream" }),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        }),
        json: () => Promise.reject(new Error("streaming")),
        text: () => Promise.reject(new Error("streaming")),
      } as unknown as Response);

      const parseStreamChunk = vi.fn(() => null);
      const core = new AiCore();
      core.provider = {
        buildRequest: () => ({ url: "https://example.test", headers: {}, body: "{}" }),
        parseResponse: vi.fn(),
        parseStreamChunk,
      };

      (globalThis as any).TextDecoder = FakeTextDecoder;
      try {
        await expect(core.send("Hi", { model: "custom" })).resolves.toBe("");
      } finally {
        (globalThis as any).TextDecoder = OriginalTextDecoder;
      }

      expect(parseStreamChunk).toHaveBeenCalledWith(undefined, "remain");
      expect(core.content).toBe("");
    });

    it("mergeUsageはexistingとincomingの欠損値を補完する", () => {
      const coreAny = new AiCore() as any;

      expect(coreAny._mergeUsage(undefined, {})).toEqual({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      });
      expect(coreAny._mergeUsage(
        { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        { completionTokens: 5 },
      )).toEqual({
        promptTokens: 1,
        completionTokens: 5,
        totalTokens: 6,
      });
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
      expect(() => core.send("Hello", { model: "" })).toThrow(
        "[@wc-bindable/hawc-ai] model is required. See @wc-bindable/hawc-ai README §Supported Providers for each provider's model catalog (no default is shipped because model identifiers drift faster than library releases).",
      );
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

    it("Googleプロバイダでストリーミングできる", async () => {
      const chunks = [
        sseData('{"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]}}]}'),
        sseData('{"candidates":[{"content":{"parts":[{"text":" from Gemini"}]}}]}'),
        sseData('{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":7,"totalTokenCount":19}}'),
      ];
      fetchSpy.mockResolvedValueOnce(createMockStreamResponse(chunks));

      const core = new AiCore();
      core.provider = "google";
      const result = await core.send("Hi", { model: "gemini-2.5-flash" });

      expect(result).toBe("Hello from Gemini");
      expect(core.usage).toEqual({ promptTokens: 12, completionTokens: 7, totalTokens: 19 });

      // buildRequest が streamGenerateContent?alt=sse を叩いていることも確認
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
    });

    it("sentinel終端後、held-openな response body に対しては cancel が伝播する（socket/メモリリーク防止）", async () => {
      // releaseLock() alone would leave the underlying stream source open
      // on proxies that keep the HTTP connection alive past [DONE]. We
      // spy on the stream's `cancel` callback to confirm AiCore actually
      // cancels the reader instead.
      const cancelSpy = vi.fn();
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sseData('{"choices":[{"delta":{"content":"Hi"}}]}')));
          controller.enqueue(encoder.encode(sseData("[DONE]")));
          // No controller.close(): held-open proxy behaviour.
        },
        cancel: (reason) => { cancelSpy(reason); },
      });
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "Content-Type": "text/event-stream" }),
        body: stream,
        json: () => Promise.reject(new Error("streaming")),
        text: () => Promise.reject(new Error("streaming")),
      } as unknown as Response);

      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("hi", { model: "gpt-4o" });

      expect(result).toBe("Hi");
      // Cancellation is dispatched asynchronously — wait a microtask turn.
      await Promise.resolve();
      await Promise.resolve();
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    }, 2000);

    it("OpenAI [DONE] を受け取ると、サーバがHTTP streamを閉じなくても send が返る（プロキシ互換性）", async () => {
      // Regression: Ollama / vLLM / LiteLLM proxies may keep the connection
      // open for a while after emitting `data: [DONE]`. AiCore must short-
      // circuit the read loop on the sentinel instead of waiting for the
      // server to close, otherwise send() hangs.
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sseData('{"choices":[{"delta":{"content":"Hi"}}]}')));
          controller.enqueue(encoder.encode(sseData("[DONE]")));
          // Intentionally do NOT call controller.close() — proxy holds the
          // socket open. The test will hit vitest's timeout if the loop
          // does not exit on [DONE].
        },
      });
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "Content-Type": "text/event-stream" }),
        body: stream,
        json: () => Promise.reject(new Error("streaming")),
        text: () => Promise.reject(new Error("streaming")),
      } as unknown as Response);

      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("hi", { model: "gpt-4o" });
      expect(result).toBe("Hi");
    }, 2000);

    it("Anthropic message_stop でも HTTP stream が閉じる前に send が返る", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
          ));
          controller.enqueue(encoder.encode(
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ));
          // No controller.close(): proxy may hold the socket.
        },
      });
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "Content-Type": "text/event-stream" }),
        body: stream,
        json: () => Promise.reject(new Error("streaming")),
        text: () => Promise.reject(new Error("streaming")),
      } as unknown as Response);

      const core = new AiCore();
      core.provider = "anthropic";
      const result = await core.send("hi", { model: "claude-sonnet-4-20250514" });
      expect(result).toBe("Hello");
    }, 2000);

    it("Geminiの finishReason と usageMetadata が別チャンクで届いてもusageを取りこぼさない", async () => {
      // Gemini frequently emits the usage metadata in a dedicated event
      // *after* the content event that carries `finishReason`. Breaking the
      // stream loop on the first `done: true` dropped that trailing usage.
      const chunks = [
        sseData('{"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]}}]}'),
        sseData('{"candidates":[{"content":{"parts":[{"text":" trailing"}]},"finishReason":"STOP"}]}'),
        // usage-only chunk, no content, no finishReason.
        sseData('{"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":4,"totalTokenCount":15}}'),
      ];
      fetchSpy.mockResolvedValueOnce(createMockStreamResponse(chunks));

      const core = new AiCore();
      core.provider = "google";
      const result = await core.send("Hi", { model: "gemini-2.5-flash" });

      expect(result).toBe("Hello trailing");
      expect(core.usage).toEqual({ promptTokens: 11, completionTokens: 4, totalTokens: 15 });
    });

    it("Geminiの finishReason 直後の同バッファ内 usage-only イベントも取り込む", async () => {
      // Simulate both events arriving in the *same* reader.read() buffer by
      // concatenating two SSE events into a single chunk. The inner-loop
      // `break` on result.done used to discard everything after the first
      // `done: true` event within this batch.
      const sameBatch =
        sseData('{"candidates":[{"content":{"parts":[{"text":"Bye"}]},"finishReason":"STOP"}]}') +
        sseData('{"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":1,"totalTokenCount":3}}');
      fetchSpy.mockResolvedValueOnce(createMockStreamResponse([sameBatch]));

      const core = new AiCore();
      core.provider = "google";
      const result = await core.send("Hi", { model: "gemini-2.5-flash" });

      expect(result).toBe("Bye");
      expect(core.usage).toEqual({ promptTokens: 2, completionTokens: 1, totalTokens: 3 });
    });

    it("OpenAI: ツールコールdeltasを蓄積し、finish_reason=tool_calls + [DONE] + held-open で確実にloopへ抜ける", async () => {
      // Combine: streaming tool_call accumulation across multiple SSE
      // chunks, terminator [DONE], and a held-open connection (no
      // controller.close() on the first fetch). The subsequent round-trip
      // for the final assistant reply is a normal non-streamed response.
      const encoder = new TextEncoder();
      const firstStream = new ReadableStream<Uint8Array>({
        start(controller) {
          // id + name emitted on first delta.
          controller.enqueue(encoder.encode(sseData(
            '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}',
          )));
          // Arguments streamed in fragments.
          controller.enqueue(encoder.encode(sseData(
            '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"loc\\":\\"To"}}]}}]}',
          )));
          controller.enqueue(encoder.encode(sseData(
            '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"kyo\\"}"}}]}}]}',
          )));
          // finish_reason=tool_calls + [DONE] sentinel. Explicit held-open:
          // NO controller.close() call. The send() must still return.
          controller.enqueue(encoder.encode(sseData(
            '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
          )));
          controller.enqueue(encoder.encode(sseData("[DONE]")));
        },
      });
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "Content-Type": "text/event-stream" }),
        body: firstStream,
        json: () => Promise.reject(new Error("streaming")),
        text: () => Promise.reject(new Error("streaming")),
      } as unknown as Response);
      // Second fetch (after handler runs) returns a final plain reply.
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        choices: [{ message: { role: "assistant", content: "22°C in Tokyo" } }],
      }));

      const handler = vi.fn().mockResolvedValue({ temp: 22 });
      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("weather?", {
        model: "gpt-4o",
        tools: [{ name: "get_weather", description: "", parameters: {}, handler }],
      });

      expect(result).toBe("22°C in Tokyo");
      // Handler called with fully-accumulated args from the streamed deltas.
      expect(handler).toHaveBeenCalledWith({ loc: "Tokyo" });
      // History: user + assistant(tool_calls) + tool + assistant(final).
      expect(core.messages).toHaveLength(4);
      expect(core.messages[1].toolCalls).toEqual([
        { id: "c1", name: "get_weather", arguments: '{"loc":"Tokyo"}' },
      ]);
    }, 3000);

    it("Anthropic: streaming tool_use blocks + message_stop + held-open で確実にloopへ抜ける", async () => {
      const encoder = new TextEncoder();
      const firstStream = new ReadableStream<Uint8Array>({
        start(controller) {
          // content_block_start: establishes tool_use id + name at index 1.
          controller.enqueue(encoder.encode(
            'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"c1","name":"get_weather"}}\n\n',
          ));
          // input_json_delta fragments.
          controller.enqueue(encoder.encode(
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"loc\\":"}}\n\n',
          ));
          controller.enqueue(encoder.encode(
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"Tokyo\\"}"}}\n\n',
          ));
          // message_stop sentinel. Held-open: NO controller.close() call.
          controller.enqueue(encoder.encode(
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ));
        },
      });
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "Content-Type": "text/event-stream" }),
        body: firstStream,
        json: () => Promise.reject(new Error("streaming")),
        text: () => Promise.reject(new Error("streaming")),
      } as unknown as Response);
      // Second fetch after the handler: plain Anthropic reply.
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        content: [{ type: "text", text: "22°C in Tokyo" }],
      }));

      const handler = vi.fn().mockResolvedValue({ temp: 22 });
      const core = new AiCore();
      core.provider = "anthropic";
      const result = await core.send("weather?", {
        model: "claude-sonnet-4-20250514",
        tools: [{ name: "get_weather", description: "", parameters: {}, handler }],
      });

      expect(result).toBe("22°C in Tokyo");
      expect(handler).toHaveBeenCalledWith({ loc: "Tokyo" });
      expect(core.messages[1].toolCalls).toEqual([
        { id: "c1", name: "get_weather", arguments: '{"loc":"Tokyo"}' },
      ]);
    }, 3000);

    it("Gemini: streaming functionCall + 後続usageMetadata (別チャンク) でtool callもusageも取り込む", async () => {
      // Gemini has no sentinel — send() exits on natural server close.
      // Verify: functionCall arriving before finishReason, usageMetadata
      // trailing in a separate chunk, final-reply round-trip unaffected.
      const firstChunks = [
        sseData('{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"loc":"Tokyo"}}}]}}]}'),
        sseData('{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}'),
        sseData('{"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":6,"totalTokenCount":15}}'),
      ];
      fetchSpy.mockResolvedValueOnce(createMockStreamResponse(firstChunks));
      // Second fetch: final plain Gemini reply, same behaviour.
      const secondChunks = [
        sseData('{"candidates":[{"content":{"role":"model","parts":[{"text":"22°C"}]}}]}'),
        sseData('{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":14,"candidatesTokenCount":2,"totalTokenCount":16}}'),
      ];
      fetchSpy.mockResolvedValueOnce(createMockStreamResponse(secondChunks));

      const handler = vi.fn().mockResolvedValue({ temp: 22 });
      const core = new AiCore();
      core.provider = "google";
      const result = await core.send("weather?", {
        model: "gemini-2.5-flash",
        tools: [{ name: "get_weather", description: "", parameters: {}, handler }],
      });

      expect(result).toBe("22°C");
      expect(handler).toHaveBeenCalledWith({ loc: "Tokyo" });
      // Usage aggregates both turns (9+14 prompt, 6+2 completion).
      expect(core.usage).toEqual({ promptTokens: 23, completionTokens: 8, totalTokens: 31 });
      expect(core.messages[1].toolCalls?.[0]).toMatchObject({ name: "get_weather", arguments: '{"loc":"Tokyo"}' });
    });

    it("Googleプロバイダで非ストリーミングリクエストを送信できる", async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        candidates: [{
          content: { role: "model", parts: [{ text: "Non-streamed reply" }] },
          finishReason: "STOP",
        }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
      }));

      const core = new AiCore();
      core.provider = "google";
      const result = await core.send("Hi", { model: "gemini-2.5-flash", stream: false });

      expect(result).toBe("Non-streamed reply");
      expect(core.usage).toEqual({ promptTokens: 4, completionTokens: 3, totalTokens: 7 });

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
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

    it("ストリーミング中にresendすると1回目のuserメッセージが履歴に残らない", async () => {
      // 1回目: ストリーミング開始後、abortでcontroller.close()（done:true で自然終了）
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
      await new Promise(r => setTimeout(r, 10));
      const second = core.send("Second", { model: "gpt-4o", stream: false });

      await Promise.all([first, second]);

      expect(core.messages).toEqual([
        { role: "user", content: "Second" },
        { role: "assistant", content: "OK" },
      ]);
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

  describe("tool use (auto-loop)", () => {
    // OpenAI-shaped non-streaming response helpers for brevity.
    const toolCallResponse = (id: string, name: string, args: object) => createMockResponse({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });
    const finalResponse = (text: string, usage = { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 }) =>
      createMockResponse({
        choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage,
      });

    it("tool handlerが実行され、結果が履歴に積まれて次ターンで最終応答が返る", async () => {
      fetchSpy
        .mockResolvedValueOnce(toolCallResponse("call_1", "get_weather", { location: "Tokyo" }))
        .mockResolvedValueOnce(finalResponse("The weather in Tokyo is 22°C."));

      const handler = vi.fn().mockResolvedValue({ temp: 22, unit: "C" });

      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("Weather in Tokyo?", {
        model: "gpt-4o",
        stream: false,
        tools: [{
          name: "get_weather",
          description: "",
          parameters: { type: "object" },
          handler,
        }],
      });

      expect(handler).toHaveBeenCalledWith({ location: "Tokyo" });
      expect(result).toBe("The weather in Tokyo is 22°C.");
      // history: user → assistant(toolCalls) → tool(result) → assistant(final)
      // Intermediate tool-use turn's finishReason normalizes to "tool_use"
      // (OpenAI `finish_reason: "tool_calls"`); terminal turn is "stop".
      expect(core.messages).toEqual([
        { role: "user", content: "Weather in Tokyo?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"location":"Tokyo"}' }],
          finishReason: "tool_use",
        },
        { role: "tool", content: '{"temp":22,"unit":"C"}', toolCallId: "call_1" },
        { role: "assistant", content: "The weather in Tokyo is 22°C.", finishReason: "stop" },
      ]);
      // Usage aggregates across both turns.
      expect(core.usage).toEqual({ promptTokens: 12, completionTokens: 7, totalTokens: 19 });
      expect(core.loading).toBe(false);
      expect(core.error).toBeNull();
    });

    it("複数のtool callを並列実行する", async () => {
      const parallelResponse = createMockResponse({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "a", type: "function", function: { name: "addOne", arguments: '{"n":1}' } },
              { id: "b", type: "function", function: { name: "addOne", arguments: '{"n":2}' } },
            ],
          },
          finish_reason: "tool_calls",
        }],
      });
      fetchSpy
        .mockResolvedValueOnce(parallelResponse)
        .mockResolvedValueOnce(finalResponse("done"));

      const handler = vi.fn().mockImplementation(async ({ n }) => n + 1);

      const core = new AiCore();
      core.provider = "openai";
      await core.send("run", {
        model: "gpt-4o",
        stream: false,
        tools: [{ name: "addOne", description: "", parameters: {}, handler }],
      });

      expect(handler).toHaveBeenCalledTimes(2);
      const toolMessages = core.messages.filter(m => m.role === "tool");
      expect(toolMessages).toEqual([
        { role: "tool", content: "2", toolCallId: "a" },
        { role: "tool", content: "3", toolCallId: "b" },
      ]);
    });

    it("tool-call-requested / tool-call-completed イベントが発火する", async () => {
      fetchSpy
        .mockResolvedValueOnce(toolCallResponse("call_1", "echo", { msg: "hi" }))
        .mockResolvedValueOnce(finalResponse("ok"));

      const requested: any[] = [];
      const completed: any[] = [];
      const core = new AiCore();
      core.addEventListener("hawc-ai:tool-call-requested", (e) => requested.push((e as CustomEvent).detail));
      core.addEventListener("hawc-ai:tool-call-completed", (e) => completed.push((e as CustomEvent).detail));
      core.provider = "openai";

      await core.send("go", {
        model: "gpt-4o",
        stream: false,
        tools: [{
          name: "echo",
          description: "",
          parameters: {},
          handler: async ({ msg }) => msg,
        }],
      });

      expect(requested).toHaveLength(1);
      expect(requested[0].toolCall).toEqual({ id: "call_1", name: "echo", arguments: '{"msg":"hi"}' });
      expect(completed).toHaveLength(1);
      expect(completed[0].toolCall).toEqual({ id: "call_1", name: "echo", arguments: '{"msg":"hi"}' });
      expect(completed[0].result).toBe("hi");
    });

    it("未定義のtool名はtool resultにエラーJSONを積んでループ継続する", async () => {
      fetchSpy
        .mockResolvedValueOnce(toolCallResponse("call_1", "undefined_tool", {}))
        .mockResolvedValueOnce(finalResponse("handled"));

      const completed: any[] = [];
      const core = new AiCore();
      core.addEventListener("hawc-ai:tool-call-completed", (e) => completed.push((e as CustomEvent).detail));
      core.provider = "openai";

      const result = await core.send("try unknown", {
        model: "gpt-4o",
        stream: false,
        tools: [],
      });

      expect(result).toBe("handled");
      const toolMsg = core.messages.find(m => m.role === "tool")!;
      expect(toolMsg.content).toContain("not defined");
      // Event `error` carries the precise reason so consumers can tell a
      // capability-boundary rejection from a missing-handler config bug.
      expect(completed[0].error).toContain("is not defined on this send()");
      expect(core.error).toBeNull();
    });

    it("tool-call-completedイベントは capability-boundary と handler 不在を区別可能なerrorを載せる", async () => {
      const { registerTool, clearToolRegistry } = await import("../src/toolRegistry");
      clearToolRegistry();

      // Scenario A: declared but handler omitted and not in any registry.
      fetchSpy
        .mockResolvedValueOnce(toolCallResponse("cA", "declared_no_handler", {}))
        .mockResolvedValueOnce(finalResponse("ok-A"));
      const eventsA: any[] = [];
      const coreA = new AiCore();
      coreA.addEventListener("hawc-ai:tool-call-completed", e => eventsA.push((e as CustomEvent).detail));
      coreA.provider = "openai";
      await coreA.send("a", {
        model: "gpt-4o",
        stream: false,
        tools: [{ name: "declared_no_handler", description: "", parameters: {} }],
      });
      expect(eventsA[0].error).toContain("has no handler");

      // Scenario B: undeclared on this send, even if registry has it.
      registerTool("privileged", () => "should-not-run");
      fetchSpy
        .mockResolvedValueOnce(toolCallResponse("cB", "privileged", {}))
        .mockResolvedValueOnce(finalResponse("ok-B"));
      const eventsB: any[] = [];
      const coreB = new AiCore();
      coreB.addEventListener("hawc-ai:tool-call-completed", e => eventsB.push((e as CustomEvent).detail));
      coreB.provider = "openai";
      await coreB.send("b", { model: "gpt-4o", stream: false });
      expect(eventsB[0].error).toContain("is not defined on this send()");
      expect(eventsB[0].error).not.toContain("has no handler");

      clearToolRegistry();
    });

    it("tool handlerが例外を投げてもエラーJSONをtool resultに積んでループ継続する", async () => {
      fetchSpy
        .mockResolvedValueOnce(toolCallResponse("call_1", "boom", {}))
        .mockResolvedValueOnce(finalResponse("recovered"));

      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("recover please", {
        model: "gpt-4o",
        stream: false,
        tools: [{
          name: "boom",
          description: "",
          parameters: {},
          handler: async () => { throw new Error("handler failed"); },
        }],
      });

      expect(result).toBe("recovered");
      const toolMsg = core.messages.find(m => m.role === "tool")!;
      expect(toolMsg.content).toContain("handler failed");
      expect(core.error).toBeNull();
    });

    it("maxToolRoundtrips超過でエラーに入り履歴がロールバックされる", async () => {
      // 常にtool callを返すモデル(=ループ過多)
      fetchSpy.mockResolvedValue(toolCallResponse("call_n", "loop", {}));

      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("loop forever", {
        model: "gpt-4o",
        stream: false,
        maxToolRoundtrips: 2,
        tools: [{
          name: "loop",
          description: "",
          parameters: {},
          handler: async () => ({ next: true }),
        }],
      });

      expect(result).toBeNull();
      expect(core.error).toBeInstanceOf(Error);
      expect((core.error as Error).message).toContain("maxToolRoundtrips");
      // 履歴はsend()開始前の状態にロールバックされる
      expect(core.messages).toEqual([]);
      expect(core.loading).toBe(false);
    });

    it("maxToolRoundtripsが非整数の場合はsendが同期throwする", () => {
      const core = new AiCore();
      core.provider = "openai";
      expect(() => core.send("x", { model: "gpt-4o", maxToolRoundtrips: 1.5 })).toThrow(
        /maxToolRoundtrips must be a non-negative integer/,
      );
    });

    it("maxToolRoundtrips=0ではtools/toolChoiceが provider 送信から除外される", async () => {
      fetchSpy.mockResolvedValueOnce(finalResponse("plain reply"));

      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("hi", {
        model: "gpt-4o",
        stream: false,
        maxToolRoundtrips: 0,
        tools: [{ name: "never_called", description: "", parameters: {}, handler: () => "x" }],
        toolChoice: "auto",
      });

      expect(result).toBe("plain reply");
      expect(core.error).toBeNull();
      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      // README: "0 disables tool use entirely — tools and toolChoice are stripped".
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
    });

    it("maxToolRoundtrips=0では通常応答が1ラウンドで返り履歴もassistantがterminal", async () => {
      // Happy path: the provider honors the stripped request (no tools in
      // body) and returns a plain assistant turn. The loop exits on the
      // terminal check without ever incrementing roundtrips.
      fetchSpy.mockResolvedValueOnce(finalResponse("ok"));

      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("hi", {
        model: "gpt-4o",
        stream: false,
        maxToolRoundtrips: 0,
        tools: [{ name: "t", description: "", parameters: {}, handler: () => null }],
      });

      expect(result).toBe("ok");
      expect(core.error).toBeNull();
      expect(core.messages).toEqual([
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok", finishReason: "stop" },
      ]);
    });

    it("maxToolRoundtrips=0でproviderが契約違反でtool_callsを返してもterminalとして扱う（rollbackエラーにしない）", async () => {
      // Defensive scenario: some provider (or proxy) ignores the stripped
      // tool catalog and emits tool_calls anyway. "0 disables tool use
      // entirely" per the README, so we must not bounce the whole send()
      // with a "roundtrips exceeded" error just because the wire response
      // carried a stray tool_call block. The assistant message is stored
      // with content but without the tool_calls, and the handler is never
      // invoked.
      const rogueHandler = vi.fn();
      fetchSpy.mockResolvedValueOnce(toolCallResponse("call_x", "t", { bogus: true }));

      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("hi", {
        model: "gpt-4o",
        stream: false,
        maxToolRoundtrips: 0,
        tools: [{ name: "t", description: "", parameters: {}, handler: rogueHandler }],
      });

      // Provider-returned content is preserved (empty string for a pure
      // tool-call turn in OpenAI's shape).
      expect(result).toBe("");
      expect(core.error).toBeNull();
      // Only user + assistant pushed; no tool message (handler was not run).
      expect(core.messages).toHaveLength(2);
      expect(core.messages[0]).toEqual({ role: "user", content: "hi" });
      expect(core.messages[1].role).toBe("assistant");
      // The stray tool_calls must not be attached to the stored assistant
      // message — otherwise future sends would render them back on the wire.
      expect(core.messages[1].toolCalls).toBeUndefined();
      expect(rogueHandler).not.toHaveBeenCalled();
    });

    it("toolsが空なら通常の1ターン応答として振る舞う（後方互換）", async () => {
      fetchSpy.mockResolvedValueOnce(finalResponse("plain reply"));

      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("hi", { model: "gpt-4o", stream: false });

      expect(result).toBe("plain reply");
      expect(core.messages).toEqual([
        { role: "user", content: "hi" },
        { role: "assistant", content: "plain reply", finishReason: "stop" },
      ]);
    });

    it("handlerが無くてもregisterToolされていればregistry経由で実行される（remote模倣）", async () => {
      const { registerTool, clearToolRegistry } = await import("../src/toolRegistry");
      clearToolRegistry();
      const handler = vi.fn().mockResolvedValue({ ok: true });
      registerTool("registered_tool", handler);

      fetchSpy
        .mockResolvedValueOnce(toolCallResponse("call_1", "registered_tool", { n: 42 }))
        .mockResolvedValueOnce(finalResponse("done"));

      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("go", {
        model: "gpt-4o",
        stream: false,
        // handler abstractly stripped (as <hawc-ai> does in remote mode).
        tools: [{
          name: "registered_tool",
          description: "",
          parameters: {},
        }],
      });

      expect(handler).toHaveBeenCalledWith({ n: 42 });
      expect(result).toBe("done");
      const toolMsg = core.messages.find(m => m.role === "tool")!;
      expect(toolMsg.content).toBe('{"ok":true}');
      clearToolRegistry();
    });

    it("options.tools に宣言が無いtoolは registry にhandlerがあっても呼ばれない（capability boundary）", async () => {
      // Capability boundary: a hallucinated / replayed tool name from the
      // model must not reach a registered handler that the caller never
      // exposed on this send(). The registry fills in *handlers* for
      // already-declared tools (remote mode), it does not widen the catalog.
      const { registerTool, clearToolRegistry } = await import("../src/toolRegistry");
      clearToolRegistry();
      const privileged = vi.fn().mockResolvedValue("should-not-run");
      registerTool("privileged_tool", privileged);

      fetchSpy
        .mockResolvedValueOnce(toolCallResponse("c1", "privileged_tool", {}))
        .mockResolvedValueOnce(finalResponse("done"));

      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("x", { model: "gpt-4o", stream: false });

      // Handler must never fire — even though the registry had it.
      expect(privileged).not.toHaveBeenCalled();
      // The model's tool turn is answered with an "not defined on this send()"
      // error JSON, the loop continues, and the next turn produces "done".
      expect(result).toBe("done");
      const toolMsg = core.messages.find(m => m.role === "tool")!;
      expect(toolMsg.content).toContain("is not defined on this send()");
      clearToolRegistry();
    });

    it("core.registerTool でも options.tools 未宣言なら実行されない", async () => {
      // Same boundary for the per-instance registry (the per-user auth
      // scoping vehicle). Instance handlers are still gated by the
      // per-request tools catalog.
      const { clearToolRegistry } = await import("../src/toolRegistry");
      clearToolRegistry();

      fetchSpy
        .mockResolvedValueOnce(toolCallResponse("c1", "instance_only", {}))
        .mockResolvedValueOnce(finalResponse("done"));

      const core = new AiCore();
      core.provider = "openai";
      const instanceHandler = vi.fn().mockResolvedValue("x");
      core.registerTool("instance_only", instanceHandler);

      const result = await core.send("x", { model: "gpt-4o", stream: false });

      expect(instanceHandler).not.toHaveBeenCalled();
      expect(result).toBe("done");
      const toolMsg = core.messages.find(m => m.role === "tool")!;
      expect(toolMsg.content).toContain("is not defined on this send()");
    });

    it("handlerが options にも registry にも無ければエラーJSONで継続する", async () => {
      const { clearToolRegistry } = await import("../src/toolRegistry");
      clearToolRegistry();

      fetchSpy
        .mockResolvedValueOnce(toolCallResponse("c1", "no_handler", {}))
        .mockResolvedValueOnce(finalResponse("fallback"));

      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("y", {
        model: "gpt-4o",
        stream: false,
        // handler 省略 → registry にも無い
        tools: [{ name: "no_handler", description: "", parameters: {} }],
      });

      expect(result).toBe("fallback");
      const toolMsg = core.messages.find(m => m.role === "tool")!;
      expect(toolMsg.content).toContain("has no handler");
    });

    it("core単位のregisterToolは接続ごとに独立したhandlerを保持する", async () => {
      const { clearToolRegistry } = await import("../src/toolRegistry");
      clearToolRegistry();

      const handlerA = vi.fn().mockResolvedValue({ user: "A" });
      const handlerB = vi.fn().mockResolvedValue({ user: "B" });
      const coreA = new AiCore();
      const coreB = new AiCore();
      coreA.provider = "openai";
      coreB.provider = "openai";

      // Both cores register a handler under the same tool name — simulates
      // two concurrent WebSocket connections in createCores binding
      // user-specific closures.
      coreA.registerTool("lookup", handlerA);
      coreB.registerTool("lookup", handlerB);

      fetchSpy
        .mockResolvedValueOnce(toolCallResponse("c1", "lookup", {}))
        .mockResolvedValueOnce(finalResponse("A done"))
        .mockResolvedValueOnce(toolCallResponse("c2", "lookup", {}))
        .mockResolvedValueOnce(finalResponse("B done"));

      await coreA.send("go", {
        model: "gpt-4o",
        stream: false,
        tools: [{ name: "lookup", description: "", parameters: {} }],
      });
      await coreB.send("go", {
        model: "gpt-4o",
        stream: false,
        tools: [{ name: "lookup", description: "", parameters: {} }],
      });

      expect(handlerA).toHaveBeenCalledTimes(1);
      expect(handlerB).toHaveBeenCalledTimes(1);
    });

    it("インスタンスregistryは process-wide registry より優先される", async () => {
      const { registerTool, clearToolRegistry } = await import("../src/toolRegistry");
      clearToolRegistry();

      const globalHandler = vi.fn().mockResolvedValue("global");
      const instanceHandler = vi.fn().mockResolvedValue("instance");
      registerTool("shared", globalHandler);

      const core = new AiCore();
      core.provider = "openai";
      core.registerTool("shared", instanceHandler);

      fetchSpy
        .mockResolvedValueOnce(toolCallResponse("c1", "shared", {}))
        .mockResolvedValueOnce(finalResponse("ok"));

      await core.send("go", {
        model: "gpt-4o",
        stream: false,
        tools: [{ name: "shared", description: "", parameters: {} }],
      });

      expect(instanceHandler).toHaveBeenCalledTimes(1);
      expect(globalHandler).not.toHaveBeenCalled();
      clearToolRegistry();
    });

    it("unregisterToolでインスタンスregistryから削除できる", () => {
      const core = new AiCore();
      const handler = () => null;
      core.registerTool("t", handler);
      expect(core.getRegisteredTool("t")).toBe(handler);
      expect(core.unregisterTool("t")).toBe(true);
      expect(core.getRegisteredTool("t")).toBeUndefined();
      expect(core.unregisterTool("t")).toBe(false);
    });
  });

  describe("structured output (responseSchema)", () => {
    const schema = {
      type: "object",
      properties: {
        title: { type: "string" },
        rating: { type: "number" },
      },
      required: ["title", "rating"],
    };

    it("responseSchemaを送信し、返ってきたJSON文字列をcontentとして返す", async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        choices: [{ message: { role: "assistant", content: '{"title":"Hi","rating":5}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
      }));

      const core = new AiCore();
      core.provider = "openai";
      const result = await core.send("analyze", {
        model: "gpt-4o",
        stream: false,
        responseSchema: schema,
      });

      expect(result).toBe('{"title":"Hi","rating":5}');
      expect(JSON.parse(result!)).toEqual({ title: "Hi", rating: 5 });

      // request body に response_format が含まれていることを確認
      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse((init as any).body);
      expect(body.response_format?.type).toBe("json_schema");
    });

    it("responseSchemaとtoolsを同時指定するとsendが同期throwする", () => {
      const core = new AiCore();
      core.provider = "openai";
      expect(() => core.send("x", {
        model: "gpt-4o",
        responseSchema: schema,
        tools: [{ name: "t", description: "", parameters: {}, handler: () => null }],
      })).toThrow(/responseSchema and tools cannot both be set/);
    });

    it("responseSchemaが非オブジェクトだとsendが同期throwする", () => {
      const core = new AiCore();
      core.provider = "openai";
      expect(() => core.send("x", {
        model: "gpt-4o",
        responseSchema: "not-an-object" as any,
      })).toThrow(/responseSchema must be a JSON Schema object/);
      expect(() => core.send("x", {
        model: "gpt-4o",
        responseSchema: [] as any,
      })).toThrow(/responseSchema must be a JSON Schema object/);
    });
  });

  describe("multimodal content", () => {
    it("AiContentPart[]をprompt引数に渡すとuserメッセージがarray contentで履歴に積まれる", async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        choices: [{ message: { content: "I see a cat." } }],
      }));

      const core = new AiCore();
      core.provider = "openai";
      const parts = [
        { type: "text" as const, text: "What's here?" },
        { type: "image" as const, url: "https://example.com/cat.jpg" },
      ];
      const result = await core.send(parts, { model: "gpt-4o", stream: false });

      expect(result).toBe("I see a cat.");
      expect(core.messages).toEqual([
        { role: "user", content: parts },
        { role: "assistant", content: "I see a cat." },
      ]);
      // OpenAI形式でリクエストされていることを確認
      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body.messages[0].content).toEqual([
        { type: "text", text: "What's here?" },
        { type: "image_url", image_url: { url: "https://example.com/cat.jpg" } },
      ]);
    });

    it("空の配列を渡すとsendが同期throwする", () => {
      const core = new AiCore();
      core.provider = "openai";
      expect(() => core.send([], { model: "gpt-4o" })).toThrow(/content parts array is empty/);
    });

    it("未知のpart typeはsendが同期throwする", () => {
      const core = new AiCore();
      core.provider = "openai";
      expect(() => core.send(
        [{ type: "video" as any, url: "x" }],
        { model: "gpt-4o" },
      )).toThrow(/unknown content part type/);
    });

    it("image partでurlが空文字だとsendが同期throwする", () => {
      const core = new AiCore();
      core.provider = "openai";
      expect(() => core.send(
        [{ type: "image", url: "" }],
        { model: "gpt-4o" },
      )).toThrow(/requires a non-empty `url` field/);
    });

    it("send(parts)後に呼び出し側がpromptを変更しても内部履歴は影響を受けない", async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse({
        choices: [{ message: { content: "ok" } }],
      }));

      const core = new AiCore();
      core.provider = "openai";
      const parts: import("../src/types").AiContentPart[] = [
        { type: "text", text: "original" },
      ];
      await core.send(parts, { model: "gpt-4o", stream: false });

      // Mutate the caller's array AFTER send() has finished. If the send path
      // stored the reference verbatim, core.messages[0].content would now
      // contain the injected part.
      parts.push({ type: "text", text: "injected-after-send" });
      (parts[0] as any).text = "mutated-after-send";

      const userMsg = core.messages[0];
      expect(userMsg.role).toBe("user");
      expect((userMsg.content as any[]).length).toBe(1);
      expect((userMsg.content as any[])[0]).toEqual({ type: "text", text: "original" });
    });

    it("prompt引数でstringとAiContentPart[]を混在できる（連続send）", async () => {
      fetchSpy
        .mockResolvedValueOnce(createMockResponse({ choices: [{ message: { content: "first" } }] }))
        .mockResolvedValueOnce(createMockResponse({ choices: [{ message: { content: "second" } }] }));

      const core = new AiCore();
      core.provider = "openai";

      await core.send("hi", { model: "gpt-4o", stream: false });
      await core.send(
        [{ type: "text", text: "follow-up" }, { type: "image", url: "https://x/y.png" }],
        { model: "gpt-4o", stream: false },
      );

      expect(core.messages).toHaveLength(4);
      expect(core.messages[0]).toEqual({ role: "user", content: "hi" });
      expect(core.messages[2]).toMatchObject({ role: "user" });
      expect(Array.isArray(core.messages[2].content)).toBe(true);
    });
  });
});
