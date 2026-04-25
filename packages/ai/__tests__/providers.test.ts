import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAiProvider } from "../src/providers/OpenAiProvider";
import { AnthropicProvider } from "../src/providers/AnthropicProvider";
import { AzureOpenAiProvider } from "../src/providers/AzureOpenAiProvider";
import { GoogleProvider } from "../src/providers/GoogleProvider";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenAiProvider", () => {
  const provider = new OpenAiProvider();

  describe("buildRequest", () => {
    it("正しいURLとヘッダーでリクエストを構築する", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hello" }],
        { model: "gpt-4o", apiKey: "sk-test" }
      );
      expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
      expect(req.headers["Authorization"]).toBe("Bearer sk-test");
      expect(req.headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(req.body);
      expect(body.model).toBe("gpt-4o");
      expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);
      expect(body.stream).toBe(true);
    });

    it("カスタムbaseUrlを使用できる", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "llama3", baseUrl: "http://localhost:11434" }
      );
      expect(req.url).toBe("http://localhost:11434/v1/chat/completions");
    });

    it("apiKey未設定時はAuthorizationヘッダーを含まない", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "gpt-4o" }
      );
      expect(req.headers["Authorization"]).toBeUndefined();
    });

    it("temperatureとmaxTokensを設定できる", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "gpt-4o", temperature: 0.5, maxTokens: 1000 }
      );
      const body = JSON.parse(req.body);
      expect(body.temperature).toBe(0.5);
      expect(body.max_tokens).toBe(1000);
    });

    it("temperatureとmaxTokens未設定時はbodyに含まない", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "gpt-4o" }
      );
      const body = JSON.parse(req.body);
      expect(body.temperature).toBeUndefined();
      expect(body.max_tokens).toBeUndefined();
    });

    it("stream=falseの場合stream_optionsを含まない", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "gpt-4o", stream: false }
      );
      const body = JSON.parse(req.body);
      expect(body.stream).toBe(false);
      expect(body.stream_options).toBeUndefined();
    });

    it("デフォルトbaseUrl(OpenAI)ではstream_optionsを含む", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "gpt-4o" }
      );
      const body = JSON.parse(req.body);
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
    });

    it("カスタムbaseUrlではstream_optionsを含まない", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "llama3", baseUrl: "http://localhost:11434" }
      );
      const body = JSON.parse(req.body);
      expect(body.stream).toBe(true);
      expect(body.stream_options).toBeUndefined();
    });

    it("無効なtemperature/maxTokensはエラーをスローする", () => {
      expect(() => provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "gpt-4o", temperature: NaN }
      )).toThrow(/temperature must be a finite number/);
      for (const invalid of [0, -1, 1.5]) {
        expect(() => provider.buildRequest(
          [{ role: "user", content: "Hi" }],
          { model: "gpt-4o", maxTokens: invalid }
        )).toThrow(/maxTokens must be a positive integer/);
      }
    });

    it("responseSchemaとtoolsを同時指定するとbuildRequestが同期throwする（provider直呼び経路）", () => {
      expect(() => provider.buildRequest(
        [{ role: "user", content: "x" }],
        {
          model: "gpt-4o",
          responseSchema: { type: "object", properties: { a: { type: "string" } } },
          tools: [{ name: "t", description: "", parameters: {}, handler: () => null }],
        },
      )).toThrow(/responseSchema and tools cannot both be set/);
    });

    it("responseSchemaが非オブジェクトだとbuildRequestが同期throwする", () => {
      expect(() => provider.buildRequest(
        [{ role: "user", content: "x" }],
        { model: "gpt-4o", responseSchema: "bad" as any },
      )).toThrow(/responseSchema must be a JSON Schema object/);
    });

    it("assistantロールの配列contentはテキストにflattenされてwireに載る", () => {
      const req = provider.buildRequest(
        [
          { role: "user", content: "hi" },
          // AiContent contract: non-user array content is flattened.
          { role: "assistant", content: [
            { type: "text", text: "hello " },
            { type: "text", text: "world" },
            // Image parts on assistant are documented as invalid — flatten drops them.
            { type: "image", url: "https://x/y.png" },
          ] },
        ],
        { model: "gpt-4o" },
      );
      const body = JSON.parse(req.body);
      expect(body.messages[1]).toEqual({ role: "assistant", content: "hello world" });
    });
  });

  describe("parseResponse", () => {
    it("レスポンスからcontentとusageを抽出する", () => {
      const result = provider.parseResponse({
        choices: [{ message: { content: "Hello!" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      expect(result.content).toBe("Hello!");
      expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    });

    it("usageがない場合はundefinedを返す", () => {
      const result = provider.parseResponse({
        choices: [{ message: { content: "Hi" } }],
      });
      expect(result.content).toBe("Hi");
      expect(result.usage).toBeUndefined();
    });

    it("空のレスポンスを処理できる", () => {
      const result = provider.parseResponse({});
      expect(result.content).toBe("");
    });

    it("usageの値が0の場合も正しく処理する", () => {
      const result = provider.parseResponse({
        choices: [{ message: { content: "Hi" } }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
      expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    });

    it("finish_reasonをAiFinishReasonにnormalizeする", () => {
      const mk = (reason: string) => provider.parseResponse({
        choices: [{ message: { content: "x" }, finish_reason: reason }],
      });
      expect(mk("stop").finishReason).toBe("stop");
      expect(mk("length").finishReason).toBe("length");
      expect(mk("tool_calls").finishReason).toBe("tool_use");
      expect(mk("function_call").finishReason).toBe("tool_use");
      expect(mk("content_filter").finishReason).toBe("safety");
      expect(mk("weird_future_value").finishReason).toBe("other");
    });

    it("finish_reasonが無い場合はfinishReasonを含めない", () => {
      const result = provider.parseResponse({
        choices: [{ message: { content: "x" } }],
      });
      expect(result.finishReason).toBeUndefined();
    });
  });

  describe("parseStreamChunk", () => {
    it("[DONE]でdone=trueを返す", () => {
      const result = provider.parseStreamChunk(undefined, "[DONE]");
      expect(result).toEqual({ done: true });
    });

    it("deltaのcontentを抽出する", () => {
      const result = provider.parseStreamChunk(undefined,
        '{"choices":[{"delta":{"content":"Hello"}}]}'
      );
      expect(result).toEqual({ delta: "Hello", usage: undefined, done: false });
    });

    it("usageチャンクを処理する", () => {
      const result = provider.parseStreamChunk(undefined,
        '{"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}'
      );
      expect(result?.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    });

    it("usageチャンクの値が0の場合も処理する", () => {
      const result = provider.parseStreamChunk(undefined,
        '{"choices":[{"delta":{}}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}'
      );
      expect(result?.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    });

    it("不正なJSONでnullを返す", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = provider.parseStreamChunk(undefined, "invalid json");
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        "[@wc-bindable/ai] Failed to parse stream chunk.",
        expect.objectContaining({
          provider: "openai",
          event: undefined,
          data: "invalid json",
          error: expect.any(SyntaxError),
        })
      );
    });

    it("deltaなし・usageなしの場合", () => {
      const result = provider.parseStreamChunk(undefined,
        '{"choices":[{"delta":{}}]}'
      );
      expect(result).toEqual({ delta: undefined, usage: undefined, done: false });
    });
  });
});

describe("AnthropicProvider", () => {
  const provider = new AnthropicProvider();

  describe("buildRequest", () => {
    it("systemメッセージを分離してトップレベルに配置する", () => {
      const req = provider.buildRequest(
        [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Hello" },
        ],
        { model: "claude-sonnet-4-20250514", apiKey: "sk-ant-test" }
      );
      expect(req.url).toBe("https://api.anthropic.com/v1/messages");
      expect(req.headers["x-api-key"]).toBe("sk-ant-test");
      expect(req.headers["anthropic-version"]).toBe("2023-06-01");
      const body = JSON.parse(req.body);
      expect(body.system).toBe("You are helpful");
      expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);
      expect(body.max_tokens).toBe(4096);
    });

    it("複数のsystemメッセージを結合する", () => {
      const req = provider.buildRequest(
        [
          { role: "system", content: "First" },
          { role: "system", content: "Second" },
          { role: "user", content: "Hi" },
        ],
        { model: "claude-sonnet-4-20250514" }
      );
      const body = JSON.parse(req.body);
      expect(body.system).toBe("First\n\nSecond");
    });

    it("systemメッセージがない場合はsystemフィールドを含まない", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "claude-sonnet-4-20250514" }
      );
      const body = JSON.parse(req.body);
      expect(body.system).toBeUndefined();
    });

    it("maxTokensを指定できる", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "claude-sonnet-4-20250514", maxTokens: 1000 }
      );
      const body = JSON.parse(req.body);
      expect(body.max_tokens).toBe(1000);
    });

    it("maxTokens未指定時はデフォルト(4096)にフォールバックする", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "claude-sonnet-4-20250514" }
      );
      const body = JSON.parse(req.body);
      expect(body.max_tokens).toBe(4096);
    });

    it("maxTokensに無効値を渡すとエラーをスローする", () => {
      for (const invalid of [0, -1, NaN, 1.5]) {
        expect(() => provider.buildRequest(
          [{ role: "user", content: "Hi" }],
          { model: "claude-sonnet-4-20250514", maxTokens: invalid }
        )).toThrow(/maxTokens must be a positive integer/);
      }
    });

    it("apiKey未設定時はx-api-keyヘッダーを含まない", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "claude-sonnet-4-20250514" }
      );
      expect(req.headers["x-api-key"]).toBeUndefined();
    });

    it("stream=false、temperature指定", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "claude-sonnet-4-20250514", stream: false, temperature: 0.5 }
      );
      const body = JSON.parse(req.body);
      expect(body.stream).toBe(false);
      expect(body.temperature).toBe(0.5);
    });

    it("temperature未設定時はbodyに含まない", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "claude-sonnet-4-20250514" }
      );
      const body = JSON.parse(req.body);
      expect(body.temperature).toBeUndefined();
    });

    it("カスタムbaseUrlを使用できる", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "claude-sonnet-4-20250514", baseUrl: "http://localhost:8080" }
      );
      expect(req.url).toBe("http://localhost:8080/v1/messages");
    });

    it("responseSchemaとtoolsを同時指定するとbuildRequestが同期throwする（provider直呼び経路）", () => {
      expect(() => provider.buildRequest(
        [{ role: "user", content: "x" }],
        {
          model: "claude-sonnet-4-20250514",
          responseSchema: { type: "object", properties: { a: { type: "string" } } },
          tools: [{ name: "t", description: "", parameters: {}, handler: () => null }],
        },
      )).toThrow(/responseSchema and tools cannot both be set/);
    });

    it("assistantロールの配列contentはテキストにflattenされてwireに載る", () => {
      const req = provider.buildRequest(
        [
          { role: "user", content: "hi" },
          // AiContent contract: non-user array content is flattened.
          { role: "assistant", content: [
            { type: "text", text: "hello " },
            { type: "text", text: "world" },
            // Image parts on assistant are documented as invalid — flatten drops them.
            { type: "image", url: "https://x/y.png" },
          ] },
        ],
        { model: "claude-sonnet-4-20250514" },
      );
      const body = JSON.parse(req.body);
      expect(body.messages[1]).toEqual({ role: "assistant", content: "hello world" });
    });

    describe("providerHints.anthropic.cacheControl", () => {
      it("user messageのcacheControlオブジェクトを最後のブロックのcache_controlとしてシリアライズする", () => {
        const req = provider.buildRequest(
          [{
            role: "user",
            content: "long stable context",
            providerHints: { anthropic: { cacheControl: { type: "ephemeral" } } },
          }],
          { model: "claude-sonnet-4-20250514" },
        );
        const body = JSON.parse(req.body);
        expect(body.messages[0]).toEqual({
          role: "user",
          content: [{ type: "text", text: "long stable context", cache_control: { type: "ephemeral" } }],
        });
      });

      it("cacheControl=true のシュガーを { type: \"ephemeral\" } に展開する", () => {
        const req = provider.buildRequest(
          [{
            role: "user",
            content: "ctx",
            providerHints: { anthropic: { cacheControl: true } },
          }],
          { model: "claude-sonnet-4-20250514" },
        );
        const body = JSON.parse(req.body);
        expect(body.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
      });

      it("マルチモーダル(array content)の場合は最後のブロックにのみcache_controlを付ける", () => {
        const req = provider.buildRequest(
          [{
            role: "user",
            content: [
              { type: "text", text: "look at this" },
              { type: "image", url: "data:image/png;base64,aGVsbG8=" },
            ],
            providerHints: { anthropic: { cacheControl: true } },
          }],
          { model: "claude-sonnet-4-20250514" },
        );
        const body = JSON.parse(req.body);
        const blocks = body.messages[0].content;
        expect(blocks).toHaveLength(2);
        expect(blocks[0].cache_control).toBeUndefined();
        expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
      });

      it("systemメッセージにcacheControlを指定するとsystemフィールドをblock配列に切り替える", () => {
        const req = provider.buildRequest(
          [
            {
              role: "system",
              content: "long system prompt",
              providerHints: { anthropic: { cacheControl: true } },
            },
            { role: "user", content: "hi" },
          ],
          { model: "claude-sonnet-4-20250514" },
        );
        const body = JSON.parse(req.body);
        expect(body.system).toEqual([
          { type: "text", text: "long system prompt", cache_control: { type: "ephemeral" } },
        ]);
      });

      it("複数systemメッセージで一部だけcacheControlを持つ場合、各メッセージが独立したtextブロックになる", () => {
        const req = provider.buildRequest(
          [
            {
              role: "system",
              content: "static preamble",
              providerHints: { anthropic: { cacheControl: true } },
            },
            { role: "system", content: "volatile header" },
            { role: "user", content: "hi" },
          ],
          { model: "claude-sonnet-4-20250514" },
        );
        const body = JSON.parse(req.body);
        expect(body.system).toEqual([
          { type: "text", text: "static preamble", cache_control: { type: "ephemeral" } },
          { type: "text", text: "volatile header" },
        ]);
      });

      it("hintが無いsystemは従来通りの結合文字列として送る", () => {
        const req = provider.buildRequest(
          [
            { role: "system", content: "a" },
            { role: "system", content: "b" },
            { role: "user", content: "hi" },
          ],
          { model: "claude-sonnet-4-20250514" },
        );
        const body = JSON.parse(req.body);
        expect(body.system).toBe("a\n\nb");
      });

      it("他providerの名前空間のhintは無視する(cross-provider leakage防止)", () => {
        const req = provider.buildRequest(
          [{
            role: "user",
            content: "hi",
            providerHints: { openai: { cacheControl: true } },
          }],
          { model: "claude-sonnet-4-20250514" },
        );
        const body = JSON.parse(req.body);
        expect(body.messages[0]).toEqual({ role: "user", content: "hi" });
      });
    });
  });

  describe("parseResponse", () => {
    it("Anthropicのレスポンス形式を処理する", () => {
      const result = provider.parseResponse({
        content: [{ type: "text", text: "Hello!" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      expect(result.content).toBe("Hello!");
      expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    });

    it("複数のtextブロックを結合する", () => {
      const result = provider.parseResponse({
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world!" },
        ],
      });
      expect(result.content).toBe("Hello world!");
    });

    it("text以外のブロックを無視してtextブロックのみ結合する", () => {
      const result = provider.parseResponse({
        content: [
          { type: "text", text: "Before " },
          { type: "tool_use", id: "t1", name: "fn", input: {} },
          { type: "text", text: "after" },
        ],
      });
      expect(result.content).toBe("Before after");
    });

    it("usageがない場合はundefinedを返す", () => {
      const result = provider.parseResponse({
        content: [{ type: "text", text: "Hi" }],
      });
      expect(result.usage).toBeUndefined();
    });

    it("空のレスポンスを処理できる", () => {
      const result = provider.parseResponse({});
      expect(result.content).toBe("");
    });

    it("usageの値が0の場合も正しく処理する", () => {
      const result = provider.parseResponse({
        content: [{ type: "text", text: "Hi" }],
        usage: { input_tokens: 0, output_tokens: 0 },
      });
      expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    });

    it("stop_reasonをAiFinishReasonにnormalizeする", () => {
      const mk = (reason: string) => provider.parseResponse({
        content: [{ type: "text", text: "x" }],
        stop_reason: reason,
      });
      expect(mk("end_turn").finishReason).toBe("stop");
      expect(mk("stop_sequence").finishReason).toBe("stop");
      expect(mk("max_tokens").finishReason).toBe("length");
      expect(mk("tool_use").finishReason).toBe("tool_use");
      expect(mk("refusal").finishReason).toBe("safety");
      expect(mk("pause_turn").finishReason).toBe("other");
    });

    it("構造化出力のtool_useは最終応答扱いなのでfinishReasonをstopに置換する", () => {
      // Synthetic structured-output tool is an internal transport detail —
      // surface it as a normal stop so consumers don't see an intermediate
      // tool-use reason on what is really a terminal JSON response.
      const result = provider.parseResponse({
        content: [{
          type: "tool_use",
          id: "x",
          name: "__wc_bindable_structured_response__",
          input: { ok: true },
        }],
        stop_reason: "tool_use",
      });
      expect(result.content).toBe('{"ok":true}');
      expect(result.finishReason).toBe("stop");
    });
  });

  describe("parseStreamChunk", () => {
    it("message_stopでdone=trueを返す", () => {
      const result = provider.parseStreamChunk("message_stop", '{"type":"message_stop"}');
      expect(result).toEqual({ done: true });
    });

    it("content_block_deltaからテキスト差分を抽出する", () => {
      const result = provider.parseStreamChunk("content_block_delta",
        '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}'
      );
      expect(result).toEqual({ delta: "Hello", done: false });
    });

    it("message_startからusageを抽出する", () => {
      const result = provider.parseStreamChunk("message_start",
        '{"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}'
      );
      expect(result?.usage).toEqual({ promptTokens: 25, completionTokens: 1, totalTokens: 26 });
    });

    it("message_startのusage値が0の場合も処理する", () => {
      const result = provider.parseStreamChunk("message_start",
        '{"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0}}}'
      );
      expect(result?.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    });

    it("message_startにusageがない場合はnullを返す", () => {
      const result = provider.parseStreamChunk("message_start",
        '{"type":"message_start","message":{}}'
      );
      expect(result).toBeNull();
    });

    it("message_deltaからoutput usageを抽出する", () => {
      const result = provider.parseStreamChunk("message_delta",
        '{"type":"message_delta","usage":{"output_tokens":15}}'
      );
      expect(result?.usage).toEqual({ completionTokens: 15 });
    });

    it("message_deltaのoutput_tokensが0の場合も処理する", () => {
      const result = provider.parseStreamChunk("message_delta",
        '{"type":"message_delta","usage":{"output_tokens":0}}'
      );
      expect(result?.usage).toEqual({ completionTokens: 0 });
    });

    it("message_deltaのusageにoutput_tokensがない場合はcompletionTokensをundefinedにする", () => {
      const result = provider.parseStreamChunk("message_delta",
        '{"type":"message_delta","usage":{}}'
      );
      expect(result?.usage).toEqual({ completionTokens: undefined });
    });

    it("message_deltaにusageが無くstop_reasonのみの場合はfinishReasonを返す", () => {
      const result = provider.parseStreamChunk("message_delta",
        '{"type":"message_delta","delta":{"stop_reason":"end_turn"}}'
      );
      expect(result).toEqual({ finishReason: "stop", done: false });
    });

    it("message_deltaにusageもstop_reasonも無い場合はnullを返す", () => {
      const result = provider.parseStreamChunk("message_delta",
        '{"type":"message_delta","delta":{}}'
      );
      expect(result).toBeNull();
    });

    it("未知のイベントタイプでnullを返す", () => {
      const result = provider.parseStreamChunk("ping",
        '{"type":"ping"}'
      );
      expect(result).toBeNull();
    });

    it("不正なJSONでnullを返す", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = provider.parseStreamChunk(undefined, "invalid");
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        "[@wc-bindable/ai] Failed to parse stream chunk.",
        expect.objectContaining({
          provider: "anthropic",
          event: undefined,
          data: "invalid",
          error: expect.any(SyntaxError),
        })
      );
    });
  });
});

