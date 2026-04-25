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
import { isOwnershipError, OWNERSHIP_ERROR_MARKER } from "../src/raiseError";

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

describe("AuthSession (auth0-session)", () => {
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
    expect(customElements.get("auth0-session")).toBeDefined();
  });

  it("exposes the expected bindable surface", () => {
    expect(AuthSession.wcBindable.properties.map((p) => p.name))
      .toEqual(["ready", "connecting", "error"]);
  });

  describe("attributes", () => {
    it("target / core / url / auto-connect round-trip", () => {
      const el = document.createElement("auth0-session") as AuthSession;
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

    it("attributeChangedCallback is a no-op when the element is not connected", () => {
      const el = document.createElement("auth0-session") as AuthSession;
      // Spy on the private worker that the callback would trigger if
      // it were NOT a no-op under disconnect. We assert on `_startWatching`
      // so the test actually catches a regression that reintroduces
      // re-init on detached elements.
      const spy = vi.spyOn(el as any, "_startWatching");
      el.attributeChangedCallback("target", null, "x");
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("recovers when target/core are stamped AFTER connect (late-bound attrs)", async () => {
      // Regression: declarative / framework integrations often mount the
      // element before the attribute values are available. Previously the
      // first `_startWatching()` would set a permanent "target not found"
      // / missing-core error and never retry — attributes were observed
      // but the callback was a no-op.
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth-late";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;
      vi.spyOn((authEl as any)._shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      // Mount without any attributes — the first `_startWatching()`
      // captures a missing target and records an error.
      const el = document.createElement("auth0-session") as AuthSession;
      document.body.appendChild(el);
      await el.connectedCallbackPromise;
      // Missing attributes land on the target-not-found error first
      // (empty `target` does not resolve to any element).
      expect(el.error).toBeInstanceOf(Error);
      expect(el.error?.message).toContain("not found");
      expect(el.proxy).toBeNull();

      // Now stamp the attributes — the late-bind hook must flush the
      // previous error and re-enter `_startWatching()`.
      el.setAttribute("target", "auth-late");
      el.setAttribute("core", "app-core");

      // Microtask coalescing: drain the scheduled restart, then its
      // internal awaits (authEl.connectedCallbackPromise + connect()).
      await new Promise((r) => setTimeout(r, 0));

      expect(el.error).toBeNull();
      expect(el.proxy).not.toBeNull();
      expect(el.transport).not.toBeNull();
    });

    it("does not restart a live session on unrelated attribute changes", async () => {
      // Regression: the late-bind hook must NOT re-enter `_startWatching()`
      // once a transport is live — doing so would tear down the working
      // proxy. Only restart when the session is idle (no transport, no
      // connecting).
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth-live";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;
      const connectSpy = vi.spyOn((authEl as any)._shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth-live";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;
      const firstProxy = el.proxy;
      expect(firstProxy).not.toBeNull();
      expect(connectSpy).toHaveBeenCalledTimes(1);

      // Mutate a monitored attribute while a transport is live — must
      // NOT restart.
      el.setAttribute("url", "wss://other.example.com/ws");
      await new Promise((r) => setTimeout(r, 0));

      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(el.proxy).toBe(firstProxy);
    });

    it("does not schedule an attribute-driven restart while detached", async () => {
      const el = document.createElement("auth0-session") as AuthSession;
      el.setAttribute("auto-connect", "");
      const startSpy = vi.spyOn(el as any, "_startWatching").mockResolvedValue(undefined);

      el.attributeChangedCallback("url", "ws://before", "ws://after");
      await Promise.resolve();

      expect(startSpy).not.toHaveBeenCalled();
    });

    it("does not schedule an attribute-driven restart when auto-connect is already false", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth-attr-disabled";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth-attr-disabled";
      el.core = "app-core";
      el.autoConnect = false;
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      const startSpy = vi.spyOn(el as any, "_startWatching").mockResolvedValue(undefined);

      el.attributeChangedCallback("url", "ws://before", "ws://after");
      await Promise.resolve();

      expect(startSpy).not.toHaveBeenCalled();
    });

    it("cancels a scheduled attribute-driven restart when auto-connect becomes false before the microtask", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth-attr-auto-flip";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth-attr-auto-flip";
      el.core = "app-core";
      el.setAttribute("auto-connect", "");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      const startSpy = vi.spyOn(el as any, "_startWatching").mockResolvedValue(undefined);
      vi.spyOn(el, "autoConnect", "get")
        .mockReturnValueOnce(true)
        .mockReturnValue(false);

      el.attributeChangedCallback("url", "ws://before", "ws://after");
      await Promise.resolve();

      expect(startSpy).not.toHaveBeenCalled();
    });

    it("cancels a scheduled attribute-driven restart when a connect begins before the microtask", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth-attr-connecting";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth-attr-connecting";
      el.core = "app-core";
      el.setAttribute("auto-connect", "");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      const startSpy = vi.spyOn(el as any, "_startWatching").mockResolvedValue(undefined);

      el.attributeChangedCallback("url", "ws://before", "ws://after");
      (el as any)._connecting = true;
      await Promise.resolve();

      expect(startSpy).not.toHaveBeenCalled();
    });

    it("cancels a scheduled attribute-driven restart when the element disconnects before the microtask", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth-attr-disconnect";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth-attr-disconnect";
      el.core = "app-core";
      el.setAttribute("auto-connect", "");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      const startSpy = vi.spyOn(el as any, "_startWatching").mockResolvedValue(undefined);

      el.attributeChangedCallback("url", "ws://before", "ws://after");
      el.remove();
      await Promise.resolve();

      expect(startSpy).not.toHaveBeenCalled();
    });
  });

  describe("error cases", () => {
    it("sets error when target is not in the DOM", async () => {
      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "missing";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.error).toBeInstanceOf(Error);
      expect(el.error?.message).toContain('target "missing" not found');
    });

    it("sets error when core attribute is missing", async () => {
      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      createAuth0Client.mockResolvedValue(createMockAuth0Client());
      document.body.appendChild(authEl);

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      // no core attribute
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.error?.message).toContain("`core` attribute is required");
    });

    it("sets error when core key is not registered", async () => {
      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      createAuth0Client.mockResolvedValue(createMockAuth0Client());
      document.body.appendChild(authEl);

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "unknown-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.error?.message).toContain('core "unknown-core" is not registered');
    });

    it("sets error when target id resolves to a non-<auth0-gate> element", async () => {
      const notAuth = document.createElement("div");
      notAuth.id = "auth";
      document.body.appendChild(notAuth);

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.error?.message).toContain('target "auth" not found');
    });

    it("sets a friendly error when neither session.url nor target.remote-url is set", async () => {
      const authEl = document.createElement("auth0-gate") as Auth;
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

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      // Note: explicitly leaving mode local-vs-remote alone; target has no
      // remote-url so this exercises the contract failure path.
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(connectSpy).not.toHaveBeenCalled();
      expect(el.error).toBeInstanceOf(Error);
      expect(el.error?.message).toContain("no WebSocket URL configured");
      expect(el.error?.message).toContain("`url` attribute on <auth0-session>");
      expect(el.error?.message).toContain("`remote-url` on the target <auth0-gate>");
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

      const authEl = document.createElement("auth0-gate") as Auth;
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

      const el = document.createElement("auth0-session") as AuthSession;
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

      const el = document.createElement("auth0-session") as AuthSession;
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

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(connectSpy.mock.calls[0][0]).toBe("wss://fallback.example.com/ws");
    });

    it("dispatches ready-changed and connecting-changed events", async () => {
      await setupAuthenticated();

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";

      const connectingEvents: boolean[] = [];
      const readyEvents: boolean[] = [];
      el.addEventListener("auth0-session:connecting-changed",
        (e) => connectingEvents.push((e as CustomEvent).detail));
      el.addEventListener("auth0-session:ready-changed",
        (e) => readyEvents.push((e as CustomEvent).detail));

      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      (el.proxy as any)._simulateSync({ currentUser: null, items: [] });
      await Promise.resolve();

      expect(connectingEvents).toEqual([true, false]);
      expect(readyEvents).toEqual([true]);
    });

    it("does not flip ready when the proxy is torn down before the queued ready microtask runs", async () => {
      const { authEl } = await setupAuthenticated();

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      (el.proxy as any)._simulateSync({ currentUser: { sub: "u" }, items: [] });
      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: false,
      }));
      await Promise.resolve();

      expect(el.ready).toBe(false);
      expect(el.proxy).toBeNull();
    });
  });

  describe("auth state transitions", () => {
    it("waits for authenticated-changed(true) before connecting", async () => {
      const mockClient = createMockAuth0Client(); // isAuthenticated defaults to false
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const connectSpy = vi.spyOn((authEl as any)._shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(connectSpy).not.toHaveBeenCalled();
      expect(el.proxy).toBeNull();

      // Simulate auth flipping to true.
      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: true,
      }));

      // Wait for the async connect chain.
      await new Promise((r) => setTimeout(r, 0));

      expect(connectSpy).toHaveBeenCalled();
      expect(el.proxy).not.toBeNull();
    });

    it("does not install a proxy when connected=false fires before _connect resumes", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth-race";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const fakeTransport = { send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() };
      vi.spyOn(authEl, "connect").mockImplementation(async () => {
        // Simulate the server closing the just-opened socket in the
        // microtask gap between `await auth.connect(...)` resolving and
        // AuthSession's `_connect()` resuming.
        queueMicrotask(() => {
          authEl.dispatchEvent(new CustomEvent("auth0-gate:connected-changed", {
            detail: false,
          }));
        });
        return fakeTransport as any;
      });

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth-race";
      el.core = "app-core";
      document.body.appendChild(el);

      await el.connectedCallbackPromise;
      await Promise.resolve();

      expect(el.proxy).toBeNull();
      expect(el.transport).toBeNull();
      expect(el.ready).toBe(false);
      expect(el.connecting).toBe(false);
    });

    it("tears down proxy + clears ready when authenticated flips back to false", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;
      vi.spyOn((authEl as any)._shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;
      (el.proxy as any)._simulateSync({ currentUser: { sub: "u" }, items: [] });
      await Promise.resolve();
      expect(el.ready).toBe(true);

      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: false,
      }));

      expect(el.ready).toBe(false);
      expect(el.proxy).toBeNull();
      expect(el.transport).toBeNull();
    });
    it("ignores connected-changed(false) when no session state is active", async () => {
      // NB: This test deliberately fires `connected-changed` manually on
      // the Auth element — it verifies the LOCAL contract that the
      // session's listener is a no-op when no transport/ready/connecting
      // state exists. The end-to-end propagation chain (AuthShell._
      // setConnected → Auth element → AuthSession listener) is locked
      // in separately by the K-001 regression test further down; the
      // two concerns are intentionally tested in isolation so a bug in
      // one surface does not mask the other.
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth-idle";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth-idle";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      authEl.dispatchEvent(new CustomEvent("auth0-gate:connected-changed", {
        detail: false,
      }));

      expect(el.proxy).toBeNull();
      expect(el.transport).toBeNull();
      expect(el.ready).toBe(false);
      expect(el.connecting).toBe(false);
    });

    // Cycle 9 (K-001): AuthShell._setConnected previously dispatched
    // `auth0-gate:connected-changed` on `this` (the AuthShell instance),
    // but AuthSession registers the listener on the Auth element. The
    // event therefore landed on the wrong EventTarget and the session
    // never saw transport loss (4401/4403/1008/1006/network). This
    // regression locks in the end-to-end propagation chain — if anyone
    // reverts the dispatch target back to `this`, the assertion fails.
    //
    // Coverage: (a) ready=true is flipped via the normal connect path
    // (not manually), (b) transport loss is triggered by invoking the
    // real `_setConnected(false)` on the shell — NOT by dispatching
    // the event on the Auth element manually — so the test fails if
    // and only if `_setConnected` dispatches on the wrong target.
    it("tears down when transport is lost via shell._setConnected(false) (K-001)", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth-k001";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      // Stub only AuthShell.connect (not the low-level _setConnected
      // surface) so the session's internal state advances through the
      // real connect path: _transport set, proxy installed, ready flips
      // true after the first sync batch. Critically we do NOT stub
      // `_setConnected` — that is exactly the function K-001 moves,
      // and we need the real implementation to fire on teardown.
      const shell = (authEl as any)._shell;
      const connectSpy = vi.spyOn(shell, "connect").mockImplementation(async () => {
        shell._setConnected(true);
        return { send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() } as any;
      });

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth-k001";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      (el.proxy as any)._simulateSync({ currentUser: { sub: "u" }, items: [] });
      await Promise.resolve();

      expect(connectSpy).toHaveBeenCalled();
      expect(el.ready).toBe(true);
      expect(el.transport).not.toBeNull();
      expect(el.proxy).not.toBeNull();

      // Simulate transport loss via the SHELL's own _setConnected(false)
      // — the real production path that fires on 4401/4403/1008/1006
      // close codes. If `_setConnected` dispatched on the shell instance
      // (the K-001 bug), the event would not reach the Auth element,
      // AuthSession's listener would never fire, and the session would
      // linger in ready=true pointing at a dead transport.
      shell._setConnected(false);

      expect(el.ready).toBe(false);
      expect(el.transport).toBeNull();
      expect(el.proxy).toBeNull();
    });

    // Cycle 9 (K-001 complement): the listener AuthSession registers
    // on the Auth element must receive the event when AuthShell
    // _setConnected fires. This is a thinner check than the E2E
    // teardown test above — it asserts only that the listener fires
    // at all with the correct `detail`, catching future regressions
    // even if the session's teardown logic changes.
    it("AuthShell._setConnected reaches listeners on the Auth element (K-001)", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth-propagation";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const events: boolean[] = [];
      authEl.addEventListener("auth0-gate:connected-changed", (e) => {
        events.push((e as CustomEvent).detail);
      });

      const shell = (authEl as any)._shell;
      shell._setConnected(true);
      shell._setConnected(false);

      expect(events).toEqual([true, false]);
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

      const authEl = document.createElement("auth0-gate") as Auth;
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

      const el = document.createElement("auth0-session") as AuthSession;
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
      // Cycle 7 (I-003): the ownership error carries the stable
      // `_authOwnership` sentinel so `_startWatching` can preserve
      // it across auto-restarts without relying on message matching.
      expect((el.error as unknown as Record<string, unknown>)[OWNERSHIP_ERROR_MARKER]).toBe(true);
      expect(isOwnershipError(el.error)).toBe(true);
    });

    it("preserves a standing ownership error across attribute-driven restarts (I-003)", async () => {
      // Regression: a framework that restamps `target` / `core` / `url`
      // after the first run triggers `attributeChangedCallback` ->
      // `_startWatching`, which used to clear the just-shown ownership
      // error. The stable `_authOwnership` sentinel lets
      // `isOwnershipError()` recognise it and preserve it across the
      // coalesced restart — even if the human-readable message drifts.
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const shell = (authEl as any)._shell;
      shell._setConnected(true);
      vi.spyOn(shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      const firstError = el.error;
      expect(firstError).toBeInstanceOf(Error);
      expect(isOwnershipError(firstError)).toBe(true);

      // Re-stamping the URL should coalesce through
      // attributeChangedCallback. Since there's no live transport the
      // restart fires, and the preserved ownership error must survive
      // through the `_setError(null)` that would otherwise clear it.
      // The ownership condition is still true after the restart, so
      // `_connect` re-sets a (new) ownership error — what matters is
      // that the error surface never flipped to `null` mid-restart,
      // which would have been visible as an error-changed event with
      // `null` detail. Capture dispatched events to assert that.
      const errorEvents: Array<Error | null> = [];
      el.addEventListener("auth0-session:error", (e) => {
        errorEvents.push((e as CustomEvent).detail);
      });

      el.setAttribute("url", "wss://alt.example.com/ws");
      await el.connectedCallbackPromise;
      // Flush the microtask-coalesced restart queue.
      await Promise.resolve();
      await Promise.resolve();

      // The preserved-error path never fires an error-changed(null)
      // event: a message-substring match would have broken silently,
      // but the `_authOwnership` sentinel keeps the guard intact.
      expect(errorEvents.every((e) => e !== null)).toBe(true);
      expect(isOwnershipError(el.error)).toBe(true);
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

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const shell = (authEl as any)._shell;
      const connectSpy = vi.spyOn(shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("auth0-session") as AuthSession;
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

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;
      vi.spyOn((authEl as any)._shell, "connect").mockRejectedValue(new Error("handshake failed"));

      const el = document.createElement("auth0-session") as AuthSession;
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

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;
      vi.spyOn((authEl as any)._shell, "connect").mockRejectedValue("string rejection");

      const el = document.createElement("auth0-session") as AuthSession;
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

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;
      const connectSpy = vi.spyOn((authEl as any)._shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("auth0-session") as AuthSession;
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

      const authEl = document.createElement("auth0-gate") as Auth;
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
        (args) => args[0] === "auth0-gate:authenticated-changed",
      ).length;
    }

    it("calling start() twice registers exactly one listener net", async () => {
      const { authEl, addSpy, removeSpy, connectSpy } = await setupUnauthenticatedSession();

      const el = document.createElement("auth0-session") as AuthSession;
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
      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: true,
      }));
      await new Promise((r) => setTimeout(r, 0));
      expect(connectSpy).toHaveBeenCalledTimes(1);
    });

    it("calling start() after auto-connect already ran does not duplicate listeners", async () => {
      const { authEl, addSpy, removeSpy, connectSpy } = await setupUnauthenticatedSession();

      const el = document.createElement("auth0-session") as AuthSession;
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

      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
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

      const authEl = document.createElement("auth0-gate") as Auth;
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

      const el = document.createElement("auth0-session") as AuthSession;
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

      const el = document.createElement("auth0-session") as AuthSession;
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
      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
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

      const authEl = document.createElement("auth0-gate") as Auth;
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

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);

      // Pump microtasks so _startWatching reaches `await auth.connect()`.
      await Promise.resolve();
      await Promise.resolve();
      expect(el.connecting).toBe(true);

      // Simulate logout DURING the handshake.
      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
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

      const el = document.createElement("auth0-session") as AuthSession;
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

      const authEl = document.createElement("auth0-gate") as Auth;
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

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);

      // Pump until the first _shell.connect() has been called.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(deferreds).toHaveLength(1);

      // First attempt gets interrupted by logout mid-handshake.
      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: false,
      }));

      // User logs in again before the first handshake settles.
      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
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

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await Promise.resolve();
      await Promise.resolve();

      // Teardown first.
      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: false,
      }));

      // Then the stale attempt rejects — error must not surface.
      rejectConnect(new Error("stale handshake failure"));
      await el.connectedCallbackPromise;

      expect(el.error).toBeNull();
      expect(el.proxy).toBeNull();
      expect(el.ready).toBe(false);
    });
    it("bails out before listener installation when generation changes during auth init wait", async () => {
      const authEl = document.createElement("auth0-gate") as Auth;

      let resolveInit!: () => void;
      const delayedInit = new Promise<void>((resolve) => {
        resolveInit = resolve;
      });
      Object.defineProperty(authEl, "connectedCallbackPromise", {
        configurable: true,
        get: () => delayedInit,
      });

      const addSpy = vi.spyOn(authEl, "addEventListener");

      const el = document.createElement("auth0-session") as AuthSession;
      el.core = "app-core";

      vi.spyOn(el as any, "_resolveAuth").mockReturnValue(authEl);

      const pending = (el as any)._startWatching();
      (el as any)._generation = 2;
      resolveInit();
      await pending;

      expect(addSpy).not.toHaveBeenCalledWith("auth0-gate:authenticated-changed", expect.any(Function));
    });

    it("_connect() is a no-op when auth or declaration is missing", async () => {
      const el = document.createElement("auth0-session") as AuthSession;

      await expect((el as any)._connect()).resolves.toBeUndefined();

      (el as any)._authEl = document.createElement("auth0-gate") as Auth;
      await expect((el as any)._connect()).resolves.toBeUndefined();
      (el as any)._authEl = document.createElement("auth0-gate") as Auth;
      (el as any)._coreDecl = SAMPLE_DECL;
      (el as any)._connecting = true;
      await expect((el as any)._connect()).resolves.toBeUndefined();
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

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;
      vi.spyOn((authEl as any)._shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("auth0-session") as AuthSession;
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
      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: true,
      }));
      await new Promise((r) => setTimeout(r, 0));
      expect(connectSpy).not.toHaveBeenCalled();
    });
  });

  describe("private state guards", () => {
    it("_setReady and _setConnecting do not dispatch duplicate events for the same value", () => {
      const el = document.createElement("auth0-session") as AuthSession;
      const readyEvents: boolean[] = [];
      const connectingEvents: boolean[] = [];

      el.addEventListener("auth0-session:ready-changed", (e) => {
        readyEvents.push((e as CustomEvent).detail);
      });
      el.addEventListener("auth0-session:connecting-changed", (e) => {
        connectingEvents.push((e as CustomEvent).detail);
      });

      (el as any)._setReady(true);
      (el as any)._setReady(true);
      (el as any)._setConnecting(true);
      (el as any)._setConnecting(true);

      expect(readyEvents).toEqual([true]);
      expect(connectingEvents).toEqual([true]);
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
