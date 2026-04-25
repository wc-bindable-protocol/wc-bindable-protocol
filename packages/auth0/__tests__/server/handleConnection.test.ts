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
      "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
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
      // Include `exp` so we don't also emit `auth:exp-parse-failure` and
      // perturb this strict event-sequence assertion.
      "auth0-gate.bearer." + makeJwt({
        sub: "auth0|123",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
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
        "auth0-gate.bearer.bad-token",
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
        "auth0-gate.bearer.bad-token",
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
      "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
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
      "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
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
        "auth0-gate.bearer." + makeJwt({ sub: "auth0|123", exp: originalExp }),
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
        "auth0-gate.bearer." + makeJwt({ sub: "auth0|123", exp: originalExp }),
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
      "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
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
      "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
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
      "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
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
      "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
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
      "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
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
      "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
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
      "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
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
      "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
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

  it("sends structured throw response with 'Token subject mismatch' before closing", async () => {
    // Regression guard: before this fix the server only called
    // socket.close(4403, ...) on sub mismatch, so the client's
    // refreshToken() promise rejected with the generic close-handler
    // message "WebSocket closed before token refresh completed" and
    // the application could not tell sub-mismatch from a network drop.
    // We now send a `throw` response with the id of the refresh cmd
    // FIRST, so the client's response interceptor surfaces the precise
    // reason before the close path fires.
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

    await handleConnection(
      socket,
      "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
      {
        auth0Domain: "test.auth0.com",
        auth0Audience: "https://api.example.com",
        createCores: () => core,
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
        id: "refresh-sub-mismatch-structured",
        args: [makeJwt({ sub: "auth0|999" })],
      }),
    });

    await new Promise((r) => setTimeout(r, 10));

    // Find the throw response carrying our request id.
    const throwCall = socket.send.mock.calls
      .map((c: any[]) => JSON.parse(c[0]))
      .find((m: any) => m.type === "throw" && m.id === "refresh-sub-mismatch-structured");

    expect(throwCall).toBeDefined();
    expect(throwCall.error.name).toBe("Error");
    expect(throwCall.error.message).toBe("Token subject mismatch");

    // The structured reply is sent BEFORE the close; both still happen.
    expect(socket.close).toHaveBeenCalledWith(4403, "Token subject mismatch");
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
      "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
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
        "auth0-gate.bearer." + makeJwt({ sub: "auth0|123", exp: Math.floor(Date.now() / 1000) - 1 }),
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
      "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
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

  it("decodes JWT exp from a payload containing non-ASCII claims without mojibake", async () => {
    // Regression: _base64UrlDecode used to return a binary string from
    // atob / Buffer.toString("binary"), which silently corrupts
    // non-ASCII payloads and can make JSON.parse throw — at which
    // point session expiry enforcement would silently drop to
    // Infinity. Verify we still extract `exp` from a payload whose
    // other claims carry Japanese text.
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

      const events: AuthEvent[] = [];

      await handleConnection(
        socket,
        "auth0-gate.bearer." + makeJwt({
          sub: "auth0|123",
          name: "山田 太郎",
          email: "太郎@例.jp",
          exp: Math.floor(Date.now() / 1000) - 1,
        }),
        {
          auth0Domain: "test.auth0.com",
          auth0Audience: "https://api.example.com",
          createCores: () => core,
          sessionGraceMs: 1,
          onEvent: (e) => events.push(e),
        },
      );

      await vi.runAllTimersAsync();

      // exp was decodable despite non-ASCII claims — 4401 fires.
      expect(socket.close).toHaveBeenCalledWith(4401, "Session expired");
      expect(events.some((e) => e.type === "auth:exp-parse-failure")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("decodes JWT exp via atob (runtime-agnostic) and enforces expiry", async () => {
    // Simulate a non-Node runtime where `Buffer` is not defined. The
    // implementation must fall through to `atob` (globally available on
    // browsers, Deno, Bun, Workers, Node 16+) and still extract `exp`,
    // otherwise session expiry enforcement is silently disabled.
    const originalBuffer = (globalThis as any).Buffer;
    const jwt = "auth0-gate.bearer." + makeJwt({
      sub: "auth0|123",
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    (globalThis as any).Buffer = undefined;

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

      const events: AuthEvent[] = [];

      await handleConnection(
        socket,
        jwt,
        {
          auth0Domain: "test.auth0.com",
          auth0Audience: "https://api.example.com",
          createCores: () => core,
          sessionGraceMs: 1,
          onEvent: (e) => events.push(e),
        },
      );

      await vi.runAllTimersAsync();

      // exp was decodable → 4401 fires, expiry enforcement is alive.
      expect(socket.close).toHaveBeenCalledWith(4401, "Session expired");
      // And no parse-failure event was emitted on the happy path.
      expect(events.some((e) => e.type === "auth:exp-parse-failure")).toBe(false);
    } finally {
      vi.useRealTimers();
      (globalThis as any).Buffer = originalBuffer;
    }
  });
  it("decodes JWT exp via Buffer fallback when atob is unavailable", async () => {
    const savedAtob = globalThis.atob;
    vi.stubGlobal("atob", undefined);
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
        "auth0-gate.bearer." + makeJwt({
          sub: "auth0|123",
          exp: Math.floor(Date.now() / 1000) - 1,
        }),
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
      vi.stubGlobal("atob", savedAtob);
    }
  });

  it("emits auth:exp-parse-failure when the JWT payload has no exp claim", async () => {
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
      // JWT without exp claim — initial parse still succeeds but returns Infinity.
      "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
      {
        auth0Domain: "test.auth0.com",
        auth0Audience: "https://api.example.com",
        createCores: () => core,
        sessionGraceMs: 1_000,
        onEvent: (e) => events.push(e),
      },
    );

    const parseFailure = events.find((e) => e.type === "auth:exp-parse-failure");
    expect(parseFailure).toBeDefined();
    expect(parseFailure?.error).toBeInstanceOf(Error);
    expect(parseFailure?.error?.message).toMatch(/exp/);
  });

  it("emits auth:exp-parse-failure when the JWT payload cannot be decoded", async () => {
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
      // Malformed token: no payload segment.
      "auth0-gate.bearer.onlyonepart",
      {
        auth0Domain: "test.auth0.com",
        auth0Audience: "https://api.example.com",
        createCores: () => core,
        sessionGraceMs: 1_000,
        onEvent: (e) => events.push(e),
      },
    );

    const parseFailure = events.find((e) => e.type === "auth:exp-parse-failure");
    expect(parseFailure).toBeDefined();
    expect(parseFailure?.error).toBeInstanceOf(Error);
  });

  it("normalizes non-Error exp parse failures to Error instances", async () => {
    const originalBuffer = (globalThis as any).Buffer;
    const originalAtob = globalThis.atob;
    (globalThis as any).Buffer = undefined;
    vi.stubGlobal("atob", () => {
      throw "boom";
    });

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

      const events: AuthEvent[] = [];

      await handleConnection(
        socket,
        "auth0-gate.bearer.header.payload.sig",
        {
          auth0Domain: "test.auth0.com",
          auth0Audience: "https://api.example.com",
          createCores: () => core,
          onEvent: (e) => events.push(e),
        },
      );

      const parseFailure = events.find((e) => e.type === "auth:exp-parse-failure");
      expect(parseFailure?.error).toBeInstanceOf(Error);
      expect(parseFailure?.error.message).toContain("boom");
    } finally {
      (globalThis as any).Buffer = originalBuffer;
      vi.stubGlobal("atob", originalAtob);
    }
  });

  describe("expParseFailurePolicy: 'close'", () => {
    it("rejects the initial handshake when exp is missing", async () => {
      jwtVerify.mockResolvedValue({
        payload: { sub: "auth0|123", permissions: [] },
      });

      const socket = createMockSocket();
      const createCores = vi.fn(() => {
        const core = new EventTarget();
        (core.constructor as any).wcBindable = {
          protocol: "wc-bindable",
          version: 1,
          properties: [],
        };
        return core;
      });
      const events: AuthEvent[] = [];

      await expect(
        handleConnection(
          socket,
          // Token has no exp claim.
          "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
          {
            auth0Domain: "test.auth0.com",
            auth0Audience: "https://api.example.com",
            createCores,
            sessionGraceMs: 1_000,
            expParseFailurePolicy: "close",
            onEvent: (e) => events.push(e),
          },
        ),
      ).rejects.toThrow(/'close' policy/);

      // Parse failure event fires.
      expect(events.find((e) => e.type === "auth:exp-parse-failure")).toBeDefined();
      // Followed by auth:failure so the outer wrapper knows to close 1008.
      expect(events.find((e) => e.type === "auth:failure")).toBeDefined();
      // Handshake was rejected BEFORE commit: createCores must not run,
      // and auth:success / connection:open must NOT be emitted.
      expect(createCores).not.toHaveBeenCalled();
      expect(events.some((e) => e.type === "auth:success")).toBe(false);
      expect(events.some((e) => e.type === "connection:open")).toBe(false);
    });

    it("rejects the initial handshake when the JWT payload is malformed", async () => {
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

      await expect(
        handleConnection(
          socket,
          "auth0-gate.bearer.onlyonepart",
          {
            auth0Domain: "test.auth0.com",
            auth0Audience: "https://api.example.com",
            createCores: () => core,
            sessionGraceMs: 1_000,
            expParseFailurePolicy: "close",
          },
        ),
      ).rejects.toThrow(/'close' policy/);
    });

    it("allows the initial handshake when exp parses successfully", async () => {
      // Happy path under strict policy: valid exp should not trigger rejection.
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
        "auth0-gate.bearer." + makeJwt({
          sub: "auth0|123",
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
        {
          auth0Domain: "test.auth0.com",
          auth0Audience: "https://api.example.com",
          createCores: () => core,
          sessionGraceMs: 1_000,
          expParseFailurePolicy: "close",
          onEvent: (e) => events.push(e),
        },
      );

      expect(events.find((e) => e.type === "auth:success")).toBeDefined();
      expect(events.find((e) => e.type === "connection:open")).toBeDefined();
      expect(events.some((e) => e.type === "auth:exp-parse-failure")).toBe(false);
      expect(events.some((e) => e.type === "auth:failure")).toBe(false);
    });

    it("rejects auth:refresh when the new token's exp is unparseable, keeps old deadline", async () => {
      vi.useFakeTimers();
      try {
        const originalExp = Math.floor(Date.now() / 1000) + 30;
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
          "auth0-gate.bearer." + makeJwt({
            sub: "auth0|123",
            exp: originalExp,
          }),
          {
            auth0Domain: "test.auth0.com",
            auth0Audience: "https://api.example.com",
            createCores: () => core,
            sessionGraceMs: 1_000,
            expParseFailurePolicy: "close",
            onEvent: (e) => events.push(e),
          },
        );

        // Second verify: refresh path, no exp claim.
        jwtVerify.mockResolvedValueOnce({
          payload: { sub: "auth0|123", permissions: [] },
        });

        // Simulate the refresh cmd via the WebSocketServerTransport's
        // message handler (same pattern as the happy-path refresh test).
        const refreshMsg = JSON.stringify({
          type: "cmd",
          name: "auth:refresh",
          id: "r-1",
          args: [makeJwt({ sub: "auth0|123" /* no exp */ })],
        });
        const messageHandlers = socket._listeners["message"];
        expect(messageHandlers?.length).toBeGreaterThan(0);
        messageHandlers[0]({ data: refreshMsg });

        // Let the refresh chain resolve.
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);

        // Refresh was rejected.
        expect(events.find((e) => e.type === "auth:refresh-failure")).toBeDefined();
        expect(events.some((e) => e.type === "auth:refresh")).toBe(false);

        // Client got a `throw` frame, not `return`.
        const sent = socket.send.mock.calls
          .map((call: any[]) => {
            try { return JSON.parse(call[0]); } catch { return null; }
          })
          .filter(Boolean);
        const refreshResp = sent.find((m: any) => m.id === "r-1");
        expect(refreshResp).toMatchObject({ type: "throw", id: "r-1" });

        // Old deadline still fires 4401 when it arrives — refresh did
        // not extend the session.
        await vi.advanceTimersByTimeAsync(35_000);
        expect(socket.close).toHaveBeenCalledWith(4401, "Session expired");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("default 'allow' policy continues the handshake on exp parse failure", async () => {
    // Regression: without expParseFailurePolicy set, parse failure must
    // still fall through to Infinity and let the connection live (the
    // pre-existing observable-error behaviour).
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
      // No exp claim.
      "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
      {
        auth0Domain: "test.auth0.com",
        auth0Audience: "https://api.example.com",
        createCores: () => core,
        sessionGraceMs: 1_000,
        onEvent: (e) => events.push(e),
      },
    );

    expect(proxy).toBeDefined();
    expect(events.find((e) => e.type === "auth:exp-parse-failure")).toBeDefined();
    expect(events.find((e) => e.type === "auth:success")).toBeDefined();
    expect(events.find((e) => e.type === "connection:open")).toBeDefined();
    expect(events.some((e) => e.type === "auth:failure")).toBe(false);
  });

  it("'allow' policy: refresh with unparseable exp clears the old timer (connection runs unbounded)", async () => {
    // Regression: scheduleExpiryCheck() used to early-return on
    // sessionExpiresAt === Infinity WITHOUT clearing the previously
    // scheduled timer, so an allow-policy refresh whose new exp was
    // unparseable would still fire 4401 at the OLD deadline — the
    // exact opposite of what the JSDoc promised ("enforcement is
    // effectively disabled"). Lock down the fix: under allow policy,
    // after a parse-failing refresh, the old timer must be cleared
    // and no 4401 may fire at the original deadline.
    vi.useFakeTimers();
    try {
      const originalExp = Math.floor(Date.now() / 1000) + 5;
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
        "auth0-gate.bearer." + makeJwt({
          sub: "auth0|123",
          exp: originalExp,
        }),
        {
          auth0Domain: "test.auth0.com",
          auth0Audience: "https://api.example.com",
          createCores: () => core,
          sessionGraceMs: 1_000,
          // expParseFailurePolicy defaults to "allow".
          onEvent: (e) => events.push(e),
        },
      );

      // Second verify: refresh with a token that has no exp claim.
      jwtVerify.mockResolvedValueOnce({
        payload: { sub: "auth0|123", permissions: [] },
      });

      const refreshMsg = JSON.stringify({
        type: "cmd",
        name: "auth:refresh",
        id: "r-allow-1",
        args: [makeJwt({ sub: "auth0|123" /* no exp */ })],
      });
      const messageHandlers = socket._listeners["message"];
      expect(messageHandlers?.length).toBeGreaterThan(0);
      messageHandlers[0]({ data: refreshMsg });

      // Let the refresh chain resolve.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      // Allow policy: refresh succeeds as a `return` frame even
      // though exp was unparseable (only the event flags it).
      expect(events.some((e) => e.type === "auth:exp-parse-failure")).toBe(true);
      expect(events.some((e) => e.type === "auth:refresh")).toBe(true);
      expect(events.some((e) => e.type === "auth:refresh-failure")).toBe(false);

      // Advance past the original deadline + grace. No 4401 must fire —
      // allow-policy's "enforcement disabled after parse failure"
      // contract requires the old timer to have been cleared.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(socket.close).not.toHaveBeenCalledWith(4401, "Session expired");
    } finally {
      vi.useRealTimers();
    }
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
        "auth0-gate.bearer." + makeJwt({ sub: "auth0|123", exp: expired }),
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
      "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
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
        "auth0-gate.bearer." + makeJwt({ sub: "auth0|123", exp: originalExp }),
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
      "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
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
        "auth0-gate.bearer." + makeJwt({ sub: "auth0|123", exp: Math.floor(Date.now() / 1000) + 60 }),
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
        "auth0-gate.bearer." + makeJwt({ sub: "auth0|123", exp: Math.floor(Date.now() / 1000) + 60 }),
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

  describe("rolesClaim propagation", () => {
    // End-to-end: rolesClaim must flow through BOTH the initial
    // verifyAuth0Token call AND the auth:refresh re-verification call.
    // If either wiring breaks, tenants using Auth0's default RBAC flow
    // silently lose roles and every `roles.includes(...)` fails closed.
    // Unit-testing `verifyAuth0Token` in isolation is not enough — it
    // cannot catch a missed option hand-off in `handleConnection`.
    const NS = "https://api.example.com/roles";

    it("reads namespaced roles on initial verification", async () => {
      jwtVerify.mockResolvedValue({
        payload: {
          sub: "auth0|rc-initial",
          permissions: [],
          [NS]: ["editor", "admin"],
          roles: ["ignored-non-namespaced"],
        },
      });

      const socket = createMockSocket();
      const core = new EventTarget();
      (core.constructor as any).wcBindable = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
      };

      const createCores = vi.fn((user) => {
        // Assert the factory receives the namespaced roles — this is
        // the observable surface for the user's Core construction.
        expect(user.roles).toEqual(["editor", "admin"]);
        return core;
      });

      await handleConnection(
        socket,
        "auth0-gate.bearer." + makeJwt({ sub: "auth0|rc-initial" }),
        {
          auth0Domain: "test.auth0.com",
          auth0Audience: "https://api.example.com",
          rolesClaim: NS,
          createCores,
        },
      );

      expect(createCores).toHaveBeenCalledTimes(1);
    });

    it("reads namespaced roles on auth:refresh re-verification", async () => {
      // Initial verify: legacy-shaped token without the namespaced key.
      jwtVerify.mockResolvedValueOnce({
        payload: { sub: "auth0|rc-refresh", permissions: [] },
      });

      const socket = createMockSocket();
      const core = new EventTarget();
      (core.constructor as any).wcBindable = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
      };

      const refreshed: Array<{ roles: string[] }> = [];

      await handleConnection(
        socket,
        "auth0-gate.bearer." + makeJwt({ sub: "auth0|rc-refresh" }),
        {
          auth0Domain: "test.auth0.com",
          auth0Audience: "https://api.example.com",
          rolesClaim: NS,
          createCores: () => core,
          onTokenRefresh: (_c, user) => {
            refreshed.push({ roles: user.roles });
          },
        },
      );

      // Refresh verify: namespaced key present, non-namespaced must lose.
      // The only way `user.roles` lands as the namespaced value here is
      // if `rolesClaim` was forwarded into the refresh-path
      // `verifyAuth0Token` call — a regression that drops it would
      // leave `user.roles === ["ignored-non-namespaced"]` instead.
      jwtVerify.mockResolvedValueOnce({
        payload: {
          sub: "auth0|rc-refresh",
          permissions: [],
          [NS]: ["editor", "admin"],
          roles: ["ignored-non-namespaced"],
          exp: Math.floor(Date.now() / 1000) + 300,
        },
      });

      const messageHandlers = socket._listeners["message"];
      messageHandlers[0]({
        data: JSON.stringify({
          type: "cmd",
          name: "auth:refresh",
          id: "refresh-roles-claim",
          args: [makeJwt({ sub: "auth0|rc-refresh" })],
        }),
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(refreshed).toHaveLength(1);
      expect(refreshed[0].roles).toEqual(["editor", "admin"]);
    });
  });
});
