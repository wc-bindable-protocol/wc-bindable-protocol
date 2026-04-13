import { describe, it, expect, vi } from "vitest";
import type { WcBindableDeclaration } from "@wc-bindable/core";
import { RemoteShellProxy } from "../src/RemoteShellProxy.js";
import type {
  ServerTransport,
  ClientMessage,
} from "../src/types.js";
import { createSyncTransportPair, flush, TestCore } from "./_helpers.js";

describe("RemoteShellProxy", () => {
  it("throws if Core lacks wcBindable declaration", () => {
    const { server } = createSyncTransportPair();
    expect(() => new RemoteShellProxy(new EventTarget(), server)).toThrow(
      "RemoteShellProxy: target must have static wcBindable declaration",
    );
  });

  it("does not send initial values on construction", () => {
    const core = new TestCore();
    (core as unknown as Record<string, unknown>)._value = "initial";
    const send = vi.fn();
    const server: ServerTransport = {
      send,
      onMessage: () => {},
    };
    new RemoteShellProxy(core, server);
    // No messages should be sent during construction.
    expect(send).not.toHaveBeenCalled();
  });

  it("responds to sync request with current values", () => {
    const core = new TestCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "sync" });

    expect(send).toHaveBeenCalledWith({
      type: "sync",
      values: { value: null, loading: false },
      capabilities: { setAck: true },
    });
  });

  it("logs and swallows sync send failures", () => {
    const core = new TestCore();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send: () => {
        throw new TypeError("Converting circular structure to JSON");
      },
      onMessage: (h) => { handler = h; },
    };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    new RemoteShellProxy(core, server);

    expect(() => handler!({ type: "sync" })).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      "RemoteShellProxy: failed to send sync response:",
      expect.any(TypeError),
    );

    errorSpy.mockRestore();
  });

  it("handles declarations without inputs or commands and omits undefined current values", () => {
    class MinimalCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [{ name: "missing", event: "minimal:changed" }],
      };

      get missing(): undefined {
        return undefined;
      }
    }

    const core = new MinimalCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "sync" });

    expect(send).toHaveBeenCalledWith({ type: "sync", values: {}, capabilities: { setAck: true } });
  });

  it("logs and skips properties whose getters throw during sync", () => {
    class ThrowingGetterCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [
          { name: "ok", event: "throwing:ok" },
          { name: "bad", event: "throwing:bad" },
        ],
      };

      get ok(): string {
        return "value";
      }

      get bad(): never {
        throw new Error("broken getter");
      }
    }

    const core = new ThrowingGetterCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    new RemoteShellProxy(core, server);

    expect(() => handler!({ type: "sync" })).not.toThrow();
    expect(send).toHaveBeenCalledWith({
      type: "sync",
      values: { ok: "value" },
      capabilities: { setAck: true },
      getterFailures: ["bad"],
    });
    expect(errorSpy).toHaveBeenCalledWith(
      'RemoteShellProxy: getter for "bad" threw during sync:',
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });

  it("queues updates emitted while building a sync snapshot until after sync", () => {
    class SyncSideEffectCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [
          { name: "value", event: "sync-side-effect:value" },
          { name: "status", event: "sync-side-effect:status" },
        ],
      };

      get value(): string {
        this.dispatchEvent(new CustomEvent("sync-side-effect:status", { detail: "queued" }));
        return "snapshot";
      }

      get status(): string {
        return "current";
      }
    }

    const core = new SyncSideEffectCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "sync" });

    expect(send).toHaveBeenNthCalledWith(1, {
      type: "sync",
      values: { value: "snapshot", status: "current" },
      capabilities: { setAck: true },
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      type: "update",
      name: "status",
      value: "queued",
    });
  });

  it("does not drop events emitted while flushing queued sync updates", () => {
    class FlushSideEffectCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [
          { name: "value", event: "flush-side-effect:value" },
          { name: "status", event: "flush-side-effect:status" },
        ],
      };

      get value(): string {
        this.dispatchEvent(new CustomEvent("flush-side-effect:status", { detail: "queued" }));
        return "snapshot";
      }

      get status(): string {
        return "current";
      }
    }

    const core = new FlushSideEffectCore();
    const sent: ServerMessage[] = [];
    let handler: ((msg: ClientMessage) => void) | null = null;
    let emittedDuringFlush = false;
    const server: ServerTransport = {
      send: (message) => {
        sent.push(message);
        if (
          !emittedDuringFlush &&
          message.type === "update" &&
          message.name === "status" &&
          message.value === "queued"
        ) {
          emittedDuringFlush = true;
          core.dispatchEvent(new CustomEvent("flush-side-effect:status", { detail: "after-flush" }));
        }
      },
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "sync" });

    expect(sent).toEqual([
      { type: "sync", values: { value: "snapshot", status: "current" }, capabilities: { setAck: true } },
      { type: "update", name: "status", value: "queued" },
      { type: "update", name: "status", value: "after-flush" },
    ]);
  });

  it("forwards Core events to transport as property updates", () => {
    const core = new TestCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    core.dispatchEvent(new CustomEvent("test:value-changed", { detail: "hello" }));

    expect(send).toHaveBeenCalledWith({
      type: "update",
      name: "value",
      value: "hello",
    });
  });

  it("logs and swallows update send failures", () => {
    const core = new TestCore();
    const server: ServerTransport = {
      send: () => {
        throw new TypeError("Do not know how to serialize a BigInt");
      },
      onMessage: () => {},
    };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => {
      new RemoteShellProxy(core, server);
      core.dispatchEvent(new CustomEvent("test:value-changed", { detail: 1n }));
    }).not.toThrow();

    expect(errorSpy).toHaveBeenCalledWith(
      'RemoteShellProxy: failed to send update for "value":',
      expect.any(TypeError),
    );

    errorSpy.mockRestore();
  });

  it("forwards shared-event properties as separate updates with getter-applied values", () => {
    class SharedEventCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [
          { name: "value", event: "shared:response", getter: (e) => (e as CustomEvent).detail.value },
          { name: "status", event: "shared:response", getter: (e) => (e as CustomEvent).detail.status },
        ],
      };
    }

    const core = new SharedEventCore();
    const send = vi.fn();
    const server: ServerTransport = {
      send,
      onMessage: () => {},
    };

    new RemoteShellProxy(core, server);
    core.dispatchEvent(
      new CustomEvent("shared:response", { detail: { value: { ok: true }, status: 200 } }),
    );

    // Two distinct updates — one per property — with getter-applied values.
    expect(send).toHaveBeenCalledWith({ type: "update", name: "value", value: { ok: true } });
    expect(send).toHaveBeenCalledWith({ type: "update", name: "status", value: 200 });
  });

  it("applies set messages to Core properties", () => {
    const core = new TestCore();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send: () => {},
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "set", name: "url", value: "/api/users" });

    expect(core.url).toBe("/api/users");
  });

  it("acknowledges setWithAck messages after applying the input", () => {
    const core = new TestCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "set", name: "url", value: "/api/ack", id: "set-1" });

    expect(core.url).toBe("/api/ack");
    expect(send).toHaveBeenCalledWith({ type: "return", id: "set-1", value: undefined });
  });

  it("handles sync cmd and returns result", async () => {
    const core = new TestCore();
    core.url = "/api/data";
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "abort", id: "1", args: [] });

    expect(send).toHaveBeenCalledWith({ type: "return", id: "1", value: undefined });
  });

  it("handles async cmd and returns resolved value", async () => {
    const core = new TestCore();
    core.url = "/test";
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "doFetch", id: "2", args: [] });

    await flush();

    expect(send).toHaveBeenCalledWith({
      type: "return",
      id: "2",
      value: { data: "fetched:/test" },
    });
  });

  it("awaits thenable return values (not just native Promise instances)", async () => {
    class ThenableCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "thenable", async: true }],
      };
      thenable(): PromiseLike<string> {
        return {
          then(onFulfilled) {
            return Promise.resolve(onFulfilled ? onFulfilled("resolved-via-thenable") : "resolved-via-thenable");
          },
        } as PromiseLike<string>;
      }
    }

    const core = new ThenableCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "thenable", id: "thenable-1", args: [] });

    await flush();
    await flush();

    expect(send).toHaveBeenCalledWith({
      type: "return",
      id: "thenable-1",
      value: "resolved-via-thenable",
    });
  });

  it("propagates rejections from thenable return values as throw messages", async () => {
    class RejectingThenableCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "fail", async: true }],
      };
      fail(): PromiseLike<never> {
        return {
          then(_onFulfilled, onRejected) {
            return Promise.resolve(onRejected ? onRejected(new Error("thenable boom")) : undefined);
          },
        } as PromiseLike<never>;
      }
    }

    const core = new RejectingThenableCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "fail", id: "thenable-fail", args: [] });

    await flush();
    await flush();

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "thenable-fail",
      error: expect.objectContaining({
        name: "Error",
        message: "thenable boom",
      }),
    });
  });

  it("rejects cmd not declared in commands", () => {
    const core = new TestCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "nonExistent", id: "3", args: [] });

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "3",
      error: {
        name: "RemoteShellProxyError",
        message: 'Command "nonExistent" is not declared in wcBindable.commands',
      },
    });
  });

  it("rejects declared commands that are not functions on the core", () => {
    class InvalidCommandCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "boom" }],
      };
      boom = "not-a-function";
    }

    const core = new InvalidCommandCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "boom", id: "invalid", args: [] });

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "invalid",
      error: {
        name: "RemoteShellProxyError",
        message: 'Method "boom" not found on Core',
      },
    });
  });

  it("ignores set for properties not declared in inputs", () => {
    const core = new TestCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // _value is a private field, not declared in inputs
    handler!({ type: "set", name: "_value", value: "hacked" });
    expect((core as unknown as Record<string, unknown>)._value).not.toBe("hacked");
    expect(warnSpy).toHaveBeenCalledWith(
      'RemoteShellProxy: ignored set for undeclared input "_value"',
    );

    // url IS declared in inputs — should work
    handler!({ type: "set", name: "url", value: "/allowed" });
    expect(core.url).toBe("/allowed");

    warnSpy.mockRestore();
  });

  it("rejects acknowledged sets for undeclared inputs", () => {
    const core = new TestCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "set", name: "missing", value: 1, id: "bad-set" });

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "bad-set",
      error: {
        name: "RemoteShellProxyError",
        message: 'Input "missing" is not declared in wcBindable.inputs',
      },
    });
  });

  it("treats an empty string set id as an acknowledged request", () => {
    const core = new TestCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "set", name: "url", value: "/empty-id", id: "" });

    expect(send).toHaveBeenCalledWith({ type: "return", id: "", value: undefined });
  });

  it("isolates setter exceptions so the message handler survives", () => {
    class ThrowingSetterCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        inputs: [{ name: "value" }],
      };
      set value(_v: unknown) {
        throw new Error("invalid");
      }
      get value(): unknown {
        return undefined;
      }
    }

    const core = new ThrowingSetterCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Must not throw — the exception should be caught inside the handler.
    expect(() => handler!({ type: "set", name: "value", value: "bad" })).not.toThrow();

    // Developer-visible log captures the failure.
    expect(errorSpy).toHaveBeenCalled();
    const call = errorSpy.mock.calls[0];
    expect(String(call[0])).toContain("value");
    expect((call[1] as Error).message).toBe("invalid");

    // Handler still alive — subsequent sync request is processed.
    handler!({ type: "sync" });
    expect(send).toHaveBeenCalledWith({ type: "sync", values: {}, capabilities: { setAck: true } });

    errorSpy.mockRestore();
  });

  it("returns throw for acknowledged sets whose setters throw", () => {
    class ThrowingSetterCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        inputs: [{ name: "value" }],
      };
      set value(_v: unknown) {
        throw new TypeError("invalid");
      }
      get value(): unknown {
        return undefined;
      }
    }

    const core = new ThrowingSetterCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "set", name: "value", value: "bad", id: "set-throw" });

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "set-throw",
      error: expect.objectContaining({
        name: "TypeError",
        message: "invalid",
      }),
    });
  });

  it("falls back to a serializable throw payload for non-serializable setter failures", () => {
    class ThrowingSetterCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        inputs: [{ name: "value" }],
      };
      set value(_v: unknown) {
        throw 1n;
      }
      get value(): unknown {
        return undefined;
      }
    }

    const core = new ThrowingSetterCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "set", name: "value", value: "bad", id: "set-bigint" });

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "set-bigint",
      error: {
        name: "RemoteShellProxyError",
        message: "Thrown value is not JSON-serializable",
      },
    });
  });

  it("sends throw message when async cmd rejects", async () => {
    class FailCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "fail", async: true }],
      };
      async fail(): Promise<never> {
        throw new Error("something went wrong");
      }
    }

    const core = new FailCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "fail", id: "4", args: [] });

    await flush();

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "4",
      error: expect.objectContaining({
        name: "Error",
        message: "something went wrong",
      }),
    });
  });

  it("passes through non-Error async rejections", async () => {
    class StringRejectCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "fail" }],
      };

      async fail(): Promise<never> {
        throw "plain failure";
      }
    }

    const core = new StringRejectCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "fail", id: "string-async", args: [] });

    await flush();

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "string-async",
      error: "plain failure",
    });
  });

  it("falls back to a serializable throw payload for non-serializable async rejections", async () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    class CircularRejectCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "fail" }],
      };

      async fail(): Promise<never> {
        throw circular;
      }
    }

    const core = new CircularRejectCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "fail", id: "circular-async", args: [] });

    await flush();

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "circular-async",
      error: {
        name: "RemoteShellProxyError",
        message: "Thrown value is not JSON-serializable",
      },
    });
  });

  it("sends throw message when sync cmd throws", () => {
    class ThrowCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "boom" }],
      };
      boom(): never {
        throw new Error("sync error");
      }
    }

    const core = new ThrowCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "boom", id: "5", args: [] });

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "5",
      error: expect.objectContaining({
        name: "Error",
        message: "sync error",
      }),
    });
  });

  it("serializes thrown Error objects with name, message, and stack", () => {
    class CustomRemoteError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "CustomRemoteError";
      }
    }

    class ThrowCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "boom" }],
      };
      boom(): never {
        throw new CustomRemoteError("structured failure");
      }
    }

    const core = new ThrowCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "boom", id: "structured", args: [] });

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "structured",
      error: expect.objectContaining({
        name: "CustomRemoteError",
        message: "structured failure",
        stack: expect.any(String),
      }),
    });
  });

  it("serializes a JSON-safe Error cause", () => {
    class ThrowCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "boom" }],
      };
      boom(): never {
        throw new Error("sync error", { cause: { status: 503, retryable: true } });
      }
    }

    const core = new ThrowCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "boom", id: "structured-cause", args: [] });

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "structured-cause",
      error: expect.objectContaining({
        name: "Error",
        message: "sync error",
        cause: { status: 503, retryable: true },
      }),
    });
  });

  it("passes through non-Error sync throws", () => {
    class StringThrowCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "boom" }],
      };

      boom(): never {
        throw "plain sync failure";
      }
    }

    const core = new StringThrowCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "boom", id: "string-sync", args: [] });

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "string-sync",
      error: "plain sync failure",
    });
  });

  it("stops forwarding events after dispose()", () => {
    const core = new TestCore();
    const send = vi.fn();
    const server: ServerTransport = {
      send,
      onMessage: () => {},
    };

    const shell = new RemoteShellProxy(core, server);
    shell.dispose();

    core.dispatchEvent(new CustomEvent("test:value-changed", { detail: "ignored" }));
    expect(send).not.toHaveBeenCalled();
  });

  it("drops inbound client messages after dispose()", () => {
    const core = new TestCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    const shell = new RemoteShellProxy(core, server);
    shell.dispose();

    // set: Core must not be mutated via a post-dispose message.
    handler!({ type: "set", name: "url", value: "/should-not-apply" });
    expect(core.url).toBe("");

    // cmd: no response must be sent, and the method must not be invoked.
    const spy = vi.spyOn(core, "abort");
    handler!({ type: "cmd", name: "abort", id: "late", args: [] });
    expect(spy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    // sync: no response must be sent either.
    handler!({ type: "sync" });
    expect(send).not.toHaveBeenCalled();
  });

  it("disposes the transport when shell is disposed", () => {
    const core = new TestCore();
    const dispose = vi.fn();
    const server: ServerTransport = {
      send: () => {},
      onMessage: () => {},
      dispose,
    };

    const shell = new RemoteShellProxy(core, server);
    shell.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("swallows async cmd resolution arriving after dispose()", async () => {
    let resolveFetch: ((value: unknown) => void) | null = null;
    class SlowCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "slow", async: true }],
      };
      slow(): Promise<unknown> {
        return new Promise((resolve) => { resolveFetch = resolve; });
      }
    }

    const core = new SlowCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    const shell = new RemoteShellProxy(core, server);

    // Kick off an in-flight command.
    handler!({ type: "cmd", name: "slow", id: "99", args: [] });
    // Dispose before the command resolves.
    shell.dispose();
    // Now resolve the Promise — the `.then` must not send anything.
    resolveFetch!("too-late");
    await flush();
    await flush();

    expect(send).not.toHaveBeenCalled();
  });

  it("dispose() is idempotent", () => {
    const core = new TestCore();
    const server: ServerTransport = {
      send: () => {},
      onMessage: () => {},
    };
    const shell = new RemoteShellProxy(core, server);
    expect(() => {
      shell.dispose();
      shell.dispose();
    }).not.toThrow();
  });

  it("auto-disposes when the server transport closes", () => {
    const core = new TestCore();
    const send = vi.fn();
    let closeHandler: (() => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: () => {},
      onClose: (handler) => { closeHandler = handler; },
    };

    new RemoteShellProxy(core, server);
    closeHandler!();

    core.dispatchEvent(new CustomEvent("test:value-changed", { detail: "ignored" }));

    expect(send).not.toHaveBeenCalled();
  });
});
