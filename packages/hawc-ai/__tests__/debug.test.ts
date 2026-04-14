import { afterEach, describe, expect, it, vi } from "vitest";
import { warnStreamParseFailure } from "../src/debug";

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
      "[@wc-bindable/hawc-ai] Failed to parse stream chunk.",
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
});