import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(),
}));

class MockWebSocketServer {
  handlers: Record<string, (...args: any[]) => void> = {};
  options: any;

  constructor(options: any) {
    this.options = options;
  }

  on(event: string, handler: (...args: any[]) => void): void {
    this.handlers[event] = handler;
  }
}

const wsServers: MockWebSocketServer[] = [];

vi.mock("ws", () => ({
  WebSocketServer: class {
    handlers: Record<string, (...args: any[]) => void> = {};
    options: any;

    constructor(options: any) {
      this.options = options;
      wsServers.push(this as unknown as MockWebSocketServer);
    }

    on(event: string, handler: (...args: any[]) => void): void {
      this.handlers[event] = handler;
    }
  },
}));

import { createAuthenticatedWSS } from "../../src/server/createAuthenticatedWSS";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

function createSocket() {
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
  };
}

describe("createAuthenticatedWSS", () => {
  let jwtVerify: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    wsServers.length = 0;
    const jose = await import("jose");
    jwtVerify = jose.jwtVerify as ReturnType<typeof vi.fn>;
    jwtVerify.mockReset();
  });

  it("accepts only hawc-auth0 bearer protocol", async () => {
    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      createCores: () => new EventTarget(),
      port: 3010,
    });

    const accepted = wss.options.handleProtocols(["foo", "hawc-auth0.bearer.token"]);
    const rejected = wss.options.handleProtocols(["foo", "bar"]);

    expect(accepted).toBe("hawc-auth0.bearer.token");
    expect(rejected).toBe(false);
  });

  it("rejects disallowed origins", async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: "auth0|123", permissions: [] } });

    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      allowedOrigins: ["https://allowed.example.com"],
      createCores: () => new EventTarget(),
    });

    const socket = createSocket();
    await wss.handlers.connection(socket, {
      headers: {
        origin: "https://blocked.example.com",
        "sec-websocket-protocol": "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123" }),
      },
    });

    expect(socket.close).toHaveBeenCalledWith(1008, "Forbidden origin");
  });

  it("closes unauthorized connection when token extraction/verification fails", async () => {
    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      createCores: () => new EventTarget(),
    });

    const socket = createSocket();
    await wss.handlers.connection(socket, {
      headers: {
        origin: "https://allowed.example.com",
        "sec-websocket-protocol": "not-hawc-protocol",
      },
    });

    expect(socket.close).toHaveBeenCalledWith(1008, "Unauthorized");
  });

  it("accepts connection for allowed origin and valid token", async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: "auth0|123", permissions: [] } });

    const core = new EventTarget();
    (core.constructor as any).wcBindable = {
      protocol: "wc-bindable",
      version: 1,
      properties: [],
    };

    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      allowedOrigins: ["https://allowed.example.com"],
      createCores: () => core,
    });

    const socket = createSocket();
    await wss.handlers.connection(socket, {
      headers: {
        origin: "https://allowed.example.com",
        "sec-websocket-protocol": "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123" }),
      },
    });

    expect(socket.close).not.toHaveBeenCalledWith(1008, "Unauthorized");
    expect(socket.close).not.toHaveBeenCalledWith(1008, "Forbidden origin");
  });
});