describe("AzureOpenAiProvider", () => {
  const provider = new AzureOpenAiProvider();

  describe("buildRequest", () => {
    it("AzureのURL形式でリクエストを構築する", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hello" }],
        { model: "gpt-4o", baseUrl: "https://myresource.openai.azure.com", apiKey: "azure-key" }
      );
      expect(req.url).toBe("https://myresource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-02-01");
      expect(req.headers["api-key"]).toBe("azure-key");
      expect(req.headers["Authorization"]).toBeUndefined();
      const body = JSON.parse(req.body);
      expect(body.model).toBeUndefined();
    });

    it("カスタムapiVersionを使用できる", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "gpt-4o", baseUrl: "https://myresource.openai.azure.com", apiVersion: "2024-06-01" }
      );
      expect(req.url).toContain("api-version=2024-06-01");
    });

    it("baseUrl未設定時にエラーをスローする", () => {
      expect(() => provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "gpt-4o" }
      )).toThrow("[@wc-bindable/ai] base-url is required for Azure OpenAI.");
    });

    it("apiKey未設定時はapi-keyヘッダーを含まない", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "gpt-4o", baseUrl: "https://test.openai.azure.com" }
      );
      expect(req.headers["api-key"]).toBeUndefined();
    });

    it("temperatureとmaxTokensを設定できる", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "gpt-4o", baseUrl: "https://test.openai.azure.com", temperature: 0.5, maxTokens: 500 }
      );
      const body = JSON.parse(req.body);
      expect(body.temperature).toBe(0.5);
      expect(body.max_tokens).toBe(500);
    });

    it("stream=falseの場合stream_optionsを含まない", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "gpt-4o", baseUrl: "https://test.openai.azure.com", stream: false }
      );
      const body = JSON.parse(req.body);
      expect(body.stream).toBe(false);
      expect(body.stream_options).toBeUndefined();
    });

    it("無効なtemperature/maxTokensはエラーをスローする", () => {
      const opts = { model: "gpt-4o", baseUrl: "https://test.openai.azure.com" };
      expect(() => provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { ...opts, temperature: NaN }
      )).toThrow(/temperature must be a finite number/);
      for (const invalid of [0, -1, 1.5]) {
        expect(() => provider.buildRequest(
          [{ role: "user", content: "Hi" }],
          { ...opts, maxTokens: invalid }
        )).toThrow(/maxTokens must be a positive integer/);
      }
    });
  });

  describe("parseResponse", () => {
    it("OpenAIと同じレスポンス形式を処理する", () => {
      const result = provider.parseResponse({
        choices: [{ message: { content: "Hello!" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      expect(result.content).toBe("Hello!");
    });
  });

  describe("parseStreamChunk", () => {
    it("OpenAIと同じストリーム形式を処理する", () => {
      const result = provider.parseStreamChunk(undefined, "[DONE]");
      expect(result).toEqual({ done: true });
    });
  });
});

describe("GoogleProvider", () => {
  const provider = new GoogleProvider();

  describe("buildRequest", () => {
    it("デフォルトbaseUrlとstreamGenerateContent?alt=sseを使う", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hello" }],
        { model: "gemini-2.5-flash", apiKey: "goog-key" }
      );
      expect(req.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
      expect(req.headers["x-goog-api-key"]).toBe("goog-key");
      expect(req.headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(req.body);
      expect(body.contents).toEqual([{ role: "user", parts: [{ text: "Hello" }] }]);
      expect(body.model).toBeUndefined();
    });

    it("stream=falseではgenerateContentエンドポイントを使う", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "gemini-2.5-flash", stream: false }
      );
      expect(req.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    });

    it("assistantロールをmodelに翻訳する", () => {
      const req = provider.buildRequest(
        [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello back" },
          { role: "user", content: "How are you?" },
        ],
        { model: "gemini-2.5-flash" }
      );
      const body = JSON.parse(req.body);
      expect(body.contents).toEqual([
        { role: "user", parts: [{ text: "Hi" }] },
        { role: "model", parts: [{ text: "Hello back" }] },
        { role: "user", parts: [{ text: "How are you?" }] },
      ]);
    });

    it("systemメッセージをsystemInstructionに分離する", () => {
      const req = provider.buildRequest(
        [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Hi" },
        ],
        { model: "gemini-2.5-flash" }
      );
      const body = JSON.parse(req.body);
      expect(body.systemInstruction).toEqual({ parts: [{ text: "You are helpful" }] });
      expect(body.contents).toEqual([{ role: "user", parts: [{ text: "Hi" }] }]);
    });

    it("複数のsystemメッセージを結合する", () => {
      const req = provider.buildRequest(
        [
          { role: "system", content: "First" },
          { role: "system", content: "Second" },
          { role: "user", content: "Hi" },
        ],
        { model: "gemini-2.5-flash" }
      );
      const body = JSON.parse(req.body);
      expect(body.systemInstruction).toEqual({ parts: [{ text: "First\n\nSecond" }] });
    });

    it("systemメッセージがない場合はsystemInstructionを含まない", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "gemini-2.5-flash" }
      );
      const body = JSON.parse(req.body);
      expect(body.systemInstruction).toBeUndefined();
    });

    it("temperature/maxTokensをgenerationConfigに格納する", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "gemini-2.5-flash", temperature: 0.5, maxTokens: 1000 }
      );
      const body = JSON.parse(req.body);
      expect(body.generationConfig).toEqual({ temperature: 0.5, maxOutputTokens: 1000 });
    });

    it("temperatureとmaxTokensが両方未設定ならgenerationConfigを含まない", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "gemini-2.5-flash" }
      );
      const body = JSON.parse(req.body);
      expect(body.generationConfig).toBeUndefined();
    });

    it("apiKey未設定時はx-goog-api-keyヘッダーを含まない", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "gemini-2.5-flash" }
      );
      expect(req.headers["x-goog-api-key"]).toBeUndefined();
    });

    it("カスタムbaseUrlを使用できる", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "gemini-2.5-flash", baseUrl: "/api/gemini", stream: false }
      );
      expect(req.url).toBe("/api/gemini/v1beta/models/gemini-2.5-flash:generateContent");
    });

    it("無効なtemperature/maxTokensはエラーをスローする", () => {
      expect(() => provider.buildRequest(
        [{ role: "user", content: "Hi" }],
        { model: "gemini-2.5-flash", temperature: NaN }
      )).toThrow(/temperature must be a finite number/);
      for (const invalid of [0, -1, 1.5]) {
        expect(() => provider.buildRequest(
          [{ role: "user", content: "Hi" }],
          { model: "gemini-2.5-flash", maxTokens: invalid }
        )).toThrow(/maxTokens must be a positive integer/);
      }
    });
  });

  describe("parseResponse", () => {
    it("candidatesからcontentとusageを抽出する", () => {
      const result = provider.parseResponse({
        candidates: [{
          content: { role: "model", parts: [{ text: "Hello!" }] },
          finishReason: "STOP",
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      });
      expect(result.content).toBe("Hello!");
      expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
      expect(result.finishReason).toBe("stop");
    });

    it("finishReasonをAiFinishReasonにnormalizeする", () => {
      const mk = (reason: string) => provider.parseResponse({
        candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: reason }],
      });
      expect(mk("STOP").finishReason).toBe("stop");
      expect(mk("MAX_TOKENS").finishReason).toBe("length");
      // Safety-adjacent values all collapse to "safety" — UI branching is the
      // same for them even though Gemini distinguishes them internally.
      expect(mk("SAFETY").finishReason).toBe("safety");
      expect(mk("RECITATION").finishReason).toBe("safety");
      expect(mk("BLOCKLIST").finishReason).toBe("safety");
      expect(mk("PROHIBITED_CONTENT").finishReason).toBe("safety");
      expect(mk("SPII").finishReason).toBe("safety");
      expect(mk("LANGUAGE").finishReason).toBe("safety");
      expect(mk("OTHER").finishReason).toBe("other");
      expect(mk("MALFORMED_FUNCTION_CALL").finishReason).toBe("other");
      expect(mk("FINISH_REASON_UNSPECIFIED").finishReason).toBe("other");
    });

    it("複数のtext partsを結合する", () => {
      const result = provider.parseResponse({
        candidates: [{
          content: { parts: [{ text: "Hello " }, { text: "world!" }] },
        }],
      });
      expect(result.content).toBe("Hello world!");
    });

    it("text以外のpartsを無視する", () => {
      const result = provider.parseResponse({
        candidates: [{
          content: { parts: [
            { text: "Before " },
            { inlineData: { mimeType: "image/png", data: "..." } },
            { text: "after" },
          ] },
        }],
      });
      expect(result.content).toBe("Before after");
    });

    it("usageMetadataがない場合はusage=undefined", () => {
      const result = provider.parseResponse({
        candidates: [{ content: { parts: [{ text: "Hi" }] } }],
      });
      expect(result.usage).toBeUndefined();
    });

    it("空のレスポンスを処理できる", () => {
      const result = provider.parseResponse({});
      expect(result.content).toBe("");
    });

    it("usageの値が0の場合も処理する", () => {
      const result = provider.parseResponse({
        candidates: [{ content: { parts: [{ text: "Hi" }] } }],
        usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
      });
      expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    });

    it("totalTokenCountがない場合はprompt+completionから算出する", () => {
      const result = provider.parseResponse({
        candidates: [{ content: { parts: [{ text: "Hi" }] } }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
      });
      expect(result.usage).toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
    });
  });

  describe("parseStreamChunk", () => {
    it("通常チャンクからdeltaを抽出し、finishReasonなしならdone=false", () => {
      const result = provider.parseStreamChunk(undefined,
        '{"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}'
      );
      expect(result).toEqual({ delta: "Hello", usage: undefined, done: false });
    });

    it("finishReason付きチャンクはdelta/usageを返すがdone=falseのまま（Geminiは別イベントでusageを送るためAiCoreに早期終了させない）", () => {
      const result = provider.parseStreamChunk(undefined,
        '{"candidates":[{"content":{"parts":[{"text":"!"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}'
      );
      expect(result?.delta).toBe("!");
      // Gemini has no end-of-stream sentinel; AiCore exits on server close.
      expect(result?.done).toBe(false);
      expect(result?.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    });

    it("MAX_TOKENSなどSTOP以外のfinishReasonでもdone=falseのまま", () => {
      const result = provider.parseStreamChunk(undefined,
        '{"candidates":[{"content":{"parts":[]},"finishReason":"MAX_TOKENS"}]}'
      );
      expect(result?.done).toBe(false);
    });

    it("usageMetadata単独チャンクを処理する", () => {
      const result = provider.parseStreamChunk(undefined,
        '{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}'
      );
      expect(result?.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
      expect(result?.done).toBe(false);
    });

    it("不正なJSONでnullを返す", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = provider.parseStreamChunk(undefined, "not json");
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        "[@wc-bindable/ai] Failed to parse stream chunk.",
        expect.objectContaining({
          provider: "google",
          event: undefined,
          data: "not json",
          error: expect.any(SyntaxError),
        })
      );
    });

    it("candidatesがない場合でもdeltaをundefinedにしてdone=false", () => {
      const result = provider.parseStreamChunk(undefined, "{}");
      expect(result).toEqual({ delta: undefined, usage: undefined, done: false });
    });
  });
});

