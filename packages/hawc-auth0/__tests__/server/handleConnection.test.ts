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
});
