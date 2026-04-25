import { afterEach, describe, expect, it, vi } from "vitest";
import {
  warnApiKeyInRemoteMode,
  warnMalformedToolCall,
  warnStreamParseFailure,
} from "../src/debug";

describe("debug", () => {
  const originalNodeEnv = (globalThis as any).process?.env?.NODE_ENV;

  afterEach(() => {
    vi.restoreAllMocks();
    if (!(globalThis as any).process) {
      (globalThis as any).process = { env: {} };
    } else if (!(globalThis as any).process.env) {
      (globalThis as any).process.env = {};
    }

    if (originalNodeEnv === undefined) {
      delete (globalThis as any).process.env.NODE_ENV;
    } else {
      (globalThis as any).process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("development環境ではstream parse failureを警告する", () => {
    (globalThis as any).process = { env: { NODE_ENV: "development" } };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = new Error("parse failed");

    warnStreamParseFailure("openai", "message", "data", error);

    expect(warnSpy).toHaveBeenCalledWith(
      "[@wc-bindable/ai] Failed to parse stream chunk.",
      {
        provider: "openai",
        event: "message",
        data: "data",
        error,
      },
    );
  });

  it("console.warnが使えない環境でも何もしない", () => {
    (globalThis as any).process = { env: { NODE_ENV: "development" } };
    const originalConsole = globalThis.console;
    (globalThis as any).console = {};

    expect(() => {
      warnStreamParseFailure("openai", undefined, "data", new Error("parse failed"));
    }).not.toThrow();

    (globalThis as any).console = originalConsole;
  });

  describe("warnMalformedToolCall", () => {
    it("development環境ではmalformed tool_callを警告する", () => {
      (globalThis as any).process = { env: { NODE_ENV: "development" } };
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      warnMalformedToolCall(2, { id: undefined, name: "lookup", arguments: "{\"q\":1}" });

      expect(warnSpy).toHaveBeenCalledWith(
        "[@wc-bindable/ai] Dropped malformed tool_call accumulator (missing id or name).",
        {
          index: 2,
          id: undefined,
          name: "lookup",
          argumentsLength: 7,
        },
      );
    });

    it("console.warnが使えない環境でも何もしない", () => {
      (globalThis as any).process = { env: { NODE_ENV: "development" } };
      const originalConsole = globalThis.console;
      (globalThis as any).console = {};

      expect(() => {
        warnMalformedToolCall(0, { arguments: "" });
      }).not.toThrow();

      (globalThis as any).console = originalConsole;
    });

    // production での no-op は warnStreamParseFailure と同様 import.meta.env.DEV に
    // 依存し、vitest では DEV=true 固定で production を再現できないためカバーしない
    // （既存の warnStreamParseFailure テストと同じ方針）。
  });

  describe("warnApiKeyInRemoteMode", () => {
    it("development環境ではapi-key leakを警告する", () => {
      (globalThis as any).process = { env: { NODE_ENV: "development" } };
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      warnApiKeyInRemoteMode();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message] = warnSpy.mock.calls[0];
      expect(message).toContain("[@wc-bindable/ai]");
      expect(message).toContain("`api-key` attribute");
      expect(message).toContain("remote mode");
    });

    it("console.warnが使えない環境でも何もしない", () => {
      (globalThis as any).process = { env: { NODE_ENV: "development" } };
      const originalConsole = globalThis.console;
      (globalThis as any).console = {};

      expect(() => {
        warnApiKeyInRemoteMode();
      }).not.toThrow();

      (globalThis as any).console = originalConsole;
    });

    // production no-op は warnMalformedToolCall 側の注記を参照。
  });
});