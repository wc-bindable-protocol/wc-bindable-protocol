import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleConnection } from "../../src/server/createAuthenticatedWSS";
import type { AuthEvent } from "../../src/server/createAuthenticatedWSS";

// Mock jose
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(),
}));

// Create a valid-looking JWT (header.payload.signature)
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

function createMockSocket() {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};
  return {
    send: vi.fn(),
    close: vi.fn(),
    on(type: string, listener: (...args: any[]) => void) {
      (listeners[type] ??= []).push(listener);
    },
    addEventListener(type: string, listener: (...args: any[]) => void) {
      (listeners[type] ??= []).push(listener);
    },
    _emit(type: string, ...args: any[]) {
      for (const fn of listeners[type] ?? []) fn(...args);
    },
    _listeners: listeners,
  };
}

describe("handleConnection", () => {
  let jwtVerify: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const jose = await import("jose");
    jwtVerify = jose.jwtVerify as ReturnType<typeof vi.fn>;
    jwtVerify.mockReset();
  });

  it("creates RemoteShellProxy on valid token", async () => {
    jwtVerify.mockResolvedValue({
      payload: { sub: "auth0|123", email: "a@b.com", permissions: ["read"] },
    });

    const socket = createMockSocket();
    const core = new EventTarget();
    (core.constructor as any).wcBindable = {
      protocol: "wc-bindable",
      version: 1,
      properties: [],
    };

    const proxy = await handleConnection(
      socket,
      "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123" }),
      {
        auth0Domain: "test.auth0.com",
        auth0Audience: "https://api.example.com",
        createCores: () => core,
      },
    );

    expect(proxy).toBeDefined();
  });

  it("emits auth:success and connection:open events", async () => {
    jwtVerify.mockResolvedValue({
      payload: { sub: "auth0|123", permissions: [] },
    });

    const socket = createMockSocket();
    const core = new EventTarget();
    (core.constructor as any).wcBindable = {
      protocol: "wc-bindable",
      version: 1,
      properties: [],
    };

    const events: AuthEvent[] = [];

    await handleConnection(
      socket,
      "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123" }),
      {
        auth0Domain: "test.auth0.com",
        auth0Audience: "https://api.example.com",
        createCores: () => core,
        onEvent: (e) => events.push(e),
      },
    );

    expect(events.map((e) => e.type)).toEqual(["auth:success", "connection:open"]);
  });

  it("emits auth:failure on invalid token", async () => {
    jwtVerify.mockRejectedValue(new Error("Invalid signature"));

    const socket = createMockSocket();
    const events: AuthEvent[] = [];

    await expect(
      handleConnection(
        socket,
        "hawc-auth0.bearer.bad-token",
        {
          auth0Domain: "test.auth0.com",
          auth0Audience: "https://api.example.com",
          createCores: () => new EventTarget(),
          onEvent: (e) => events.push(e),
        },
      ),
    ).rejects.toThrow("Invalid signature");

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("auth:failure");
  });

  it("wraps non-Error auth failure values", async () => {
    jwtVerify.mockRejectedValue("invalid token string");

    const socket = createMockSocket();
    const events: AuthEvent[] = [];

    await expect(
      handleConnection(
        socket,
        "hawc-auth0.bearer.bad-token",
        {
          auth0Domain: "test.auth0.com",
          auth0Audience: "https://api.example.com",
          createCores: () => new EventTarget(),
          onEvent: (e) => events.push(e),
        },
      ),
    ).rejects.toBe("invalid token string");

    expect(events[0].type).toBe("auth:failure");
    expect(events[0].error).toBeInstanceOf(Error);
  });

  it("intercepts auth:refresh and re-verifies token", async () => {
    // Initial auth
    jwtVerify.mockResolvedValueOnce({
      payload: { sub: "auth0|123", permissions: [] },
    });

    const socket = createMockSocket();
    const core = new EventTarget();
    (core.constructor as any).wcBindable = {
      protocol: "wc-bindable",
      version: 1,
      properties: [],
    };

    const events: AuthEvent[] = [];

    await handleConnection(
      socket,
      "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123" }),
      {
        auth0Domain: "test.auth0.com",
        auth0Audience: "https://api.example.com",
        createCores: () => core,
        onEvent: (e) => events.push(e),
      },
    );

    // Now simulate auth:refresh command
    jwtVerify.mockResolvedValueOnce({
      payload: { sub: "auth0|123", permissions: ["new-perm"] },
    });

    // Get the message handler registered on the socket
    const messageHandlers = socket._listeners["message"];
    expect(messageHandlers).toBeDefined();
    expect(messageHandlers.length).toBeGreaterThan(0);

    // Simulate receiving auth:refresh
    const refreshMsg = JSON.stringify({
      type: "cmd",
      name: "auth:refresh",
      id: "refresh-1",
      args: [makeJwt({ sub: "auth0|123", exp: Math.floor(Date.now() / 1000) + 300 })],
    });

    // WebSocketServerTransport uses addEventListener (event.data) when available
    messageHandlers[0]({ data: refreshMsg });

    // Wait for async verification
    await new Promise((r) => setTimeout(r, 10));

    // Server should have sent a return response
    expect(socket.send).toHaveBeenCalled();
    const response = JSON.parse(socket.send.mock.calls[socket.send.mock.calls.length - 1][0]);
    expect(response.type).toBe("return");
    expect(response.id).toBe("refresh-1");

    // Event should have been emitted
    expect(events.find((e) => e.type === "auth:refresh")).toBeDefined();
  });

  it("returns throw when auth:refresh token argument is missing", async () => {
    jwtVerify.mockResolvedValue({
      payload: { sub: "auth0|123", permissions: [] },
    });

    const socket = createMockSocket();
    const core = new EventTarget();
    (core.constructor as any).wcBindable = {
      protocol: "wc-bindable",
      version: 1,
      properties: [],
    };

    await handleConnection(
      socket,
      "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123" }),
      {
        auth0Domain: "test.auth0.com",
        auth0Audience: "https://api.example.com",
        createCores: () => core,
      },
    );

    const messageHandlers = socket._listeners["message"];
    messageHandlers[0]({
      data: JSON.stringify({ type: "cmd", name: "auth:refresh", id: "missing", args: [] }),
    });

    const response = JSON.parse(socket.send.mock.calls[socket.send.mock.calls.length - 1][0]);
    expect(response.type).toBe("throw");
    expect(response.error.message).toContain("Missing token argument");
  });

  it("emits auth:refresh-failure and sends throw on refresh verification failure", async () => {
    jwtVerify.mockResolvedValueOnce({
      payload: { sub: "auth0|123", permissions: [] },
    });

    const socket = createMockSocket();
    const core = new EventTarget();
    (core.constructor as any).wcBindable = {
      protocol: "wc-bindable",
      version: 1,
      properties: [],
    };

    const events: AuthEvent[] = [];

    await handleConnection(
      socket,
      "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123" }),
      {
        auth0Domain: "test.auth0.com",
        auth0Audience: "https://api.example.com",
        createCores: () => core,
        onEvent: (e) => events.push(e),
      },
    );

    jwtVerify.mockRejectedValueOnce(new Error("refresh invalid"));
    const messageHandlers = socket._listeners["message"];
    messageHandlers[0]({
      data: JSON.stringify({
        type: "cmd",
        name: "auth:refresh",
        id: "refresh-err",
        args: [makeJwt({ sub: "auth0|123" })],
      }),
    });

    await new Promise((r) => setTimeout(r, 10));

    const response = JSON.parse(socket.send.mock.calls[socket.send.mock.calls.length - 1][0]);
    expect(response.type).toBe("throw");
    expect(response.error.message).toBe("Token refresh failed");
    expect(events.some((e) => e.type === "auth:refresh-failure")).toBe(true);
  });

  it("forwards non-refresh messages to proxy transport handler", async () => {
    jwtVerify.mockResolvedValue({
      payload: { sub: "auth0|123", permissions: [] },
    });

    const socket = createMockSocket();
    const core = new EventTarget();
    (core.constructor as any).wcBindable = {
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "foo", event: "foo-changed" }],
    };
    (core as any).foo = "bar";

    await handleConnection(
      socket,
      "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123" }),
      {
        auth0Domain: "test.auth0.com",
        auth0Audience: "https://api.example.com",
        createCores: () => core,
      },
    );

    const messageHandlers = socket._listeners["message"];
    expect(() => {
      messageHandlers[0]({
        data: JSON.stringify({ type: "sync" }),
      });
    }).not.toThrow();
  });

  it("does not schedule expiry when grace period is disabled", async () => {
    vi.useFakeTimers();
    try {
      jwtVerify.mockResolvedValue({
        payload: { sub: "auth0|123", permissions: [] },
      });

      const socket = createMockSocket();
      const core = new EventTarget();
      (core.constructor as any).wcBindable = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
      };

      await handleConnection(
        socket,
        "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123", exp: Math.floor(Date.now() / 1000) - 1 }),
        {
          auth0Domain: "test.auth0.com",
          auth0Audience: "https://api.example.com",
          createCores: () => core,
          sessionGraceMs: 0,
        },
      );

      await vi.runAllTimersAsync();
      expect(socket.close).not.toHaveBeenCalledWith(4401, "Session expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("wraps non-Error refresh failures in auth:refresh-failure event", async () => {
    jwtVerify.mockResolvedValueOnce({
      payload: { sub: "auth0|123", permissions: [] },
    });

    const socket = createMockSocket();
    const core = new EventTarget();
    (core.constructor as any).wcBindable = {
      protocol: "wc-bindable",
      version: 1,
      properties: [],
    };

    const events: AuthEvent[] = [];

    await handleConnection(
      socket,
      "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123" }),
      {
        auth0Domain: "test.auth0.com",
        auth0Audience: "https://api.example.com",
        createCores: () => core,
        onEvent: (e) => events.push(e),
      },
    );

    jwtVerify.mockRejectedValueOnce("refresh failed string");
    const messageHandlers = socket._listeners["message"];
    messageHandlers[0]({
      data: JSON.stringify({
        type: "cmd",
        name: "auth:refresh",
        id: "refresh-err-str",
        args: [makeJwt({ sub: "auth0|123" })],
      }),
    });

    await new Promise((r) => setTimeout(r, 10));

    const event = events.find((e) => e.type === "auth:refresh-failure");
    expect(event?.error).toBeInstanceOf(Error);
  });

  it("closes socket when session expires", async () => {
    vi.useFakeTimers();
    try {
      jwtVerify.mockResolvedValue({
        payload: { sub: "auth0|123", permissions: [] },
      });

      const socket = createMockSocket();
      const core = new EventTarget();
      (core.constructor as any).wcBindable = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
      };

      const expired = Math.floor(Date.now() / 1000) - 1;
      await handleConnection(
        socket,
        "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123", exp: expired }),
        {
          auth0Domain: "test.auth0.com",
          auth0Audience: "https://api.example.com",
          createCores: () => core,
          sessionGraceMs: 1,
        },
      );

      await vi.runAllTimersAsync();
      expect(socket.close).toHaveBeenCalledWith(4401, "Session expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits connection:close when proxy is disposed", async () => {
    jwtVerify.mockResolvedValue({
      payload: { sub: "auth0|123", permissions: [] },
    });

    const socket = createMockSocket();
    const core = new EventTarget();
    (core.constructor as any).wcBindable = {
      protocol: "wc-bindable",
      version: 1,
      properties: [],
    };

    const events: AuthEvent[] = [];

    const proxy = await handleConnection(
      socket,
      "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123" }),
      {
        auth0Domain: "test.auth0.com",
        auth0Audience: "https://api.example.com",
        createCores: () => core,
        onEvent: (e) => events.push(e),
      },
    );

    (proxy as any).dispose?.();
    expect(events.some((e) => e.type === "connection:close")).toBe(true);
  });

  it("clears previous expiry timer when refresh updates exp", async () => {
    vi.useFakeTimers();
    try {
      jwtVerify.mockResolvedValueOnce({ payload: { sub: "auth0|123", permissions: [] } });
      jwtVerify.mockResolvedValueOnce({ payload: { sub: "auth0|123", permissions: [] } });

      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      const socket = createMockSocket();
      const core = new EventTarget();
      (core.constructor as any).wcBindable = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
      };

      await handleConnection(
        socket,
        "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123", exp: Math.floor(Date.now() / 1000) + 60 }),
        {
          auth0Domain: "test.auth0.com",
          auth0Audience: "https://api.example.com",
          createCores: () => core,
          sessionGraceMs: 10_000,
        },
      );

      const messageHandlers = socket._listeners["message"];
      messageHandlers[0]({
        data: JSON.stringify({
          type: "cmd",
          name: "auth:refresh",
          id: "refresh-timer",
          args: [makeJwt({ sub: "auth0|123", exp: Math.floor(Date.now() / 1000) + 120 })],
        }),
      });

      await vi.runAllTimersAsync();
      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears active expiry timer on dispose", async () => {
    vi.useFakeTimers();
    try {
      jwtVerify.mockResolvedValue({ payload: { sub: "auth0|123", permissions: [] } });

      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      const socket = createMockSocket();
      const core = new EventTarget();
      (core.constructor as any).wcBindable = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
      };

      const proxy = await handleConnection(
        socket,
        "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123", exp: Math.floor(Date.now() / 1000) + 60 }),
        {
          auth0Domain: "test.auth0.com",
          auth0Audience: "https://api.example.com",
          createCores: () => core,
        },
      );

      (proxy as any).dispose?.();
      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
