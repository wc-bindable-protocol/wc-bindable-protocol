import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AuthShell } from "../src/shell/AuthShell";

function createMockAuth0Client(overrides: Record<string, any> = {}) {
  return {
    isAuthenticated: vi.fn().mockResolvedValue(false),
    getUser: vi.fn().mockResolvedValue(null),
    getTokenSilently: vi.fn().mockResolvedValue("test-token"),
    loginWithRedirect: vi.fn().mockResolvedValue(undefined),
    loginWithPopup: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    handleRedirectCallback: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

vi.mock("@auth0/auth0-spa-js", () => ({
  createAuth0Client: vi.fn(),
}));

// Mock WebSocket
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  protocols: string | string[];
  readyState = MockWebSocket.OPEN;
  private _listeners: Record<string, ((...args: any[]) => void)[]> = {};
  /** Messages sent via send() — for test assertions. */
  sentMessages: string[] = [];
  /** Handler to simulate server responses after send(). */
  onSend: ((data: string) => void) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols ?? "";
    // Auto-fire "open" event on next tick
    queueMicrotask(() => this._emit("open"));
  }

  addEventListener(type: string, listener: (...args: any[]) => void, _opts?: any): void {
    (this._listeners[type] ??= []).push(listener);
  }

  removeEventListener(type: string, listener: (...args: any[]) => void): void {
    const list = this._listeners[type];
    if (list) {
      const idx = list.indexOf(listener);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  send(data: string): void {
    this.sentMessages.push(data);
    this.onSend?.(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this._emit("close");
  }

  /** Test helper: emit an event */
  _emit(type: string, ...args: any[]): void {
    for (const fn of [...(this._listeners[type] ?? [])]) fn(...args);
  }

  /** Test helper: simulate a server message */
  _receiveMessage(data: any): void {
    this._emit("message", { data: JSON.stringify(data) });
  }

  /** Test helper: simulate error */
  _simulateError(): void {
    this._emit("error");
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);

describe("AuthShell", () => {
  let createAuth0Client: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import("@auth0/auth0-spa-js");
    createAuth0Client = (mod as any).createAuth0Client;
    createAuth0Client.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extends EventTarget", () => {
    const shell = new AuthShell();
    expect(shell).toBeInstanceOf(EventTarget);
  });

  it("wcBindable has 5 properties (no token)", () => {
    expect(AuthShell.wcBindable.properties).toHaveLength(5);
    const names = AuthShell.wcBindable.properties.map((p) => p.name);
    expect(names).toEqual(["authenticated", "user", "loading", "error", "connected"]);
    expect(names).not.toContain("token");
  });

  it("initial state is correct", () => {
    const shell = new AuthShell();
    expect(shell.authenticated).toBe(false);
    expect(shell.user).toBeNull();
    expect(shell.loading).toBe(false);
    expect(shell.error).toBeNull();
    expect(shell.connected).toBe(false);
    expect(shell.client).toBeNull();
    expect(shell.token).toBeNull();
  });

  describe("initialize", () => {
    it("delegates to AuthCore with correct options", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({
        domain: "test.auth0.com",
        clientId: "client-id",
        audience: "https://api.example.com",
        scope: "openid profile",
        redirectUri: "/callback",
        cacheLocation: "localstorage",
        useRefreshTokens: true,
      });

      expect(createAuth0Client).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: "test.auth0.com",
          clientId: "client-id",
          authorizationParams: expect.objectContaining({
            audience: "https://api.example.com",
            scope: "openid profile",
            redirect_uri: "/callback",
          }),
          cacheLocation: "localstorage",
          useRefreshTokens: true,
        }),
      );
    });

    it("defaults useRefreshTokens to true", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({
        domain: "test.auth0.com",
        clientId: "client-id",
        audience: "https://api.example.com",
      });

      expect(createAuth0Client).toHaveBeenCalledWith(
        expect.objectContaining({ useRefreshTokens: true }),
      );
    });
  });

  describe("login / logout", () => {
    it("delegates login to AuthCore", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
      await shell.login();

      expect(mockClient.loginWithRedirect).toHaveBeenCalled();
    });

    it("delegates loginWithPopup to AuthCore", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
      await shell.loginWithPopup();

      expect(mockClient.loginWithPopup).toHaveBeenCalled();
    });

    it("logout closes WebSocket and sets connected=false", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
      await shell.connect("ws://localhost:3000");

      expect(shell.connected).toBe(true);

      await shell.logout();

      expect(shell.connected).toBe(false);
      expect(mockClient.logout).toHaveBeenCalled();
    });
  });

  describe("connect", () => {
    it("creates WebSocket with token in Sec-WebSocket-Protocol", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("my-jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

      const transport = await shell.connect("ws://localhost:3000");

      expect(transport).toBeDefined();
      expect(shell.connected).toBe(true);
    });

    it("throws if client is not initialized", async () => {
      const shell = new AuthShell();
      await expect(shell.connect("ws://localhost:3000")).rejects.toThrow(
        "[@wc-bindable/hawc-auth0] Auth0 client is not initialized",
      );
    });

    it("dispatches connected-changed event", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

      const events: boolean[] = [];
      shell.addEventListener("hawc-auth0:connected-changed", (e: Event) => {
        events.push((e as CustomEvent).detail);
      });

      await shell.connect("ws://localhost:3000");
      expect(events).toEqual([true]);
    });
  });

  describe("reconnect", () => {
    it("refreshes token and returns new transport", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

      await shell.connect("ws://localhost:3000");
      const newTransport = await shell.reconnect();

      expect(newTransport).toBeDefined();
      expect(shell.connected).toBe(true);
      // getTokenSilently called with cacheMode: "off" for refresh
      expect(mockClient.getTokenSilently).toHaveBeenCalledWith({ cacheMode: "off" });
    });

    it("throws if no previous URL", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

      await expect(shell.reconnect()).rejects.toThrow(
        "[@wc-bindable/hawc-auth0] No previous connection URL",
      );
    });
  });

  describe("refreshToken (in-band refresh)", () => {
    it("sends auth:refresh command over the existing WebSocket", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
      await shell.connect("ws://localhost:3000");

      // Capture the WS instance to simulate server response
      const wsInstances = (globalThis as any).WebSocket as typeof MockWebSocket;
      // The last created MockWebSocket is the one used by connect()
      // We need to get it — use onSend to intercept
      let capturedWs: MockWebSocket | null = null;

      // Re-connect to get a fresh WS we can instrument
      const origWS = globalThis.WebSocket;
      let lastWs: MockWebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          lastWs = this;
        }
      };

      // Reconnect to get instrumented WS
      await shell.reconnect();
      capturedWs = lastWs!;
      (globalThis as any).WebSocket = origWS;

      // Set up auto-respond on send
      capturedWs.onSend = (data: string) => {
        const msg = JSON.parse(data);
        if (msg.name === "auth:refresh") {
          queueMicrotask(() => {
            capturedWs!._receiveMessage({ type: "return", id: msg.id, value: undefined });
          });
        }
      };

      // Now refreshToken should succeed
      await shell.refreshToken();

      // Verify the sent message
      const sent = capturedWs.sentMessages.map((s) => JSON.parse(s));
      const refreshMsg = sent.find((m: any) => m.name === "auth:refresh");
      expect(refreshMsg).toBeDefined();
      expect(refreshMsg.type).toBe("cmd");
      expect(refreshMsg.args[0]).toBe("token"); // the refreshed token
    });

    it("rejects when server returns throw", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

      // Instrument WS
      let capturedWs: MockWebSocket;
      const origWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };
      await shell.connect("ws://localhost:3000");
      (globalThis as any).WebSocket = origWS;

      capturedWs!.onSend = (data: string) => {
        const msg = JSON.parse(data);
        if (msg.name === "auth:refresh") {
          queueMicrotask(() => {
            capturedWs._receiveMessage({
              type: "throw",
              id: msg.id,
              error: { name: "Error", message: "Token refresh failed" },
            });
          });
        }
      };

      await expect(shell.refreshToken()).rejects.toThrow("Token refresh failed");
    });

    it("throws if no active connection", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

      await expect(shell.refreshToken()).rejects.toThrow(
        "[@wc-bindable/hawc-auth0] No active connection",
      );
    });
  });

  describe("events from AuthCore bubble through AuthShell", () => {
    it("authenticated event fires on AuthShell", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("t"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      const events: boolean[] = [];
      shell.addEventListener("hawc-auth0:authenticated-changed", (e: Event) => {
        events.push((e as CustomEvent).detail);
      });

      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

      expect(events).toContain(true);
      expect(shell.authenticated).toBe(true);
    });
  });
});
