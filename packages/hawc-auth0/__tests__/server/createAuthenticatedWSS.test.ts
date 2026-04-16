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

import { _normalizeError, createAuthenticatedWSS } from "../../src/server/createAuthenticatedWSS";

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

  it("_normalizeError returns the original Error instance", () => {
    const err = new Error("boom");
    expect(_normalizeError(err)).toBe(err);
  });

  it("_normalizeError wraps non-Error throwables", () => {
    const err = _normalizeError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("boom");
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

  it("rejects unauthorized tokens in verifyClient before upgrade", async () => {
    jwtVerify.mockRejectedValue(new Error("Invalid signature"));

    const events: Array<{ type: string; error?: Error }> = [];
    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      createCores: () => new EventTarget(),
      onEvent: (event) => events.push(event),
    });

    const req = {
      headers: {
        origin: "https://allowed.example.com",
        "sec-websocket-protocol": "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123", exp: Math.floor(Date.now() / 1000) + 300 }),
      },
    };

    const verdict = await new Promise<{ allowed: boolean; code?: number; message?: string }>((resolve) => {
      wss.options.verifyClient(
        { origin: "https://allowed.example.com", secure: true, req },
        (allowed: boolean, code?: number, message?: string) => resolve({ allowed, code, message }),
      );
    });

    expect(verdict).toEqual({ allowed: false, code: 401, message: "Unauthorized" });
    expect(jwtVerify).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("auth:failure");
  });

  it("normalizes non-Error verifyClient verification failures", async () => {
    jwtVerify.mockRejectedValue("boom");

    const events: Array<{ type: string; error?: Error }> = [];
    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      createCores: () => new EventTarget(),
      onEvent: (event) => events.push(event),
    });

    const req = {
      headers: {
        origin: "https://allowed.example.com",
        "sec-websocket-protocol": "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123", exp: Math.floor(Date.now() / 1000) + 300 }),
      },
    };

    const verdict = await new Promise<{ allowed: boolean; code?: number; message?: string }>((resolve) => {
      wss.options.verifyClient(
        { origin: "https://allowed.example.com", secure: true, req },
        (allowed: boolean, code?: number, message?: string) => resolve({ allowed, code, message }),
      );
    });

    expect(verdict).toEqual({ allowed: false, code: 401, message: "Unauthorized" });
    expect(events[0]?.type).toBe("auth:failure");
    expect(events[0]?.error).toBeInstanceOf(Error);
    expect(events[0]?.error?.message).toContain("boom");
  });

  it("rejects malformed protocol headers in verifyClient before upgrade", async () => {
    const events: Array<{ type: string; error?: Error }> = [];
    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      createCores: () => new EventTarget(),
      onEvent: (event) => events.push(event),
    });

    const verdict = await new Promise<{ allowed: boolean; code?: number; message?: string }>((resolve) => {
      wss.options.verifyClient(
        {
          origin: "https://allowed.example.com",
          secure: true,
          req: { headers: { origin: "https://allowed.example.com", "sec-websocket-protocol": "not-hawc-protocol" } },
        },
        (allowed: boolean, code?: number, message?: string) => resolve({ allowed, code, message }),
      );
    });

    expect(verdict).toEqual({ allowed: false, code: 401, message: "Unauthorized" });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("auth:failure");
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it("normalizes non-Error protocol extraction failures in verifyClient before upgrade", async () => {
    const events: Array<{ type: string; error?: Error }> = [];
    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      createCores: () => new EventTarget(),
      onEvent: (event) => events.push(event),
    });

    const protocolHeader = {
      split() {
        throw "boom";
      },
    };

    const verdict = await new Promise<{ allowed: boolean; code?: number; message?: string }>((resolve) => {
      wss.options.verifyClient(
        {
          origin: "https://allowed.example.com",
          secure: true,
          req: { headers: { origin: "https://allowed.example.com", "sec-websocket-protocol": protocolHeader } },
        },
        (allowed: boolean, code?: number, message?: string) => resolve({ allowed, code, message }),
      );
    });

    expect(verdict).toEqual({ allowed: false, code: 401, message: "Unauthorized" });
    expect(events[0]?.type).toBe("auth:failure");
    expect(events[0]?.error).toBeInstanceOf(Error);
    expect(events[0]?.error?.message).toContain("boom");
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it("rejects missing origins in verifyClient before upgrade", async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: "auth0|123", permissions: [] } });

    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      allowedOrigins: ["https://allowed.example.com"],
      createCores: () => new EventTarget(),
    });

    const verdict = await new Promise<{ allowed: boolean; code?: number; message?: string }>((resolve) => {
      wss.options.verifyClient(
        {
          origin: "",
          secure: true,
          req: { headers: { "sec-websocket-protocol": "hawc-auth0.bearer." + makeJwt({ sub: "auth0|123" }) } },
        },
        (allowed: boolean, code?: number, message?: string) => resolve({ allowed, code, message }),
      );
    });

    expect(verdict).toEqual({ allowed: false, code: 403, message: "Forbidden origin" });
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it("reuses the verifyClient user on connection instead of re-verifying after upgrade", async () => {
    jwtVerify.mockResolvedValue({
      payload: {
        sub: "auth0|123",
        permissions: [],
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });

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

    const req = {
      headers: {
        origin: "https://allowed.example.com",
        "sec-websocket-protocol": "hawc-auth0.bearer." + makeJwt({
          sub: "auth0|123",
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      },
    };

    const verdict = await new Promise<{ allowed: boolean; code?: number; message?: string }>((resolve) => {
      wss.options.verifyClient(
        { origin: "https://allowed.example.com", secure: true, req },
        (allowed: boolean, code?: number, message?: string) => resolve({ allowed, code, message }),
      );
    });

    expect(verdict).toEqual({ allowed: true, code: undefined, message: undefined });

    const socket = createSocket();
    await wss.handlers.connection(socket, req);

    expect(jwtVerify).toHaveBeenCalledTimes(1);
    expect(socket.close).not.toHaveBeenCalledWith(1008, "Unauthorized");
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