describe("Provider — tool use", () => {
  describe("OpenAiProvider", () => {
    const provider = new OpenAiProvider();

    it("tools をリクエストボディに function type で添付する", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "weather?" }],
        {
          model: "gpt-4o",
          tools: [{
            name: "get_weather",
            description: "Lookup weather",
            parameters: { type: "object", properties: { loc: { type: "string" } } },
            handler: () => null,
          }],
          toolChoice: { name: "get_weather" },
        }
      );
      const body = JSON.parse(req.body);
      expect(body.tools).toEqual([{
        type: "function",
        function: {
          name: "get_weather",
          description: "Lookup weather",
          parameters: { type: "object", properties: { loc: { type: "string" } } },
        },
      }]);
      expect(body.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
    });

    it("toolChoice 'auto'/'none' はそのまま送る", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "hi" }],
        { model: "gpt-4o", tools: [{ name: "t", description: "", parameters: {}, handler: () => null }], toolChoice: "auto" },
      );
      expect(JSON.parse(req.body).tool_choice).toBe("auto");

      const req2 = provider.buildRequest(
        [{ role: "user", content: "hi" }],
        { model: "gpt-4o", tools: [{ name: "t", description: "", parameters: {}, handler: () => null }], toolChoice: "none" },
      );
      expect(JSON.parse(req2.body).tool_choice).toBe("none");
    });

    it("assistant + toolCalls を tool_calls 付きで直列化する", () => {
      const req = provider.buildRequest(
        [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "c1", name: "get_weather", arguments: '{"loc":"Tokyo"}' }],
          },
          { role: "tool", content: '{"temp":22}', toolCallId: "c1" },
        ],
        { model: "gpt-4o" },
      );
      const body = JSON.parse(req.body);
      expect(body.messages[1]).toEqual({
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"loc":"Tokyo"}' } }],
      });
      expect(body.messages[2]).toEqual({
        role: "tool",
        content: '{"temp":22}',
        tool_call_id: "c1",
      });
    });

    it("parseResponseがtool_callsを抽出する", () => {
      const result = provider.parseResponse({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "fn_a", arguments: '{"x":1}' } },
              { id: "c2", type: "function", function: { name: "fn_b", arguments: '{}' } },
            ],
          },
          finish_reason: "tool_calls",
        }],
      });
      expect(result.content).toBe("");
      expect(result.toolCalls).toEqual([
        { id: "c1", name: "fn_a", arguments: '{"x":1}' },
        { id: "c2", name: "fn_b", arguments: '{}' },
      ]);
    });

    it("parseResponseでtype!=='function'や欠損idは除外する", () => {
      const result = provider.parseResponse({
        choices: [{
          message: {
            tool_calls: [
              { type: "code_interpreter", id: "x1" },              // type が function でない
              { type: "function", function: { name: "ok" } },        // id 欠損
              { type: "function", id: "c3", function: { name: "" } },// name 欠損
              { type: "function", id: "c4", function: { name: "good", arguments: '{}' } },
            ],
          },
        }],
      });
      expect(result.toolCalls).toEqual([{ id: "c4", name: "good", arguments: '{}' }]);
    });

    it("parseStreamChunkがtool_call deltasを配列で返す", () => {
      const result = provider.parseStreamChunk(undefined,
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"fn_a","arguments":""}},{"index":1,"id":"c2","type":"function","function":{"name":"fn_b"}}]}}]}'
      );
      expect(result?.toolCallDeltas).toEqual([
        { index: 0, id: "c1", name: "fn_a", argumentsDelta: "" },
        { index: 1, id: "c2", name: "fn_b" },
      ]);
      expect(result?.done).toBe(false);
    });

    it("parseStreamChunkがargumentsの断片を拾う", () => {
      const result = provider.parseStreamChunk(undefined,
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"loc"}}]}}]}'
      );
      expect(result?.toolCallDeltas).toEqual([
        { index: 0, argumentsDelta: '{"loc' },
      ]);
    });

    it("finish_reason=tool_callsでdone=trueを返す", () => {
      const result = provider.parseStreamChunk(undefined,
        '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'
      );
      expect(result?.done).toBe(true);
    });
  });

  describe("AnthropicProvider", () => {
    const provider = new AnthropicProvider();

    it("tools を input_schema 付きで直列化する", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "hi" }],
        {
          model: "claude-sonnet-4",
          tools: [{
            name: "lookup",
            description: "",
            parameters: { type: "object", properties: {} },
            handler: () => null,
          }],
          toolChoice: "auto",
        }
      );
      const body = JSON.parse(req.body);
      expect(body.tools).toEqual([{
        name: "lookup",
        description: "",
        input_schema: { type: "object", properties: {} },
      }]);
      expect(body.tool_choice).toEqual({ type: "auto" });
    });

    it("toolChoice {name} を tool type で送る", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "hi" }],
        {
          model: "claude-sonnet-4",
          tools: [{ name: "fn", description: "", parameters: {}, handler: () => null }],
          toolChoice: { name: "fn" },
        }
      );
      expect(JSON.parse(req.body).tool_choice).toEqual({ type: "tool", name: "fn" });
    });

    it("assistant+toolCallsをtool_useブロックで直列化し、toolメッセージをuserロールのtool_resultで直列化する", () => {
      const req = provider.buildRequest(
        [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: "Let me check.",
            toolCalls: [{ id: "c1", name: "get_weather", arguments: '{"loc":"Tokyo"}' }],
          },
          { role: "tool", content: "22C", toolCallId: "c1" },
        ],
        { model: "claude-sonnet-4" }
      );
      const body = JSON.parse(req.body);
      expect(body.messages[1]).toEqual({
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "c1", name: "get_weather", input: { loc: "Tokyo" } },
        ],
      });
      expect(body.messages[2]).toEqual({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "c1", content: "22C" }],
      });
    });

    it("parseResponseがtool_useブロックを抽出する", () => {
      const result = provider.parseResponse({
        content: [
          { type: "text", text: "Checking..." },
          { type: "tool_use", id: "c1", name: "get_weather", input: { loc: "Tokyo" } },
        ],
      });
      expect(result.content).toBe("Checking...");
      expect(result.toolCalls).toEqual([
        { id: "c1", name: "get_weather", arguments: '{"loc":"Tokyo"}' },
      ]);
    });

    it("parseStreamChunk: content_block_start(tool_use) で id/name を emit", () => {
      const result = provider.parseStreamChunk("content_block_start",
        '{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"c1","name":"fn"}}'
      );
      expect(result?.toolCallDeltas).toEqual([{ index: 1, id: "c1", name: "fn" }]);
    });

    it("parseStreamChunk: input_json_deltaでargumentsDeltaを emit", () => {
      const result = provider.parseStreamChunk("content_block_delta",
        '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"loc"}}'
      );
      expect(result?.toolCallDeltas).toEqual([{ index: 1, argumentsDelta: '{"loc' }]);
    });
  });

  describe("GoogleProvider", () => {
    const provider = new GoogleProvider();

    it("tools を functionDeclarations でラップする", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "hi" }],
        {
          model: "gemini-2.5-flash",
          stream: false,
          tools: [{
            name: "get_weather",
            description: "",
            parameters: { type: "object" },
            handler: () => null,
          }],
          toolChoice: "auto",
        }
      );
      const body = JSON.parse(req.body);
      expect(body.tools).toEqual([{
        functionDeclarations: [{ name: "get_weather", description: "", parameters: { type: "object" } }],
      }]);
      expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    });

    it("toolChoice {name} を ANY+allowedFunctionNames で送る", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "hi" }],
        {
          model: "gemini-2.5-flash",
          stream: false,
          tools: [{ name: "fn", description: "", parameters: {}, handler: () => null }],
          toolChoice: { name: "fn" },
        }
      );
      expect(JSON.parse(req.body).toolConfig).toEqual({
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["fn"] },
      });
    });

    it("assistant+toolCallsをfunctionCallパートで直列化、toolをuserロール+functionResponseで送る", () => {
      const req = provider.buildRequest(
        [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "gemini:get_weather:0", name: "get_weather", arguments: '{"loc":"Tokyo"}' }],
          },
          { role: "tool", content: '{"temp":22}', toolCallId: "gemini:get_weather:0" },
        ],
        { model: "gemini-2.5-flash", stream: false }
      );
      const body = JSON.parse(req.body);
      expect(body.contents[1]).toEqual({
        role: "model",
        parts: [{ functionCall: { name: "get_weather", args: { loc: "Tokyo" } } }],
      });
      // Gemini's Content.role is "user" | "model"; functionResponse parts go
      // on a user-role Content per the official function-calling example.
      expect(body.contents[2]).toEqual({
        role: "user",
        parts: [{ functionResponse: { name: "get_weather", response: { temp: 22 } } }],
      });
    });

    it("parseResponseがfunctionCallパートを合成IDで抽出する", () => {
      const result = provider.parseResponse({
        candidates: [{
          content: {
            parts: [
              { text: "Looking up..." },
              { functionCall: { name: "get_weather", args: { loc: "Tokyo" } } },
            ],
          },
          finishReason: "STOP",
        }],
      });
      expect(result.content).toBe("Looking up...");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].name).toBe("get_weather");
      expect(result.toolCalls![0].id).toMatch(/^gemini:get_weather:\d+$/);
      expect(result.toolCalls![0].arguments).toBe('{"loc":"Tokyo"}');
    });

    it("parseStreamChunkがfunctionCallをtoolCallDeltasで返す", () => {
      const result = provider.parseStreamChunk(undefined,
        '{"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"loc":"Tokyo"}}}]}}]}'
      );
      expect(result?.toolCallDeltas).toHaveLength(1);
      const d = result!.toolCallDeltas![0];
      expect(d.name).toBe("get_weather");
      expect(d.argumentsDelta).toBe('{"loc":"Tokyo"}');
      expect(d.id).toMatch(/^gemini:get_weather:\d+$/);
    });

    it("parseResponseはサーバー供給のfunctionCall.idをそのまま保持する（Vertex / 新API互換）", () => {
      // Newer Gemini / Vertex include an `id` on functionCall for parallel
      // call disambiguation. It must round-trip verbatim; no synthetic overwrite.
      const result = provider.parseResponse({
        candidates: [{
          content: {
            parts: [
              { functionCall: { name: "fetch", args: { x: 1 }, id: "call_abc" } },
              { functionCall: { name: "fetch", args: { x: 2 }, id: "call_def" } },
            ],
          },
          finishReason: "STOP",
        }],
      });
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls![0].id).toBe("call_abc");
      expect(result.toolCalls![1].id).toBe("call_def");
    });

    it("parseStreamChunkもサーバー供給idを保持する", () => {
      const result = provider.parseStreamChunk(undefined,
        '{"candidates":[{"content":{"parts":[{"functionCall":{"name":"fetch","args":{},"id":"call_server_123"}}]}}]}'
      );
      expect(result?.toolCallDeltas?.[0].id).toBe("call_server_123");
    });

    it("_serializeMessage: 非合成idはfunctionCall / functionResponse に echo される", () => {
      const req = provider.buildRequest(
        [
          { role: "user", content: "run twice" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "call_A", name: "ping", arguments: '{"i":1}' },
              { id: "call_B", name: "ping", arguments: '{"i":2}' },
            ],
          },
          { role: "tool", content: '{"ok":1}', toolCallId: "call_A" },
          { role: "tool", content: '{"ok":2}', toolCallId: "call_B" },
        ],
        { model: "gemini-2.5-flash", stream: false },
      );
      const body = JSON.parse(req.body);
      // assistant → functionCall.id echoed
      expect(body.contents[1].parts).toEqual([
        { functionCall: { name: "ping", args: { i: 1 }, id: "call_A" } },
        { functionCall: { name: "ping", args: { i: 2 }, id: "call_B" } },
      ]);
      // tool → functionResponse.id echoed, name looked up via idToName map
      expect(body.contents[2]).toEqual({
        role: "user",
        parts: [{ functionResponse: { name: "ping", response: { ok: 1 }, id: "call_A" } }],
      });
      expect(body.contents[3]).toEqual({
        role: "user",
        parts: [{ functionResponse: { name: "ping", response: { ok: 2 }, id: "call_B" } }],
      });
    });

    it("_serializeMessage: 合成id（gemini:プレフィックス）はwireに漏れない", () => {
      const req = provider.buildRequest(
        [
          { role: "user", content: "x" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "gemini:lookup:0", name: "lookup", arguments: "{}" }],
          },
          { role: "tool", content: '{"v":1}', toolCallId: "gemini:lookup:0" },
        ],
        { model: "gemini-2.5-flash", stream: false },
      );
      const body = JSON.parse(req.body);
      // functionCall no id field
      expect(body.contents[1].parts[0]).toEqual({
        functionCall: { name: "lookup", args: {} },
      });
      // functionResponse no id field
      expect(body.contents[2].parts[0]).toEqual({
        functionResponse: { name: "lookup", response: { v: 1 } },
      });
    });
  });
});

