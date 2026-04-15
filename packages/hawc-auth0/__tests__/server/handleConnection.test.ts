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

  it("invokes onTokenRefresh with the refreshed UserContext on successful refresh", async () => {
    jwtVerify.mockResolvedValueOnce({
      payload: { sub: "auth0|123", permissions: ["old"], roles: ["member"] },
    });

    const socket = createMockSocket();
    const core = new EventTarget();
    (core.constructor as any).wcBindable = {
      protocol: "wc-bindable",
      version: 1,
      properties: [],
    };

    const refreshed: Array<{ core: EventTarget; sub: string; permissions: string[] }> = [];

    await handleConnection(
      socket,
      "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123" }),
      {
        auth0Domain: "test.auth0.com",
        auth0Audience: "https://api.example.com",
        createCores: () => core,
        onTokenRefresh: (c, user) => {
          refreshed.push({ core: c, sub: user.sub, permissions: user.permissions });
        },
      },
    );

    jwtVerify.mockResolvedValueOnce({
      payload: {
        sub: "auth0|123",
        permissions: ["new-perm-a", "new-perm-b"],
        roles: ["admin"],
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });

    const messageHandlers = socket._listeners["message"];
    messageHandlers[0]({
      data: JSON.stringify({
        type: "cmd",
        name: "auth:refresh",
        id: "refresh-hook",
        args: [makeJwt({ sub: "auth0|123" })],
      }),
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(refreshed).toHaveLength(1);
    expect(refreshed[0].core).toBe(core);
    expect(refreshed[0].sub).toBe("auth0|123");
    expect(refreshed[0].permissions).toEqual(["new-perm-a", "new-perm-b"]);

    const lastResponse = JSON.parse(
      socket.send.mock.calls[socket.send.mock.calls.length - 1][0],
    );
    expect(lastResponse.type).toBe("return");
    expect(lastResponse.id).toBe("refresh-hook");
  });

  it("does not fire 4401 while a slow async onTokenRefresh is in flight on a verified refresh", async () => {
    vi.useFakeTimers();
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const originalExp = nowSec + 5;
      const refreshedExp = nowSec + 3600;

      jwtVerify.mockResolvedValueOnce({ payload: { sub: "auth0|123", permissions: [] } });

      const socket = createMockSocket();
      const core = new EventTarget();
      (core.constructor as any).wcBindable = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
      };

      const events: AuthEvent[] = [];
      let releaseHook!: () => void;
      const hookGate = new Promise<void>((r) => { releaseHook = r; });

      await handleConnection(
        socket,
        "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123", exp: originalExp }),
        {
          auth0Domain: "test.auth0.com",
          auth0Audience: "https://api.example.com",
          createCores: () => core,
          onEvent: (e) => events.push(e),
          sessionGraceMs: 1_000,
          onTokenRefresh: () => hookGate, // resolves only when we release it
        },
      );

      jwtVerify.mockResolvedValueOnce({
        payload: { sub: "auth0|123", permissions: [], exp: refreshedExp },
      });

      const messageHandlers = socket._listeners["message"];
      messageHandlers[0]({
        data: JSON.stringify({
          type: "cmd",
          name: "auth:refresh",
          id: "refresh-slow-hook",
          args: [makeJwt({ sub: "auth0|123", exp: refreshedExp })],
        }),
      });

      // Let the .then chain run up to the awaited hook.
      await vi.advanceTimersByTimeAsync(0);

      // Advance well past the ORIGINAL exp + grace. If the bug returns,
      // the old timer fires 4401 mid-refresh and this assertion fails.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(socket.close).not.toHaveBeenCalledWith(4401, "Session expired");

      // Hook releases — refresh completes successfully against the new exp.
      releaseHook();
      await vi.advanceTimersByTimeAsync(0);

      const responses = socket.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
      expect(responses[responses.length - 1]).toMatchObject({ type: "return", id: "refresh-slow-hook" });
      expect(events.some((e) => e.type === "auth:refresh")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rolls the session expiry back to the previous deadline when async onTokenRefresh rejects", async () => {
    vi.useFakeTimers();
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const originalExp = nowSec + 30;
      const refreshedExp = nowSec + 3600;

      jwtVerify.mockResolvedValueOnce({ payload: { sub: "auth0|123", permissions: [] } });

      const socket = createMockSocket();
      const core = new EventTarget();
      (core.constructor as any).wcBindable = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
      };

      await handleConnection(
        socket,
        "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123", exp: originalExp }),
        {
          auth0Domain: "test.auth0.com",
          auth0Audience: "https://api.example.com",
          createCores: () => core,
          sessionGraceMs: 1_000,
          onTokenRefresh: async () => {
            await Promise.resolve();
            throw new Error("hook rejected");
          },
        },
      );

      jwtVerify.mockResolvedValueOnce({
        payload: { sub: "auth0|123", permissions: [], exp: refreshedExp },
      });

      const messageHandlers = socket._listeners["message"];
      messageHandlers[0]({
        data: JSON.stringify({
          type: "cmd",
          name: "auth:refresh",
          id: "refresh-rollback-exp",
          args: [makeJwt({ sub: "auth0|123", exp: refreshedExp })],
        }),
      });

      await vi.advanceTimersByTimeAsync(10);

      // Hook rejected → expiry rolled back to original deadline.
      // Just before original exp + grace: must not have closed yet.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(socket.close).not.toHaveBeenCalledWith(4401, "Session expired");

      // Past original exp + grace: must close (rollback honoured).
      // If the bug returns and pre-extension stayed, this would not fire
      // until refreshedExp (~3600s away).
      await vi.advanceTimersByTimeAsync(15_000);
      expect(socket.close).toHaveBeenCalledWith(4401, "Session expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not crash or double-send when rawTransport.send throws on the success path", async () => {
    // Simulates the peer disconnecting between hook resolution and
    // the success-path response send. Pre-fix this would cause the
    // throw to fall into .catch() which then sends *again* (a
    // protocol-violating duplicate response or another throw).
    jwtVerify.mockResolvedValueOnce({ payload: { sub: "auth0|123", permissions: [] } });

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

    jwtVerify.mockResolvedValueOnce({
      payload: { sub: "auth0|123", permissions: [], exp: Math.floor(Date.now() / 1000) + 300 },
    });

    // Make every send throw — peer is gone.
    socket.send = vi.fn(() => {
      throw new Error("WebSocket is not open: readyState 3 (CLOSED)");
    });

    const messageHandlers = socket._listeners["message"];

    // The handler is called synchronously; the refresh chain runs as
    // microtasks. None of it should escape as an unhandled rejection.
    let unhandled: unknown = null;
    const rejectionHandler = (err: unknown) => { unhandled = err; };
    process.on("unhandledRejection", rejectionHandler);

    try {
      messageHandlers[0]({
        data: JSON.stringify({
          type: "cmd",
          name: "auth:refresh",
          id: "refresh-send-throws",
          args: [makeJwt({ sub: "auth0|123" })],
        }),
      });

      await new Promise((r) => setTimeout(r, 20));

      expect(unhandled).toBeNull();
    } finally {
      process.off("unhandledRejection", rejectionHandler);
    }

    // The success-path send threw; the handler must NOT have fallen
    // into .catch() and emitted a second send (which would have been
    // a duplicate response for the same id).
    expect((socket.send as any).mock.calls.length).toBe(1);

    // The success-side state was committed before send was attempted,
    // so the success event still fires; the failure event must NOT.
    expect(events.some((e) => e.type === "auth:refresh")).toBe(true);
    expect(events.some((e) => e.type === "auth:refresh-failure")).toBe(false);
  });

  it("awaits async onTokenRefresh and only commits after it resolves", async () => {
    jwtVerify.mockResolvedValueOnce({ payload: { sub: "auth0|123", permissions: [] } });

    const socket = createMockSocket();
    const core = new EventTarget();
    (core.constructor as any).wcBindable = {
      protocol: "wc-bindable",
      version: 1,
      properties: [],
    };

    const events: AuthEvent[] = [];
    let releaseHook!: () => void;
    const hookGate = new Promise<void>((r) => { releaseHook = r; });
    const callOrder: string[] = [];

    await handleConnection(
      socket,
      "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123" }),
      {
        auth0Domain: "test.auth0.com",
        auth0Audience: "https://api.example.com",
        createCores: () => core,
        onEvent: (e) => {
          events.push(e);
          if (e.type === "auth:refresh") callOrder.push("refresh-event");
        },
        onTokenRefresh: async () => {
          callOrder.push("hook-start");
          await hookGate;
          callOrder.push("hook-end");
        },
      },
    );

    jwtVerify.mockResolvedValueOnce({
      payload: { sub: "auth0|123", permissions: [], exp: Math.floor(Date.now() / 1000) + 300 },
    });

    const messageHandlers = socket._listeners["message"];
    messageHandlers[0]({
      data: JSON.stringify({
        type: "cmd",
        name: "auth:refresh",
        id: "refresh-async-ok",
        args: [makeJwt({ sub: "auth0|123" })],
      }),
    });

    // Let microtasks flush so the hook starts.
    await new Promise((r) => setTimeout(r, 10));

    // Hook is in flight: server MUST NOT have responded or fired the event yet.
    expect(callOrder).toEqual(["hook-start"]);
    expect(socket.send).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === "auth:refresh")).toBeUndefined();

    releaseHook();
    await new Promise((r) => setTimeout(r, 10));

    expect(callOrder).toEqual(["hook-start", "hook-end", "refresh-event"]);
    const response = JSON.parse(socket.send.mock.calls[0][0]);
    expect(response.type).toBe("return");
    expect(response.id).toBe("refresh-async-ok");
  });

  it("rolls back the refresh when an async onTokenRefresh rejects", async () => {
    jwtVerify.mockResolvedValueOnce({ payload: { sub: "auth0|123", permissions: [] } });

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
        onTokenRefresh: async () => {
          await Promise.resolve();
          throw new Error("async hook failure");
        },
      },
    );

    jwtVerify.mockResolvedValueOnce({
      payload: { sub: "auth0|123", permissions: [], exp: Math.floor(Date.now() / 1000) + 300 },
    });

    const messageHandlers = socket._listeners["message"];
    messageHandlers[0]({
      data: JSON.stringify({
        type: "cmd",
        name: "auth:refresh",
        id: "refresh-async-err",
        args: [makeJwt({ sub: "auth0|123" })],
      }),
    });

    await new Promise((r) => setTimeout(r, 10));

    const response = JSON.parse(socket.send.mock.calls[socket.send.mock.calls.length - 1][0]);
    expect(response.type).toBe("throw");
    expect(response.id).toBe("refresh-async-err");
    expect(response.error.message).toBe("Token refresh hook failed");
    expect(events.find((e) => e.type === "auth:refresh")).toBeUndefined();
    const failure = events.find((e) => e.type === "auth:refresh-failure");
    expect(failure?.error?.message).toBe("async hook failure");
  });

  it("emits auth:refresh-failure and sends throw when onTokenRefresh throws", async () => {
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
        onTokenRefresh: () => {
          throw new Error("hook exploded");
        },
      },
    );

    jwtVerify.mockResolvedValueOnce({
      payload: { sub: "auth0|123", permissions: [], exp: Math.floor(Date.now() / 1000) + 300 },
    });

    const messageHandlers = socket._listeners["message"];
    messageHandlers[0]({
      data: JSON.stringify({
        type: "cmd",
        name: "auth:refresh",
        id: "refresh-hook-err",
        args: [makeJwt({ sub: "auth0|123" })],
      }),
    });

    await new Promise((r) => setTimeout(r, 10));

    const response = JSON.parse(
      socket.send.mock.calls[socket.send.mock.calls.length - 1][0],
    );
    expect(response.type).toBe("throw");
    expect(response.id).toBe("refresh-hook-err");
    expect(response.error.message).toBe("Token refresh hook failed");
    expect(events.find((e) => e.type === "auth:refresh")).toBeUndefined();
    expect(events.find((e) => e.type === "auth:refresh-failure")).toBeDefined();
  });

  it("wraps non-Error token refresh hook failures in auth:refresh-failure event", async () => {
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
        onTokenRefresh: () => {
          throw "hook string failure";
        },
      },
    );

    jwtVerify.mockResolvedValueOnce({
      payload: { sub: "auth0|123", permissions: [], exp: Math.floor(Date.now() / 1000) + 300 },
    });

    const messageHandlers = socket._listeners["message"];
    messageHandlers[0]({
      data: JSON.stringify({
        type: "cmd",
        name: "auth:refresh",
        id: "refresh-hook-string",
        args: [makeJwt({ sub: "auth0|123" })],
      }),
    });

    await new Promise((r) => setTimeout(r, 10));

    const failure = events.find((e) => e.type === "auth:refresh-failure");
    expect(failure?.error?.message).toBe("hook string failure");
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

  it("closes socket when refresh token subject mismatches initial subject", async () => {
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

    jwtVerify.mockResolvedValueOnce({
      payload: { sub: "auth0|999", permissions: [] },
    });

    const messageHandlers = socket._listeners["message"];
    messageHandlers[0]({
      data: JSON.stringify({
        type: "cmd",
        name: "auth:refresh",
        id: "refresh-sub-mismatch",
        args: [makeJwt({ sub: "auth0|999" })],
      }),
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(socket.close).toHaveBeenCalledWith(4403, "Token subject mismatch");
    const mismatchEvent = events.find((e) => e.type === "auth:refresh-failure");
    expect(mismatchEvent?.error?.message).toBe("Token subject mismatch");
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

  it("does not advance session expiry when onTokenRefresh throws", async () => {
    vi.useFakeTimers();
    try {
      const originalExp = Math.floor(Date.now() / 1000) + 30;
      jwtVerify.mockResolvedValueOnce({ payload: { sub: "auth0|123", permissions: [] } });

      const socket = createMockSocket();
      const core = new EventTarget();
      (core.constructor as any).wcBindable = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
      };

      await handleConnection(
        socket,
        "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123", exp: originalExp }),
        {
          auth0Domain: "test.auth0.com",
          auth0Audience: "https://api.example.com",
          createCores: () => core,
          sessionGraceMs: 1_000,
          onTokenRefresh: () => {
            throw new Error("hook exploded");
          },
        },
      );

      // New token claims a far-future exp; if the bug returns, the server
      // will accept it and never close the socket at originalExp.
      jwtVerify.mockResolvedValueOnce({
        payload: {
          sub: "auth0|123",
          permissions: [],
          exp: originalExp + 3600,
        },
      });

      const messageHandlers = socket._listeners["message"];
      messageHandlers[0]({
        data: JSON.stringify({
          type: "cmd",
          name: "auth:refresh",
          id: "refresh-hook-throw-exp",
          args: [makeJwt({ sub: "auth0|123", exp: originalExp + 3600 })],
        }),
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(socket.close).not.toHaveBeenCalledWith(4401, "Session expired");

      // Advance past the ORIGINAL exp — the session must still close,
      // because the hook-failed refresh must not extend it.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(socket.close).toHaveBeenCalledWith(4401, "Session expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not invoke the core update side-effect when hook throws after its own mutation", async () => {
    // Guard against regressions where state commit is moved back before the hook.
    jwtVerify.mockResolvedValueOnce({ payload: { sub: "auth0|123", permissions: [] } });

    const socket = createMockSocket();
    const core = new EventTarget();
    (core.constructor as any).wcBindable = {
      protocol: "wc-bindable",
      version: 1,
      properties: [],
    };

    let hookCalled = false;
    let sawRefreshEvent = false;

    const events: AuthEvent[] = [];

    await handleConnection(
      socket,
      "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123" }),
      {
        auth0Domain: "test.auth0.com",
        auth0Audience: "https://api.example.com",
        createCores: () => core,
        onEvent: (e) => {
          events.push(e);
          if (e.type === "auth:refresh") sawRefreshEvent = true;
        },
        onTokenRefresh: () => {
          hookCalled = true;
          throw new Error("hook exploded");
        },
      },
    );

    jwtVerify.mockResolvedValueOnce({
      payload: { sub: "auth0|123", permissions: [], exp: Math.floor(Date.now() / 1000) + 300 },
    });

    const messageHandlers = socket._listeners["message"];
    messageHandlers[0]({
      data: JSON.stringify({
        type: "cmd",
        name: "auth:refresh",
        id: "refresh-order",
        args: [makeJwt({ sub: "auth0|123" })],
      }),
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(hookCalled).toBe(true);
    expect(sawRefreshEvent).toBe(false);
    expect(events.some((e) => e.type === "auth:refresh-failure")).toBe(true);
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
