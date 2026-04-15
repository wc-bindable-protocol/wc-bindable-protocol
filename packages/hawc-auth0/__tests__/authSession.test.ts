import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WcBindableDeclaration } from "@wc-bindable/core";

import { AuthSession } from "../src/components/AuthSession";
import { Auth } from "../src/components/Auth";
import { registerComponents } from "../src/registerComponents";
import {
  registerCoreDeclaration,
  unregisterCoreDeclaration,
  getCoreDeclaration,
  _clearCoreRegistry,
} from "../src/coreRegistry";

vi.mock("@auth0/auth0-spa-js", () => ({
  createAuth0Client: vi.fn(),
}));

// Mock createRemoteCoreProxy so tests can control the "sync" timing.
// The returned object is an EventTarget with a constructor.wcBindable
// that matches the real proxy's shape: the declaration is rewritten with
// synthetic event names per property — but for bind() semantics we only
// need the property list and events to match.
// Note: createRemoteCoreProxy is mocked as a plain function (NOT vi.fn()) so
// that vi.restoreAllMocks() in afterEach does not wipe its implementation
// between tests.
vi.mock("@wc-bindable/remote", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  const factory = (decl: WcBindableDeclaration) => {
    const EVENT_PREFIX = "mock-proxy:";
    const proxy = new EventTarget() as EventTarget & {
      _simulateSync(values: Record<string, unknown>): void;
    };
    const proxyDecl: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: decl.properties.map((p) => ({ name: p.name, event: EVENT_PREFIX + p.name })),
    };
    Object.defineProperty(proxy.constructor, "wcBindable", { value: proxyDecl, configurable: true });
    for (const p of decl.properties) {
      Object.defineProperty(proxy, p.name, {
        configurable: true,
        get: () => (proxy as any)[`__${p.name}`],
      });
    }
    proxy._simulateSync = (values) => {
      for (const [name, value] of Object.entries(values)) {
        (proxy as any)[`__${name}`] = value;
        proxy.dispatchEvent(new CustomEvent(EVENT_PREFIX + name, { detail: value }));
      }
    };
    return proxy as any;
  };
  return {
    ...actual,
    createRemoteCoreProxy: factory,
  };
});

registerComponents();

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

const SAMPLE_DECL: WcBindableDeclaration = {
  protocol: "wc-bindable",
  version: 1,
  properties: [
    { name: "currentUser", event: "app:currentUser-changed" },
    { name: "items",       event: "app:items-changed" },
  ],
};