describe("Provider — structured output", () => {
  const schema = {
    type: "object",
    properties: {
      title: { type: "string" },
      rating: { type: "number" },
    },
    required: ["title", "rating"],
    additionalProperties: false,
  };

  describe("OpenAiProvider", () => {
    const provider = new OpenAiProvider();

    it("responseSchemaをresponse_format.json_schemaに変換する", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "analyze" }],
        { model: "gpt-4o", responseSchema: schema, responseSchemaName: "review" },
      );
      const body = JSON.parse(req.body);
      expect(body.response_format).toEqual({
        type: "json_schema",
        json_schema: { name: "review", schema, strict: true },
      });
    });

    it("nameが省略された場合は'response'をデフォルトにする", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "x" }],
        { model: "gpt-4o", responseSchema: schema },
      );
      expect(JSON.parse(req.body).response_format.json_schema.name).toBe("response");
    });

    it("responseSchema未設定ではresponse_formatを含まない", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "x" }],
        { model: "gpt-4o" },
      );
      expect(JSON.parse(req.body).response_format).toBeUndefined();
    });
  });

  describe("AzureOpenAiProvider", () => {
    const provider = new AzureOpenAiProvider();

    it("OpenAIと同じresponse_format形式を送る", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "x" }],
        { model: "gpt-4o", baseUrl: "https://x.openai.azure.com", responseSchema: schema },
      );
      expect(JSON.parse(req.body).response_format).toEqual({
        type: "json_schema",
        json_schema: { name: "response", schema, strict: true },
      });
    });
  });

  describe("GoogleProvider", () => {
    const provider = new GoogleProvider();

    it("generationConfigにresponseMimeTypeとresponseSchemaを入れる", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "x" }],
        { model: "gemini-2.5-flash", stream: false, responseSchema: schema },
      );
      const body = JSON.parse(req.body);
      expect(body.generationConfig).toMatchObject({
        responseMimeType: "application/json",
        responseSchema: schema,
      });
    });
  });

  describe("AnthropicProvider", () => {
    const provider = new AnthropicProvider();

    it("合成toolを注入しtool_choiceでそれを強制、streamをfalseにする", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "analyze" }],
        { model: "claude-sonnet-4", responseSchema: schema, stream: true },
      );
      const body = JSON.parse(req.body);
      expect(body.stream).toBe(false);
      expect(body.tool_choice).toEqual({ type: "tool", name: "__wc_bindable_structured_response__" });
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0]).toMatchObject({
        name: "__wc_bindable_structured_response__",
        input_schema: schema,
      });
    });

    it("parseResponseは合成tool_useをJSON文字列contentとして返しtoolCallsを出さない", () => {
      const result = provider.parseResponse({
        content: [{
          type: "tool_use",
          id: "irrelevant",
          name: "__wc_bindable_structured_response__",
          input: { title: "Good", rating: 4 },
        }],
        usage: { input_tokens: 5, output_tokens: 10 },
      });
      expect(result.content).toBe('{"title":"Good","rating":4}');
      expect(result.toolCalls).toBeUndefined();
      expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 10, totalTokens: 15 });
    });
  });
});

