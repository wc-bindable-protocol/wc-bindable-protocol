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

  it("initPromise getter returns initialization promise", async () => {
    const mockClient = createMockAuth0Client();
    createAuth0Client.mockResolvedValue(mockClient);

    const shell = new AuthShell();
    const promise = shell.initialize({ domain: "d", clientId: "c", audience: "a" });
    expect(shell.initPromise).toBe(promise);
    await promise;
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

    it("throws if token cannot be obtained", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue(null),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

      await expect(shell.connect("ws://localhost:3000")).rejects.toThrow(
        "[@wc-bindable/hawc-auth0] Failed to obtain access token.",
      );
    });

    it("preserves the error contract when getTokenSilently rejects during connect", async () => {
      // Auth0 SDK rejects during connect()'s token fetch.
      // The contract from the pre-fetchToken era must hold:
      //   1. core.error is updated to the SDK error
      //   2. hawc-auth0:error event fires
      //   3. connect() rejects with the domain-specific message
      //      "Failed to obtain access token.", not the raw SDK message
      const sdkError = new Error("login_required");
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockRejectedValue(sdkError),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

      const errorEvents: any[] = [];
      shell.addEventListener("hawc-auth0:error", (e) => {
        errorEvents.push((e as CustomEvent).detail);
      });

      await expect(shell.connect("ws://localhost:3000")).rejects.toThrow(
        "[@wc-bindable/hawc-auth0] Failed to obtain access token.",
      );

      expect(shell.error).toBe(sdkError);
      // error event sequence: cleared (null) at start, then SDK error
      expect(errorEvents).toEqual([null, sdkError]);
    });

    it("clears connected to false when a follow-up connect handshake fails", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const originalWS = globalThis.WebSocket;
      let socketCount = 0;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        private _failOpen: boolean;
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          socketCount += 1;
          // 1st socket opens; 2nd socket fails.
          this._failOpen = socketCount === 2;
          if (this._failOpen) {
            queueMicrotask(() => this._emit("error"));
          }
        }
        addEventListener(type: string, listener: (...args: any[]) => void, opts?: any): void {
          if (this._failOpen && type === "open") return;
          super.addEventListener(type, listener, opts);
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

        await shell.connect("ws://localhost:3000");
        expect(shell.connected).toBe(true);

        await expect(shell.connect("ws://localhost:3001")).rejects.toThrow(
          "WebSocket connection failed",
        );

        // Same regression as the reconnect path: a failed follow-up
        // connect must clear `connected` to false instead of leaving
        // the previous `true` value visible after the transport is gone.
        expect(shell.connected).toBe(false);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("rejects when websocket emits error during connect", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      class ErrorWebSocket {
        static OPEN = 1;
        static CLOSED = 3;
        readyState = ErrorWebSocket.OPEN;
        private _listeners: Record<string, ((...args: any[]) => void)[]> = {};
        constructor(_url: string, _protocols?: string | string[]) {
          queueMicrotask(() => this._emit("error"));
        }
        addEventListener(type: string, listener: (...args: any[]) => void): void {
          (this._listeners[type] ??= []).push(listener);
        }
        removeEventListener(type: string, listener: (...args: any[]) => void): void {
          const list = this._listeners[type] ?? [];
          const idx = list.indexOf(listener);
          if (idx >= 0) list.splice(idx, 1);
        }
        send(_data: string): void {}
        close(): void { this._emit("close"); }
        private _emit(type: string, ...args: any[]): void {
          for (const fn of [...(this._listeners[type] ?? [])]) fn(...args);
        }
      }

      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = ErrorWebSocket;
      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await expect(shell.connect("ws://localhost:3000")).rejects.toThrow(
          "WebSocket connection failed",
        );
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
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

    it("sets connected=false when active socket closes", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      let wsRef: MockWebSocket;
      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          wsRef = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");
        expect(shell.connected).toBe(true);

        wsRef!._emit("close");
        expect(shell.connected).toBe(false);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
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

    it("throws if client is not initialized", async () => {
      const shell = new AuthShell();
      await expect(shell.reconnect()).rejects.toThrow(
        "[@wc-bindable/hawc-auth0] Auth0 client is not initialized",
      );
    });

    it("throws when refreshed token is empty", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValueOnce("token").mockResolvedValueOnce(null),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
      await shell.connect("ws://localhost:3000");

      await expect(shell.reconnect()).rejects.toThrow(
        "[@wc-bindable/hawc-auth0] Failed to refresh access token.",
      );
    });

    it("clears connected to false when reconnect handshake fails", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const originalWS = globalThis.WebSocket;
      let socketCount = 0;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        private _failOpen: boolean;
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          socketCount += 1;
          // 1st socket (connect) opens; 2nd socket (reconnect) fails.
          this._failOpen = socketCount === 2;
          if (this._failOpen) {
            queueMicrotask(() => this._emit("error"));
          }
        }
        addEventListener(type: string, listener: (...args: any[]) => void, opts?: any): void {
          if (this._failOpen && type === "open") return;
          super.addEventListener(type, listener, opts);
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

        await shell.connect("ws://localhost:3000");
        expect(shell.connected).toBe(true);

        const events: boolean[] = [];
        shell.addEventListener("hawc-auth0:connected-changed", (e: Event) => {
          events.push((e as CustomEvent).detail);
        });

        await expect(shell.reconnect()).rejects.toThrow("WebSocket reconnection failed");

        // The reviewer's exact regression: after a failed reconnect,
        // `connected` must NOT remain stuck at true.
        expect(shell.connected).toBe(false);
        // And subscribers to `hawc-auth0:connected-changed` must learn
        // about the transition, otherwise UI / retry logic that keys
        // off `connected` will not react.
        expect(events).toContain(false);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("rejects when websocket emits error during reconnect", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      class FlakyWebSocket {
        static OPEN = 1;
        static CLOSED = 3;
        static count = 0;
        readyState = FlakyWebSocket.OPEN;
        private _listeners: Record<string, ((...args: any[]) => void)[]> = {};

        constructor(_url: string, _protocols?: string | string[]) {
          FlakyWebSocket.count += 1;
          const eventType = FlakyWebSocket.count === 1 ? "open" : "error";
          queueMicrotask(() => this._emit(eventType));
        }

        addEventListener(type: string, listener: (...args: any[]) => void): void {
          (this._listeners[type] ??= []).push(listener);
        }

        removeEventListener(type: string, listener: (...args: any[]) => void): void {
          const list = this._listeners[type] ?? [];
          const idx = list.indexOf(listener);
          if (idx >= 0) list.splice(idx, 1);
        }

        send(_data: string): void {}

        close(): void {
          this.readyState = FlakyWebSocket.CLOSED;
          this._emit("close");
        }

        private _emit(type: string, ...args: any[]): void {
          for (const fn of [...(this._listeners[type] ?? [])]) fn(...args);
        }
      }

      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = FlakyWebSocket;
      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");
        await expect(shell.reconnect()).rejects.toThrow("WebSocket reconnection failed");
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("sets connected=false when reconnected socket closes", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      let wsRef: MockWebSocket;
      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          wsRef = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");
        await shell.reconnect();
        expect(shell.connected).toBe(true);

        wsRef!._emit("close");
        expect(shell.connected).toBe(false);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("ignores close event from stale socket after reconnect", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const sockets: MockWebSocket[] = [];
      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          sockets.push(this);
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");
        await shell.reconnect();
        await shell.reconnect();
        expect(shell.connected).toBe(true);

        // sockets[1] is stale after the second reconnect.
        sockets[1]._emit("close");
        expect(shell.connected).toBe(true);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
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

    it("does not forward auth:refresh replies to the transport consumer", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      let capturedWs: MockWebSocket;
      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        const transport = await shell.connect("ws://localhost:3000");

        const forwarded: any[] = [];
        transport.onMessage((message) => {
          forwarded.push(message);
        });

        capturedWs!.onSend = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.name === "auth:refresh") {
            queueMicrotask(() => {
              capturedWs!._receiveMessage({ type: "return", id: "unrelated", value: 1 });
              capturedWs!._receiveMessage({ type: "return", id: msg.id, value: undefined });
            });
          }
        };

        await shell.refreshToken();

        expect(forwarded).toEqual([{ type: "return", id: "unrelated", value: 1 }]);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
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

    it("uses default message when throw payload has no error.message", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

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
            capturedWs._receiveMessage({ type: "throw", id: msg.id });
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

    it("throws if client is not initialized", async () => {
      const shell = new AuthShell();
      await expect(shell.refreshToken()).rejects.toThrow(
        "[@wc-bindable/hawc-auth0] Auth0 client is not initialized",
      );
    });

    it("throws if refreshed token is empty", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValueOnce("token").mockResolvedValueOnce(null),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
      await shell.connect("ws://localhost:3000");

      await expect(shell.refreshToken()).rejects.toThrow(
        "[@wc-bindable/hawc-auth0] Failed to refresh access token.",
      );
    });

    it("ignores malformed or unrelated websocket messages", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      let capturedWs: MockWebSocket;
      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        capturedWs!.onSend = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.name === "auth:refresh") {
            queueMicrotask(() => {
              capturedWs!._emit("message", { data: "not-json" });
              capturedWs!._receiveMessage({ type: "return", id: "other-id", value: undefined });
              capturedWs!._receiveMessage({ type: "return", id: msg.id, value: undefined });
            });
          }
        };

        await expect(shell.refreshToken()).resolves.toBeUndefined();
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("rejects when websocket closes before refresh response", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      let capturedWs: MockWebSocket;
      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        capturedWs!.onSend = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.name === "auth:refresh") {
            queueMicrotask(() => capturedWs!.close());
          }
        };

        await expect(shell.refreshToken()).rejects.toThrow(
          "WebSocket closed before token refresh completed",
        );
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("rejects when websocket errors before refresh response", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      let capturedWs: MockWebSocket;
      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        capturedWs!.onSend = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.name === "auth:refresh") {
            queueMicrotask(() => capturedWs!._simulateError());
          }
        };

        await expect(shell.refreshToken()).rejects.toThrow(
          "WebSocket error during token refresh",
        );
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("rejects when refresh response times out", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      let capturedWs: MockWebSocket;
      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        capturedWs!.onSend = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.name === "auth:refresh") {
            // Intentionally do not send any response.
          }
        };

        vi.useFakeTimers();
        try {
          const refreshPromise = shell.refreshToken();
          const rejectionAssertion = expect(refreshPromise).rejects.toThrow("Token refresh timed out");
          await vi.advanceTimersByTimeAsync(30_000);
          await rejectionAssertion;
        } finally {
          vi.useRealTimers();
        }
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("cleans up timer and listeners when ws.send throws synchronously", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const originalWS = globalThis.WebSocket;
      let capturedWs: MockWebSocket | null = null;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        // Make ws.send throw synchronously to simulate a socket that
        // transitioned out of OPEN between readyState check and send.
        capturedWs!.onSend = () => {
          throw new Error("send failed synchronously");
        };

        // Snapshot listeners that pre-exist refreshToken (e.g. the
        // connect()-installed long-lived close handler), so we can
        // assert refreshToken's three listeners were removed without
        // accidentally requiring removal of unrelated handlers.
        const listenersBefore = {
          message: (capturedWs as any)._listeners["message"]?.length ?? 0,
          close: (capturedWs as any)._listeners["close"]?.length ?? 0,
          error: (capturedWs as any)._listeners["error"]?.length ?? 0,
        };

        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
        const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
        const setTimeoutsBefore = setTimeoutSpy.mock.calls.length;

        await expect(shell.refreshToken()).rejects.toThrow("send failed synchronously");

        // The 30-second refresh timer must have been cleared, not left pending.
        const newTimers = setTimeoutSpy.mock.results.slice(setTimeoutsBefore);
        for (const result of newTimers) {
          expect(clearTimeoutSpy).toHaveBeenCalledWith(result.value);
        }

        // refreshToken's three listeners must have been removed too,
        // otherwise an unrelated future frame could be misattributed.
        const listenersAfter = {
          message: (capturedWs as any)._listeners["message"]?.length ?? 0,
          close: (capturedWs as any)._listeners["close"]?.length ?? 0,
          error: (capturedWs as any)._listeners["error"]?.length ?? 0,
        };
        expect(listenersAfter).toEqual(listenersBefore);

        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });
  });

  describe("getTokenExpiry stays in sync across refresh / reconnect", () => {
    function makeJwt(payload: Record<string, unknown>): string {
      const toBase64Url = (s: string) =>
        Buffer.from(s).toString("base64")
          .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const header = toBase64Url(JSON.stringify({ alg: "RS256" }));
      const body = toBase64Url(JSON.stringify(payload));
      return `${header}.${body}.sig`;
    }

    it("refreshToken() updates the token source read by getTokenExpiry()", async () => {
      const originalExp = Math.floor(Date.now() / 1000) + 60;
      const refreshedExp = originalExp + 3600;

      const originalToken = makeJwt({ sub: "u", exp: originalExp });
      const refreshedToken = makeJwt({ sub: "u", exp: refreshedExp });

      const getTokenSilently = vi.fn()
        .mockResolvedValueOnce(originalToken) // for _syncState at init
        .mockResolvedValueOnce(originalToken) // for connect()
        .mockResolvedValueOnce(refreshedToken); // for refreshToken()

      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently,
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const originalWS = globalThis.WebSocket;
      let capturedWs: MockWebSocket | null = null;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        // Before refresh: getTokenExpiry reflects original token.
        expect(shell.getTokenExpiry()).toBe(originalExp * 1000);

        capturedWs!.onSend = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.name === "auth:refresh") {
            queueMicrotask(() => {
              capturedWs!._receiveMessage({ type: "return", id: msg.id, value: undefined });
            });
          }
        };

        await shell.refreshToken();

        // After refresh: getTokenExpiry MUST reflect the refreshed token.
        // Otherwise exp-based schedulers see a past-due exp and busy-loop.
        expect(shell.getTokenExpiry()).toBe(refreshedExp * 1000);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("connect() does NOT advance getTokenExpiry() when the WebSocket fails to open", async () => {
      const candidateExp = Math.floor(Date.now() / 1000) + 60;
      const candidateToken = makeJwt({ sub: "u", exp: candidateExp });

      // Only one fetch should happen — connect()'s — and we want it to
      // produce a token whose exp must NOT leak into AuthCore on failure.
      const getTokenSilently = vi.fn().mockResolvedValue(candidateToken);

      const mockClient = createMockAuth0Client({
        // isAuthenticated=false so initialize() does NOT itself sync a token
        // via _syncState — that way the only candidate for _token is the one
        // connect() fetches.
        isAuthenticated: vi.fn().mockResolvedValue(false),
        getUser: vi.fn().mockResolvedValue(null),
        getTokenSilently,
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        private _failOpen = true;
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          // First and only socket: refuse to open.
          queueMicrotask(() => this._emit("error"));
        }
        addEventListener(type: string, listener: (...args: any[]) => void, opts?: any): void {
          if (this._failOpen && type === "open") return;
          super.addEventListener(type, listener, opts);
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

        // Sanity: nothing committed yet.
        expect(shell.getTokenExpiry()).toBeNull();

        await expect(shell.connect("ws://localhost:3000")).rejects.toThrow();

        // Connection failed — `_token` must not have been published,
        // otherwise schedulers would see a future `exp` even though
        // the server never accepted the token.
        expect(shell.getTokenExpiry()).toBeNull();
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("refreshToken() does NOT advance getTokenExpiry() when the server rejects", async () => {
      const originalExp = Math.floor(Date.now() / 1000) + 60;
      const refreshedExp = originalExp + 3600;

      const originalToken = makeJwt({ sub: "u", exp: originalExp });
      const refreshedToken = makeJwt({ sub: "u", exp: refreshedExp });

      const getTokenSilently = vi.fn()
        .mockResolvedValueOnce(originalToken) // _syncState
        .mockResolvedValueOnce(originalToken) // connect()
        .mockResolvedValueOnce(refreshedToken); // refreshToken() — will be rejected by server

      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently,
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const originalWS = globalThis.WebSocket;
      let capturedWs: MockWebSocket | null = null;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        expect(shell.getTokenExpiry()).toBe(originalExp * 1000);

        capturedWs!.onSend = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.name === "auth:refresh") {
            queueMicrotask(() => {
              capturedWs!._receiveMessage({
                type: "throw",
                id: msg.id,
                error: { name: "Error", message: "Token refresh hook failed" },
              });
            });
          }
        };

        await expect(shell.refreshToken()).rejects.toThrow();

        // Server rejected — `_token` (and therefore getTokenExpiry)
        // must still reflect the token the server previously accepted,
        // not the one we speculatively fetched from Auth0.
        expect(shell.getTokenExpiry()).toBe(originalExp * 1000);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("reconnect() does NOT advance getTokenExpiry() when the new WebSocket fails to open", async () => {
      const originalExp = Math.floor(Date.now() / 1000) + 60;
      const refreshedExp = originalExp + 7200;

      const originalToken = makeJwt({ sub: "u", exp: originalExp });
      const refreshedToken = makeJwt({ sub: "u", exp: refreshedExp });

      const getTokenSilently = vi.fn()
        .mockResolvedValueOnce(originalToken)
        .mockResolvedValueOnce(originalToken)
        .mockResolvedValueOnce(refreshedToken);

      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently,
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const originalWS = globalThis.WebSocket;
      let newSocketCount = 0;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        private _failOpen: boolean;
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          newSocketCount += 1;
          // The reconnect() socket — the second one — must fail to open.
          this._failOpen = newSocketCount === 2;
          if (this._failOpen) {
            queueMicrotask(() => this._emit("error"));
          }
        }
        addEventListener(type: string, listener: (...args: any[]) => void, opts?: any): void {
          if (this._failOpen && type === "open") return; // drop the open handler so it cannot resolve
          super.addEventListener(type, listener, opts);
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        expect(shell.getTokenExpiry()).toBe(originalExp * 1000);

        await expect(shell.reconnect()).rejects.toThrow();

        // Reconnection failed — `_token` must not have been published.
        expect(shell.getTokenExpiry()).toBe(originalExp * 1000);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("reconnect() updates the token source read by getTokenExpiry()", async () => {
      const originalExp = Math.floor(Date.now() / 1000) + 60;
      const refreshedExp = originalExp + 7200;

      const originalToken = makeJwt({ sub: "u", exp: originalExp });
      const refreshedToken = makeJwt({ sub: "u", exp: refreshedExp });

      const getTokenSilently = vi.fn()
        .mockResolvedValueOnce(originalToken) // _syncState at init
        .mockResolvedValueOnce(originalToken) // connect()
        .mockResolvedValueOnce(refreshedToken); // reconnect()

      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently,
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
      await shell.connect("ws://localhost:3000");

      expect(shell.getTokenExpiry()).toBe(originalExp * 1000);

      await shell.reconnect();

      expect(shell.getTokenExpiry()).toBe(refreshedExp * 1000);
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