describe("AuthSession (hawc-auth0-session)", () => {
  let createAuth0Client: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import("@auth0/auth0-spa-js");
    createAuth0Client = (mod as any).createAuth0Client;
    createAuth0Client.mockReset();
    registerCoreDeclaration("app-core", SAMPLE_DECL);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    _clearCoreRegistry();
  });

  it("registered as a custom element", () => {
    expect(customElements.get("hawc-auth0-session")).toBeDefined();
  });

  it("exposes the expected bindable surface", () => {
    expect(AuthSession.wcBindable.properties.map((p) => p.name))
      .toEqual(["ready", "connecting", "error"]);
  });

  describe("attributes", () => {
    it("target / core / url / auto-connect round-trip", () => {
      const el = document.createElement("hawc-auth0-session") as AuthSession;
      expect(el.target).toBe("");
      el.target = "auth";
      expect(el.target).toBe("auth");

      expect(el.core).toBe("");
      el.core = "app-core";
      expect(el.core).toBe("app-core");

      expect(el.url).toBe("");
      el.url = "wss://example.com";
      expect(el.url).toBe("wss://example.com");

      expect(el.autoConnect).toBe(true); // default
      el.autoConnect = false;
      expect(el.autoConnect).toBe(false);
      el.autoConnect = true;
      expect(el.autoConnect).toBe(true);
    });

    it("observedAttributes lists the external-facing attributes", () => {
      expect(AuthSession.observedAttributes).toEqual([
        "target", "core", "url", "auto-connect",
      ]);
    });

    it("attributeChangedCallback is a no-op (no re-init)", () => {
      const el = document.createElement("hawc-auth0-session") as AuthSession;
      // Just exercising the method — no observable side effect.
      el.attributeChangedCallback("target", null, "x");
    });
  });

  describe("error cases", () => {
    it("sets error when target is not in the DOM", async () => {
      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "missing";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.error).toBeInstanceOf(Error);
      expect(el.error?.message).toContain('target "missing" not found');
    });

    it("sets error when core attribute is missing", async () => {
      const authEl = document.createElement("hawc-auth0") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      createAuth0Client.mockResolvedValue(createMockAuth0Client());
      document.body.appendChild(authEl);

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      // no core attribute
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.error?.message).toContain("`core` attribute is required");
    });

    it("sets error when core key is not registered", async () => {
      const authEl = document.createElement("hawc-auth0") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      createAuth0Client.mockResolvedValue(createMockAuth0Client());
      document.body.appendChild(authEl);

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "unknown-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.error?.message).toContain('core "unknown-core" is not registered');
    });

    it("sets error when target id resolves to a non-<hawc-auth0> element", async () => {
      const notAuth = document.createElement("div");
      notAuth.id = "auth";
      document.body.appendChild(notAuth);

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.error?.message).toContain('target "auth" not found');
    });

    it("sets a friendly error when neither session.url nor target.remote-url is set", async () => {
      const authEl = document.createElement("hawc-auth0") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      // NO remote-url on target — and no `url` on session below.
      // Force authenticated=true so _connect actually runs.
      createAuth0Client.mockResolvedValue(createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
      }));
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      // Spy must not be called: validation has to fail BEFORE shell.connect.
      const connectSpy = vi.spyOn((authEl as any)._shell, "connect");

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      // Note: explicitly leaving mode local-vs-remote alone; target has no
      // remote-url so this exercises the contract failure path.
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(connectSpy).not.toHaveBeenCalled();
      expect(el.error).toBeInstanceOf(Error);
      expect(el.error?.message).toContain("no WebSocket URL configured");
      expect(el.error?.message).toContain("`url` attribute on <hawc-auth0-session>");
      expect(el.error?.message).toContain("`remote-url` on the target <hawc-auth0>");
      expect(el.proxy).toBeNull();
      expect(el.transport).toBeNull();
      expect(el.connecting).toBe(false);
    });
  });

  describe("happy path", () => {
    async function setupAuthenticated({
      remoteUrl = "wss://example.com/ws",
    }: { remoteUrl?: string } = {}) {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("hawc-auth0") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", remoteUrl);
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      // Stub the shell's connect to return a fake transport synchronously.
      const fakeTransport = { send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() };
      vi.spyOn((authEl as any)._shell, "connect").mockResolvedValue(fakeTransport);

      return { authEl, fakeTransport };
    }

    it("connects and flips ready=true after first sync batch", async () => {
      const { authEl } = await setupAuthenticated();

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);

      await el.connectedCallbackPromise;

      expect(el.proxy).not.toBeNull();
      expect(el.transport).not.toBeNull();
      expect(el.ready).toBe(false);

      // Simulate server sync.
      (el.proxy as any)._simulateSync({ currentUser: { sub: "u" }, items: [] });

      // `_setReady` is queued in a microtask so the whole batch lands first.
      await Promise.resolve();

      expect(el.ready).toBe(true);
      expect(el.error).toBeNull();

      // No-op: authEl is referenced to silence unused-var
      expect(authEl.connected).toBe(false); // spied connect didn't flip real state
    });

    it("passes the explicit `url` attribute to authEl.connect()", async () => {
      const { authEl } = await setupAuthenticated({ remoteUrl: "" });
      const connectSpy = vi.mocked((authEl as any)._shell.connect);

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      el.url = "wss://override.example.com/ws";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      // Session also forwards `failIfConnected: true` as the atomic
      // ownership guard — see the SPEC-REMOTE §3.7 regression test in
      // "mutual exclusion". Assert by URL only here to keep this
      // signature check focused on URL resolution.
      expect(connectSpy.mock.calls[0][0]).toBe("wss://override.example.com/ws");
    });

    it("falls back to target's remote-url when `url` is not set", async () => {
      const { authEl } = await setupAuthenticated({ remoteUrl: "wss://fallback.example.com/ws" });
      const connectSpy = vi.mocked((authEl as any)._shell.connect);

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(connectSpy.mock.calls[0][0]).toBe("wss://fallback.example.com/ws");
    });

    it("dispatches ready-changed and connecting-changed events", async () => {
      await setupAuthenticated();

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";

      const connectingEvents: boolean[] = [];
      const readyEvents: boolean[] = [];
      el.addEventListener("hawc-auth0-session:connecting-changed",
        (e) => connectingEvents.push((e as CustomEvent).detail));
      el.addEventListener("hawc-auth0-session:ready-changed",
        (e) => readyEvents.push((e as CustomEvent).detail));

      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      (el.proxy as any)._simulateSync({ currentUser: null, items: [] });
      await Promise.resolve();

      expect(connectingEvents).toEqual([true, false]);
      expect(readyEvents).toEqual([true]);
    });
  });

  describe("auth state transitions", () => {
    it("waits for authenticated-changed(true) before connecting", async () => {
      const mockClient = createMockAuth0Client(); // isAuthenticated defaults to false
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("hawc-auth0") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const connectSpy = vi.spyOn((authEl as any)._shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(connectSpy).not.toHaveBeenCalled();
      expect(el.proxy).toBeNull();

      // Simulate auth flipping to true.
      authEl.dispatchEvent(new CustomEvent("hawc-auth0:authenticated-changed", {
        detail: true,
      }));

      // Wait for the async connect chain.
      await new Promise((r) => setTimeout(r, 0));

      expect(connectSpy).toHaveBeenCalled();
      expect(el.proxy).not.toBeNull();
    });

    it("tears down proxy + clears ready when authenticated flips back to false", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("hawc-auth0") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;
      vi.spyOn((authEl as any)._shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;
      (el.proxy as any)._simulateSync({ currentUser: { sub: "u" }, items: [] });
      await Promise.resolve();
      expect(el.ready).toBe(true);

      authEl.dispatchEvent(new CustomEvent("hawc-auth0:authenticated-changed", {
        detail: false,
      }));

      expect(el.ready).toBe(false);
      expect(el.proxy).toBeNull();
      expect(el.transport).toBeNull();
    });
  });

  describe("mutual exclusion with manual connect()", () => {
    it("fails fast when target is already connected (SPEC-REMOTE §3.7)", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("hawc-auth0") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      // Simulate the application having already called authEl.connect() —
      // force the shell into a "connected" state before the session starts.
      const shell = (authEl as any)._shell;
      shell._setConnected(true);
      const connectSpy = vi.spyOn(shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(connectSpy).not.toHaveBeenCalled();
      expect(el.proxy).toBeNull();
      expect(el.transport).toBeNull();
      expect(el.error).toBeInstanceOf(Error);
      expect(el.error?.message).toContain("target is already connected");
      expect(el.error?.message).toContain("§3.7");
    });

    it("passes failIfConnected:true through to AuthShell.connect (TOCTOU guard)", async () => {
      // Regression: the outer `auth.connected` check in AuthSession is
      // a fast path, not an atomic guard. A concurrent caller could
      // take the connection between that check and the `await
      // auth.connect()` microtask boundary. The session must pass
      // `failIfConnected: true` so AuthShell.connect() synchronously
      // claims ownership before any await — rejecting racing callers
      // instead of tearing down their sockets.
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("hawc-auth0") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const shell = (authEl as any)._shell;
      const connectSpy = vi.spyOn(shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(connectSpy).toHaveBeenCalledTimes(1);
      const [url, options] = connectSpy.mock.calls[0];
      expect(url).toBe("wss://example.com/ws");
      expect(options).toEqual({ failIfConnected: true });
    });
  });

  describe("connect failure", () => {
    it("sets error when authEl.connect() rejects", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("hawc-auth0") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;
      vi.spyOn((authEl as any)._shell, "connect").mockRejectedValue(new Error("handshake failed"));

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.error).toBeInstanceOf(Error);
      expect(el.error?.message).toBe("handshake failed");
      expect(el.proxy).toBeNull();
      expect(el.transport).toBeNull();
      expect(el.connecting).toBe(false);
    });

    it("normalises non-Error rejections to Error instances", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("hawc-auth0") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;
      vi.spyOn((authEl as any)._shell, "connect").mockRejectedValue("string rejection");

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.error).toBeInstanceOf(Error);
      expect(el.error?.message).toBe("string rejection");
    });
  });

  describe("auto-connect=false", () => {
    it("does not start until start() is called", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("hawc-auth0") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;
      const connectSpy = vi.spyOn((authEl as any)._shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      el.setAttribute("auto-connect", "false");
      document.body.appendChild(el);

      // Give queueMicrotask a chance to fire.
      await Promise.resolve();
      expect(connectSpy).not.toHaveBeenCalled();

      await el.start();
      expect(connectSpy).toHaveBeenCalled();
    });
  });

  describe("re-start does not leak listeners", () => {
    /**
     * Helper: install a session whose target is currently NOT authenticated,
     * so `_startWatching` registers the listener but does not call
     * `_connect()` immediately. Returns spies on the auth element's
     * add/remove EventListener so tests can count listener registrations.
     */
    async function setupUnauthenticatedSession() {
      const mockClient = createMockAuth0Client(); // isAuthenticated → false
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("hawc-auth0") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const addSpy = vi.spyOn(authEl, "addEventListener");
      const removeSpy = vi.spyOn(authEl, "removeEventListener");
      const connectSpy = vi.spyOn((authEl as any)._shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      return { authEl, addSpy, removeSpy, connectSpy };
    }

    function countAuthChangedListeners(spy: ReturnType<typeof vi.spyOn>): number {
      return spy.mock.calls.filter(
        (args) => args[0] === "hawc-auth0:authenticated-changed",
      ).length;
    }

    it("calling start() twice registers exactly one listener net", async () => {
      const { authEl, addSpy, removeSpy, connectSpy } = await setupUnauthenticatedSession();

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      el.setAttribute("auto-connect", "false");
      document.body.appendChild(el);

      await el.start();
      await el.start();
      await el.start();

      const added = countAuthChangedListeners(addSpy);
      const removed = countAuthChangedListeners(removeSpy);

      // Three start() calls add three listeners but the second and third
      // each remove the previous one first → net 1 active listener.
      expect(added).toBe(3);
      expect(removed).toBe(2);

      // A single authenticated-changed dispatch must trigger _connect()
      // exactly once. With the leak, every previous listener also fires
      // and connectSpy would be called multiple times.
      authEl.dispatchEvent(new CustomEvent("hawc-auth0:authenticated-changed", {
        detail: true,
      }));
      await new Promise((r) => setTimeout(r, 0));
      expect(connectSpy).toHaveBeenCalledTimes(1);
    });

    it("calling start() after auto-connect already ran does not duplicate listeners", async () => {
      const { authEl, addSpy, removeSpy, connectSpy } = await setupUnauthenticatedSession();

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      // auto-connect default = true
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      // Auto-connect already registered one listener.
      expect(countAuthChangedListeners(addSpy)).toBe(1);
      expect(countAuthChangedListeners(removeSpy)).toBe(0);

      await el.start();

      // start() must remove the auto-connect listener before adding its own.
      expect(countAuthChangedListeners(addSpy)).toBe(2);
      expect(countAuthChangedListeners(removeSpy)).toBe(1);

      authEl.dispatchEvent(new CustomEvent("hawc-auth0:authenticated-changed", {
        detail: true,
      }));
      await new Promise((r) => setTimeout(r, 0));
      expect(connectSpy).toHaveBeenCalledTimes(1);
    });

    it("retry via start() after a handshake failure does not leak the failed listener", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("hawc-auth0") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const addSpy = vi.spyOn(authEl, "addEventListener");
      const removeSpy = vi.spyOn(authEl, "removeEventListener");

      const connectSpy = vi.spyOn((authEl as any)._shell, "connect")
        .mockRejectedValueOnce(new Error("transient handshake failure"))
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      el.setAttribute("auto-connect", "false");
      document.body.appendChild(el);

      await el.start();
      expect(el.error).toBeInstanceOf(Error);
      expect(el.error?.message).toBe("transient handshake failure");

      await el.start();

      // Old listener removed, new listener installed; previous error cleared.
      expect(countAuthChangedListeners(addSpy)).toBe(2);
      expect(countAuthChangedListeners(removeSpy)).toBe(1);
      expect(el.error).toBeNull();
      expect(el.proxy).not.toBeNull(); // second connect succeeded
      expect(connectSpy).toHaveBeenCalledTimes(2);
    });

    it("disconnectedCallback removes the active listener exactly once", async () => {
      const { authEl, addSpy, removeSpy } = await setupUnauthenticatedSession();

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      el.setAttribute("auto-connect", "false");
      document.body.appendChild(el);
      await el.start();
      await el.start();

      // 2 adds, 1 remove from the second start() invocation.
      expect(countAuthChangedListeners(addSpy)).toBe(2);
      expect(countAuthChangedListeners(removeSpy)).toBe(1);

      el.remove();

      // disconnectedCallback removes the active listener; total removes = 2.
      expect(countAuthChangedListeners(removeSpy)).toBe(2);

      // No further dispatches should reach the session.
      authEl.dispatchEvent(new CustomEvent("hawc-auth0:authenticated-changed", {
        detail: true,
      }));
      await new Promise((r) => setTimeout(r, 0));
      // proxy stays null because no listener fires now.
      expect(el.proxy).toBeNull();
    });
  });

  describe("race: teardown during in-flight connect", () => {
    /**
     * Helper: build an authEl whose _shell.connect returns a promise we
     * control, so tests can interleave events between "connect() called"
     * and "connect() resolves".
     */
    async function setupDeferredConnect() {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("hawc-auth0") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      let resolveConnect!: (t: unknown) => void;
      let rejectConnect!: (e: unknown) => void;
      const connectPromise = new Promise((resolve, reject) => {
        resolveConnect = resolve;
        rejectConnect = reject;
      });
      const connectSpy = vi.spyOn((authEl as any)._shell, "connect")
        .mockReturnValue(connectPromise as any);
      return { authEl, connectSpy, resolveConnect, rejectConnect };
    }

    it("discards a handshake that completes AFTER authenticated=false", async () => {
      const { authEl, resolveConnect } = await setupDeferredConnect();

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);

      // Pump microtasks so _startWatching reaches `await auth.connect()`.
      await Promise.resolve();
      await Promise.resolve();
      expect(el.connecting).toBe(true);

      // Simulate logout DURING the handshake.
      authEl.dispatchEvent(new CustomEvent("hawc-auth0:authenticated-changed", {
        detail: false,
      }));
      expect(el.connecting).toBe(false); // teardown flipped it immediately

      // Handshake resolves AFTER the teardown.
      resolveConnect({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });
      await el.connectedCallbackPromise;

      // The stale transport must NOT be installed; `ready` must stay false.
      expect(el.proxy).toBeNull();
      expect(el.transport).toBeNull();
      expect(el.ready).toBe(false);
      expect(el.error).toBeNull();
      expect(el.connecting).toBe(false);
    });

    it("discards a handshake that completes AFTER element removal", async () => {
      const { authEl, resolveConnect } = await setupDeferredConnect();

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);

      await Promise.resolve();
      await Promise.resolve();
      expect(el.connecting).toBe(true);

      // Remove the element mid-handshake.
      el.remove();
      expect(el.connecting).toBe(false);

      // Handshake resolves AFTER the removal.
      resolveConnect({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });
      await el.connectedCallbackPromise;

      expect(el.proxy).toBeNull();
      expect(el.transport).toBeNull();
      expect(el.ready).toBe(false);

      // authEl is referenced to keep the test intentional.
      expect(authEl.id).toBe("auth");
    });

    it("discards the first attempt but succeeds on re-auth after false→true bounce", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("hawc-auth0") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      // Explicit per-call sequencing: first call returns the deferred for
      // the stale handshake, second call returns the deferred for the
      // re-auth handshake. Avoids mockReturnValueOnce queue ambiguity.
      const deferreds: Array<{
        promise: Promise<unknown>;
        resolve: (t: unknown) => void;
      }> = [];
      vi.spyOn((authEl as any)._shell, "connect").mockImplementation(() => {
        let resolve!: (t: unknown) => void;
        const promise = new Promise<unknown>((r) => { resolve = r; });
        deferreds.push({ promise, resolve });
        return promise;
      });

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);

      // Pump until the first _shell.connect() has been called.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(deferreds).toHaveLength(1);

      // First attempt gets interrupted by logout mid-handshake.
      authEl.dispatchEvent(new CustomEvent("hawc-auth0:authenticated-changed", {
        detail: false,
      }));

      // User logs in again before the first handshake settles.
      authEl.dispatchEvent(new CustomEvent("hawc-auth0:authenticated-changed", {
        detail: true,
      }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(deferreds).toHaveLength(2);
      expect(el.connecting).toBe(true);

      // Stale first handshake finally resolves — must be discarded.
      deferreds[0].resolve({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();
      expect(el.proxy).toBeNull();

      // Fresh handshake resolves — this one is the live attempt.
      deferreds[1].resolve({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();

      expect(el.proxy).not.toBeNull();
      expect(el.connecting).toBe(false);

      // And sync completion still drives ready=true on the fresh proxy.
      (el.proxy as any)._simulateSync({ currentUser: null, items: [] });
      await Promise.resolve();
      expect(el.ready).toBe(true);
    });

    it("discards a handshake rejection that arrives AFTER teardown", async () => {
      const { authEl, rejectConnect } = await setupDeferredConnect();

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await Promise.resolve();
      await Promise.resolve();

      // Teardown first.
      authEl.dispatchEvent(new CustomEvent("hawc-auth0:authenticated-changed", {
        detail: false,
      }));

      // Then the stale attempt rejects — error must not surface.
      rejectConnect(new Error("stale handshake failure"));
      await el.connectedCallbackPromise;

      expect(el.error).toBeNull();
      expect(el.proxy).toBeNull();
      expect(el.ready).toBe(false);
    });
  });

  describe("disconnectedCallback", () => {
    it("tears down and removes auth listener", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("hawc-auth0") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;
      vi.spyOn((authEl as any)._shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("hawc-auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      el.remove();

      expect(el.proxy).toBeNull();
      expect(el.transport).toBeNull();

      // Dispatching authenticated-changed after removal should not re-connect.
      const connectSpy = vi.mocked((authEl as any)._shell.connect);
      connectSpy.mockClear();
      authEl.dispatchEvent(new CustomEvent("hawc-auth0:authenticated-changed", {
        detail: true,
      }));
      await new Promise((r) => setTimeout(r, 0));
      expect(connectSpy).not.toHaveBeenCalled();
    });
  });
});

describe("coreRegistry", () => {
  afterEach(() => {
    _clearCoreRegistry();
  });

  it("registers and retrieves declarations by key", () => {
    registerCoreDeclaration("a", SAMPLE_DECL);
    expect(getCoreDeclaration("a")).toBe(SAMPLE_DECL);
  });

  it("returns undefined for unknown keys", () => {
    expect(getCoreDeclaration("nope")).toBeUndefined();
  });

  it("rejects empty keys", () => {
    expect(() => registerCoreDeclaration("", SAMPLE_DECL)).toThrow(
      /key must be a non-empty string/,
    );
  });

  it("rejects re-registration with a different declaration", () => {
    registerCoreDeclaration("a", SAMPLE_DECL);
    const other: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "x", event: "x:changed" }],
    };
    expect(() => registerCoreDeclaration("a", other)).toThrow(
      /already registered with a different declaration/,
    );
  });

  it("is idempotent for identical re-registration", () => {
    registerCoreDeclaration("a", SAMPLE_DECL);
    expect(() => registerCoreDeclaration("a", SAMPLE_DECL)).not.toThrow();
  });

  it("unregisterCoreDeclaration removes the entry", () => {
    registerCoreDeclaration("a", SAMPLE_DECL);
    expect(unregisterCoreDeclaration("a")).toBe(true);
    expect(getCoreDeclaration("a")).toBeUndefined();
    expect(unregisterCoreDeclaration("a")).toBe(false);
  });
});