describe("Provider — multimodal", () => {
  describe("OpenAiProvider", () => {
    const provider = new OpenAiProvider();

    it("text + image URL のcontent配列をOpenAIの形式に変換する", () => {
      const req = provider.buildRequest(
        [{
          role: "user",
          content: [
            { type: "text", text: "What's in this image?" },
            { type: "image", url: "https://example.com/cat.jpg" },
          ],
        }],
        { model: "gpt-4o" },
      );
      const body = JSON.parse(req.body);
      expect(body.messages[0]).toEqual({
        role: "user",
        content: [
          { type: "text", text: "What's in this image?" },
          { type: "image_url", image_url: { url: "https://example.com/cat.jpg" } },
        ],
      });
    });

    it("string contentは従来通りそのまま送る", () => {
      const req = provider.buildRequest(
        [{ role: "user", content: "plain text" }],
        { model: "gpt-4o" },
      );
      expect(JSON.parse(req.body).messages[0]).toEqual({ role: "user", content: "plain text" });
    });

    it("assistant+toolCalls時は配列contentをテキストにflattenしてから載せる", () => {
      const req = provider.buildRequest(
        [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "on it" }],
            toolCalls: [{ id: "c1", name: "fn", arguments: "{}" }],
          },
        ],
        { model: "gpt-4o" },
      );
      const body = JSON.parse(req.body);
      expect(body.messages[1]).toMatchObject({ role: "assistant", content: "on it" });
    });

    it("system contentが配列でもflattenされる", () => {
      const req = provider.buildRequest(
        [
          { role: "system", content: [{ type: "text", text: "Be terse." }] },
          { role: "user", content: "x" },
        ],
        { model: "gpt-4o" },
      );
      expect(JSON.parse(req.body).messages[0]).toEqual({ role: "system", content: "Be terse." });
    });
  });

  describe("AnthropicProvider", () => {
    const provider = new AnthropicProvider();

    it("http URL 画像は source.type='url' で送る", () => {
      const req = provider.buildRequest(
        [{
          role: "user",
          content: [
            { type: "text", text: "Describe" },
            { type: "image", url: "https://example.com/a.png" },
          ],
        }],
        { model: "claude-sonnet-4" },
      );
      const body = JSON.parse(req.body);
      expect(body.messages[0]).toEqual({
        role: "user",
        content: [
          { type: "text", text: "Describe" },
          { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
        ],
      });
    });

    it("data: URL 画像は source.type='base64' で送る", () => {
      const req = provider.buildRequest(
        [{
          role: "user",
          content: [
            { type: "image", url: "data:image/png;base64,iVBORw0KG==" },
          ],
        }],
        { model: "claude-sonnet-4" },
      );
      const body = JSON.parse(req.body);
      expect(body.messages[0].content[0]).toEqual({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "iVBORw0KG==" },
      });
    });

    it("mediaType明示指定時はdata:URL ヘッダーより優先する", () => {
      const req = provider.buildRequest(
        [{
          role: "user",
          content: [
            { type: "image", url: "data:application/octet-stream;base64,AAAA", mediaType: "image/jpeg" },
          ],
        }],
        { model: "claude-sonnet-4" },
      );
      expect(JSON.parse(req.body).messages[0].content[0].source.media_type).toBe("image/jpeg");
    });
  });

  describe("GoogleProvider", () => {
    const provider = new GoogleProvider();

    it("data: URL 画像をinlineDataで送る", () => {
      const req = provider.buildRequest(
        [{
          role: "user",
          content: [
            { type: "text", text: "label" },
            { type: "image", url: "data:image/png;base64,iVBORw0KG==" },
          ],
        }],
        { model: "gemini-2.5-flash", stream: false },
      );
      const body = JSON.parse(req.body);
      expect(body.contents[0]).toEqual({
        role: "user",
        parts: [
          { text: "label" },
          { inlineData: { mimeType: "image/png", data: "iVBORw0KG==" } },
        ],
      });
    });

    it("http URL はbuildRequest時に明示エラーになる", () => {
      expect(() => provider.buildRequest(
        [{
          role: "user",
          content: [{ type: "image", url: "https://example.com/a.png" }],
        }],
        { model: "gemini-2.5-flash", stream: false },
      )).toThrow(/requires a data: URL/);
    });
  });
});
