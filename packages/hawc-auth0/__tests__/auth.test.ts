import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Auth } from "../src/components/Auth";
import { AuthLogout } from "../src/components/AuthLogout";
import { registerComponents } from "../src/registerComponents";
import { bootstrapAuth } from "../src/bootstrapAuth";
import { config, setConfig, getConfig } from "../src/config";
import { raiseError } from "../src/raiseError";
import { registerAutoTrigger, unregisterAutoTrigger } from "../src/autoTrigger";

// registerComponents経由でカスタム要素を登録
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

// @auth0/auth0-spa-jsのモック
vi.mock("@auth0/auth0-spa-js", () => ({
  createAuth0Client: vi.fn(),
}));

describe("raiseError", () => {
  it("[@wcstack/auth0]プレフィックス付きのエラーをスローする", () => {
    expect(() => raiseError("test error")).toThrow("[@wc-bindable/hawc-auth0] test error");
  });
});

describe("config", () => {
  it("デフォルト設定を取得できる", () => {
    expect(config.tagNames.auth).toBe("hawc-auth0");
    expect(config.tagNames.authLogout).toBe("hawc-auth0-logout");
    expect(config.autoTrigger).toBe(true);
    expect(config.triggerAttribute).toBe("data-authtarget");
  });

  it("getConfig()でフリーズされたコピーを取得できる", () => {
    const frozen = getConfig();
    expect(frozen.tagNames.auth).toBe("hawc-auth0");
    expect(Object.isFrozen(frozen)).toBe(true);
    const frozen2 = getConfig();
    expect(frozen).toBe(frozen2);
  });

  it("setConfig()で部分的に設定を変更できる", () => {
    setConfig({ autoTrigger: false });
    expect(config.autoTrigger).toBe(false);
    setConfig({ autoTrigger: true });
    expect(config.autoTrigger).toBe(true);
  });

  it("setConfig()でtagNamesを変更できる", () => {
    setConfig({ tagNames: { auth: "my-auth" } });
    expect(config.tagNames.auth).toBe("my-auth");
    setConfig({ tagNames: { auth: "hawc-auth0" } });
  });

  it("setConfig()でtriggerAttributeを変更できる", () => {
    setConfig({ triggerAttribute: "data-trigger" });
    expect(config.triggerAttribute).toBe("data-trigger");
    setConfig({ triggerAttribute: "data-authtarget" });
  });

  it("setConfig()後にgetConfig()のキャッシュがリセットされる", () => {
    const frozen1 = getConfig();
    setConfig({ autoTrigger: false });
    const frozen2 = getConfig();
    expect(frozen1).not.toBe(frozen2);
    setConfig({ autoTrigger: true });
  });
});

describe("bootstrapAuth", () => {
  it("設定なしで呼び出せる", () => {
    expect(() => bootstrapAuth()).not.toThrow();
  });

  it("設定付きで呼び出せる", () => {
    expect(() => bootstrapAuth({ autoTrigger: false })).not.toThrow();
    setConfig({ autoTrigger: true });
  });
});

describe("Auth (hawc-auth0)", () => {
  let createAuth0Client: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import("@auth0/auth0-spa-js");
    createAuth0Client = (mod as any).createAuth0Client;
    createAuth0Client.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("カスタム要素として登録されている", () => {
    expect(customElements.get("hawc-auth0")).toBeDefined();
  });

  it("wcBindableプロパティにtriggerが含まれる", () => {
    expect(Auth.wcBindable.properties).toHaveLength(6);
    expect(Auth.wcBindable.properties[5].name).toBe("trigger");
  });

  it("hasConnectedCallbackPromiseがtrueである", () => {
    expect(Auth.hasConnectedCallbackPromise).toBe(true);
  });

  it("observedAttributesが正しい", () => {
    expect(Auth.observedAttributes).toEqual([
      "domain", "client-id", "redirect-uri", "audience", "scope", "remote-url", "mode"
    ]);
  });

  describe("属性", () => {
    it("domain属性を取得・設定できる", () => {
      const el = document.createElement("hawc-auth0") as Auth;
      expect(el.domain).toBe("");
      el.domain = "test.auth0.com";
      expect(el.domain).toBe("test.auth0.com");
    });

    it("clientId属性を取得・設定できる", () => {
      const el = document.createElement("hawc-auth0") as Auth;
      expect(el.clientId).toBe("");
      el.clientId = "my-client-id";
      expect(el.clientId).toBe("my-client-id");
    });

    it("redirectUri属性を取得・設定できる", () => {
      const el = document.createElement("hawc-auth0") as Auth;
      expect(el.redirectUri).toBe("");
      el.redirectUri = "/callback";
      expect(el.redirectUri).toBe("/callback");
    });

    it("audience属性を取得・設定できる", () => {
      const el = document.createElement("hawc-auth0") as Auth;
      expect(el.audience).toBe("");
      el.audience = "https://api.example.com";
      expect(el.audience).toBe("https://api.example.com");
    });

    it("scope属性のデフォルト値はopenid profile email", () => {
      const el = document.createElement("hawc-auth0") as Auth;
      expect(el.scope).toBe("openid profile email");
      el.scope = "openid email";
      expect(el.scope).toBe("openid email");
    });

    it("cacheLocation属性のデフォルト値はmemory", () => {
      const el = document.createElement("hawc-auth0") as Auth;
      expect(el.cacheLocation).toBe("memory");
      el.cacheLocation = "localstorage";
      expect(el.cacheLocation).toBe("localstorage");
    });

    it("useRefreshTokens属性のデフォルト値はtrue（属性未指定時）", () => {
      const el = document.createElement("hawc-auth0") as Auth;
      expect(el.useRefreshTokens).toBe(true);
      el.useRefreshTokens = false;
      expect(el.useRefreshTokens).toBe(false);
      el.useRefreshTokens = true;
      expect(el.useRefreshTokens).toBe(true);
    });

    it("popup属性を取得・設定できる", () => {
      const el = document.createElement("hawc-auth0") as Auth;
      expect(el.popup).toBe(false);
      el.popup = true;
      expect(el.popup).toBe(true);
      el.popup = false;
      expect(el.popup).toBe(false);
    });

    it("remoteUrl属性を取得・設定できる", () => {
      const el = document.createElement("hawc-auth0") as Auth;
      expect(el.remoteUrl).toBe("");
      el.remoteUrl = "ws://localhost:3000";
      expect(el.remoteUrl).toBe("ws://localhost:3000");
    });
  });

  describe("connectedCallback", () => {
    it("DOM追加時に非表示になる", () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      document.body.appendChild(el);

      expect(el.style.display).toBe("none");
    });

    it("domain/clientIdが設定されていれば自動初期化する", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      document.body.appendChild(el);

      await el.connectedCallbackPromise;

      expect(createAuth0Client).toHaveBeenCalledWith(expect.objectContaining({
        domain: "test.auth0.com",
        clientId: "client-id",
      }));
    });

    it("domain未設定時は自動初期化しない", () => {
      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("client-id", "client-id");
      document.body.appendChild(el);

      expect(createAuth0Client).not.toHaveBeenCalled();
    });

    it("再接続時に初期化が二重に走らない", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");

      // 初回接続
      document.body.appendChild(el);
      await el.connectedCallbackPromise;
      expect(createAuth0Client).toHaveBeenCalledTimes(1);

      // 切断→再接続
      el.remove();
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      // 2回目のcreateAuth0Client呼び出しがないことを確認
      expect(createAuth0Client).toHaveBeenCalledTimes(1);
    });

    it("初期化未完了中に切断→再接続してもcreateAuth0Clientが二重起動しない", async () => {
      // Regression: previously connectedCallback's guard only checked
      // `_shell.client`, which stays null during the in-flight await
      // for createAuth0Client. A disconnect→reconnect in that window
      // re-entered initialize() and raced two Auth0 client constructions.
      const mockClient = createMockAuth0Client();
      // Hold createAuth0Client pending so the first initialize() is
      // still mid-await when we disconnect / reconnect.
      let resolveFirst!: (v: unknown) => void;
      const pending = new Promise((resolve) => {
        resolveFirst = resolve;
      });
      createAuth0Client.mockReturnValue(pending);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");

      document.body.appendChild(el);
      // Flush the dynamic import() microtask so createAuth0Client is
      // actually invoked; still do NOT await connectedCallbackPromise —
      // we want to race inside the pending createAuth0Client() window.
      await new Promise((r) => setTimeout(r, 0));
      expect(createAuth0Client).toHaveBeenCalledTimes(1);

      el.remove();
      document.body.appendChild(el);
      await new Promise((r) => setTimeout(r, 0));

      // Guard must have suppressed the second initialize().
      expect(createAuth0Client).toHaveBeenCalledTimes(1);

      // Resolve the pending call and ensure the element finishes init
      // exactly once without the reconnect producing a second race.
      resolveFirst(mockClient);
      await el.connectedCallbackPromise;
      expect(createAuth0Client).toHaveBeenCalledTimes(1);
    });

    it("初期化失敗後にremove→appendすると自動で再初期化が走る", async () => {
      // Regression: the in-flight double-init guard added
      // `!_shell.initPromise` to the connectedCallback gate. Without
      // clearing `_initPromise` on failure, that gate would stay
      // permanently false after a transient Auth0 / network failure,
      // so the element could not auto-recover on reconnect — users
      // would be stuck unless they called `initialize()` imperatively.
      const failure = new Error("transient auth0 outage");
      createAuth0Client.mockRejectedValueOnce(failure);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");

      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      // First attempt failed — error is published, client stays null.
      expect(el.error).toBe(failure);
      expect((el as any)._shell.client).toBeNull();
      expect(createAuth0Client).toHaveBeenCalledTimes(1);

      // Reconnect should re-arm initialize() with a fresh Auth0 client.
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValueOnce(mockClient);

      el.remove();
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(createAuth0Client).toHaveBeenCalledTimes(2);
      expect((el as any)._shell.client).toBe(mockClient);
    });

    it("AuthCore.initializeの並走呼び出しは同じPromiseを返す（in-flight coalescing）", async () => {
      // Defense-in-depth: programmatic callers (or a racing lifecycle
      // path bypassing the outer guard) must not produce two parallel
      // createAuth0Client() attempts.
      const { AuthCore } = await import("../src/core/AuthCore");
      const mockClient = createMockAuth0Client();
      let resolveFirst!: (v: unknown) => void;
      createAuth0Client.mockReturnValueOnce(new Promise((resolve) => {
        resolveFirst = resolve;
      }));

      const core = new AuthCore();
      const p1 = core.initialize({
        domain: "test.auth0.com",
        clientId: "client-id",
        authorizationParams: {},
      });
      const p2 = core.initialize({
        domain: "test.auth0.com",
        clientId: "client-id",
        authorizationParams: {},
      });

      // Same promise, single underlying init.
      expect(p1).toBe(p2);

      // Flush the dynamic import() microtask so the mock registers the
      // single createAuth0Client() call.
      await new Promise((r) => setTimeout(r, 0));
      expect(createAuth0Client).toHaveBeenCalledTimes(1);

      resolveFirst(mockClient);
      await p1;

      // After settle, a new initialize() is allowed again (retry
      // semantics preserved).
      createAuth0Client.mockResolvedValueOnce(mockClient);
      const p3 = core.initialize({
        domain: "test.auth0.com",
        clientId: "client-id",
        authorizationParams: {},
      });
      expect(p3).not.toBe(p1);
      await p3;
    });
  });

  describe("出力状態（Coreへの委譲）", () => {
    it("authenticated, user, token, loading, errorがCoreから委譲される", async () => {
      const mockUser = { sub: "auth0|123", name: "Test" };
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue(mockUser),
        getTokenSilently: vi.fn().mockResolvedValue("access-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.authenticated).toBe(true);
      expect(el.user).toEqual(mockUser);
      expect(el.token).toBe("access-token");
      expect(el.loading).toBe(false);
      expect(el.error).toBeNull();
    });

    it("connectedがShellから委譲される", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.connected).toBe(false);
    });

    it("getTokenExpiry()がShellから委譲される", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      const expirySpy = vi.spyOn((el as any)._shell, "getTokenExpiry").mockReturnValue(123456);
      expect(el.getTokenExpiry()).toBe(123456);
      expect(expirySpy).toHaveBeenCalled();
    });
  });

  describe("trigger", () => {
    it("trigger=trueでloginが実行される", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      const triggerEvents: boolean[] = [];
      el.addEventListener("hawc-auth0:trigger-changed", (e: Event) => {
        triggerEvents.push((e as CustomEvent).detail);
      });

      el.trigger = true;
      // loginWithRedirect完了を待つ
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockClient.loginWithRedirect).toHaveBeenCalled();
      expect(el.trigger).toBe(false);
      expect(triggerEvents).toContain(false);
    });

    it("trigger=falseでは何も起きない", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      el.trigger = false;

      expect(mockClient.loginWithRedirect).not.toHaveBeenCalled();
      expect(el.trigger).toBe(false);
    });

    it("login()がrejectしてもunhandled rejectionにならず、_triggerリセットとイベント発火が行われる", async () => {
      const mockClient = createMockAuth0Client({
        loginWithRedirect: vi.fn().mockRejectedValue(new Error("auth0 login failed")),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      const unhandled: unknown[] = [];
      const handler = (e: PromiseRejectionEvent) => {
        unhandled.push(e.reason);
        e.preventDefault();
      };
      window.addEventListener("unhandledrejection", handler);

      const triggerEvents: boolean[] = [];
      el.addEventListener("hawc-auth0:trigger-changed", (e: Event) => {
        triggerEvents.push((e as CustomEvent).detail);
      });

      try {
        el.trigger = true;
        // microtask/macrotaskを複数回待ってrejection伝搬を確実にする
        await new Promise(resolve => setTimeout(resolve, 0));
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(mockClient.loginWithRedirect).toHaveBeenCalled();
        expect(el.trigger).toBe(false);
        expect(triggerEvents).toContain(false);
        expect(unhandled).toHaveLength(0);
      } finally {
        window.removeEventListener("unhandledrejection", handler);
      }
    });

    it("initialize(connectedCallbackPromise)失敗時もunhandled rejectionにならず、_triggerがリセットされる", async () => {
      // createAuth0Client自体がrejectするケース
      createAuth0Client.mockRejectedValue(new Error("auth0 init failed"));

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      document.body.appendChild(el);

      // connectedCallbackPromiseはrejectするが、ここで捕捉して先に進む
      await el.connectedCallbackPromise.catch(() => { /* expected */ });

      const unhandled: unknown[] = [];
      const handler = (e: PromiseRejectionEvent) => {
        unhandled.push(e.reason);
        e.preventDefault();
      };
      window.addEventListener("unhandledrejection", handler);

      const triggerEvents: boolean[] = [];
      el.addEventListener("hawc-auth0:trigger-changed", (e: Event) => {
        triggerEvents.push((e as CustomEvent).detail);
      });

      try {
        el.trigger = true;
        await new Promise(resolve => setTimeout(resolve, 0));
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(el.trigger).toBe(false);
        expect(triggerEvents).toContain(false);
        expect(unhandled).toHaveLength(0);
      } finally {
        window.removeEventListener("unhandledrejection", handler);
      }
    });
  });

  describe("_buildClientOptions", () => {
    it("redirectUri/audience未設定時はauthorizationParamsに含まれない", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      // redirectUri, audienceは未設定
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      const callArgs = createAuth0Client.mock.calls[0][0];
      expect(callArgs.authorizationParams.redirect_uri).toBeUndefined();
      expect(callArgs.authorizationParams.audience).toBeUndefined();
    });

    it("redirectUri/audience設定時はauthorizationParamsに含まれる", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      el.setAttribute("redirect-uri", "/callback");
      el.setAttribute("audience", "https://api.example.com");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      const callArgs = createAuth0Client.mock.calls[0][0];
      expect(callArgs.authorizationParams.redirect_uri).toBe("/callback");
      expect(callArgs.authorizationParams.audience).toBe("https://api.example.com");
    });
  });

  describe("初期化完了前の操作", () => {
    it("trigger=trueが初期化完了前でもレースしない", async () => {
      const mockClient = createMockAuth0Client();
      // 初期化を遅延させる
      createAuth0Client.mockImplementation(() => new Promise(resolve => {
        setTimeout(() => resolve(mockClient), 50);
      }));

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      document.body.appendChild(el);

      // 初期化完了前にtriggerを設定
      el.trigger = true;

      // 初期化完了を待つ
      await el.connectedCallbackPromise;
      await new Promise(resolve => setTimeout(resolve, 100));

      // エラーなくloginが呼ばれていることを確認
      expect(mockClient.loginWithRedirect).toHaveBeenCalled();
    });

    it("login()が初期化完了前でもレースしない", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockImplementation(() => new Promise(resolve => {
        setTimeout(() => resolve(mockClient), 50);
      }));

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      document.body.appendChild(el);

      // 初期化完了前にloginを呼ぶ — エラーにならない
      await el.login();

      expect(mockClient.loginWithRedirect).toHaveBeenCalled();
    });

    it("logout()が初期化完了前でもレースしない", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockImplementation(() => new Promise(resolve => {
        setTimeout(() => resolve(mockClient), 50);
      }));

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      document.body.appendChild(el);

      await el.logout();

      expect(mockClient.logout).toHaveBeenCalled();
    });
  });

  describe("login/logout", () => {
    it("popup属性設定時はloginWithPopupを使用する", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      el.setAttribute("popup", "");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      await el.login();

      expect(mockClient.loginWithPopup).toHaveBeenCalled();
      expect(mockClient.loginWithRedirect).not.toHaveBeenCalled();
    });

    it("logoutを呼び出せる", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      await el.logout();

      expect(mockClient.logout).toHaveBeenCalled();
    });

    it("getTokenを呼び出せる", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("new-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      const token = await el.getToken();
      expect(token).toBe("new-token");
    });

    it("connect()は引数URLをShellに委譲する", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      const connectSpy = vi.spyOn((el as any)._shell, "connect").mockResolvedValue({} as any);
      await el.connect("ws://example.com");
      expect(connectSpy).toHaveBeenCalledWith("ws://example.com");
    });

    it("connect()はURL未指定時にremote-url属性を使う", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      el.setAttribute("remote-url", "ws://attr-url");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      const connectSpy = vi.spyOn((el as any)._shell, "connect").mockResolvedValue({} as any);
      await el.connect();
      expect(connectSpy).toHaveBeenCalledWith("ws://attr-url");
    });

    it("refreshToken()を呼び出せる", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      const refreshSpy = vi.spyOn((el as any)._shell, "refreshToken").mockResolvedValue(undefined);
      await el.refreshToken();
      expect(refreshSpy).toHaveBeenCalled();
    });

    it("reconnect()を呼び出せる", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      const reconnectSpy = vi.spyOn((el as any)._shell, "reconnect").mockResolvedValue({} as any);
      await el.reconnect();
      expect(reconnectSpy).toHaveBeenCalled();
    });
  });

  describe("clientプロパティ", () => {
    it("初期化後にAuth0クライアントにアクセスできる", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.client).toBe(mockClient);
    });
  });

  describe("mode", () => {
    it("属性なし・remote-url なしなら local", () => {
      const el = document.createElement("hawc-auth0") as Auth;
      expect(el.mode).toBe("local");
    });

    it("remote-url が指定されると暗黙的に remote", () => {
      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("remote-url", "ws://example.com");
      expect(el.mode).toBe("remote");
    });

    it("remote-url が空文字列なら暗黙 remote にならない (local)", () => {
      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("remote-url", "");
      expect(el.mode).toBe("local");
    });

    it("remote-url が空文字列でも mode=remote が明示されれば remote", () => {
      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("remote-url", "");
      el.setAttribute("mode", "remote");
      expect(el.mode).toBe("remote");
    });

    it("mode 属性が明示されればそれが優先", () => {
      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("remote-url", "ws://example.com");
      el.setAttribute("mode", "local");
      expect(el.mode).toBe("local");
    });

    it("mode プロパティ setter で属性を書き換えられる", () => {
      const el = document.createElement("hawc-auth0") as Auth;
      el.mode = "remote";
      expect(el.getAttribute("mode")).toBe("remote");
      expect(el.mode).toBe("remote");
    });

    it("local モードでは el.token が値を返し、el.getToken() も動く", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("local-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.mode).toBe("local");
      expect(el.token).toBe("local-token");
      await expect(el.getToken()).resolves.toBe("local-token");
    });

    it("remote モードでは el.token が null、el.getToken() が throw する", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("secret-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const el = document.createElement("hawc-auth0") as Auth;
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      el.setAttribute("mode", "remote");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.mode).toBe("remote");
      expect(el.token).toBeNull();
      await expect(el.getToken()).rejects.toThrow(
        "getToken() is disabled in remote mode",
      );
    });

    it("attributeChangedCallback と disconnectedCallback は no-op で呼び出せる", () => {
      const el = document.createElement("hawc-auth0") as Auth;
      expect(() => el.attributeChangedCallback("mode", "local", "remote")).not.toThrow();
      expect(() => el.disconnectedCallback()).not.toThrow();
    });
  });
});

describe("AuthLogout (hawc-auth0-logout)", () => {
  let createAuth0Client: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import("@auth0/auth0-spa-js");
    createAuth0Client = (mod as any).createAuth0Client;
    createAuth0Client.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("カスタム要素として登録されている", () => {
    expect(customElements.get("hawc-auth0-logout")).toBeDefined();
  });

  it("target属性を取得・設定できる", () => {
    const el = document.createElement("hawc-auth0-logout") as AuthLogout;
    expect(el.target).toBe("");
    el.target = "auth-id";
    expect(el.target).toBe("auth-id");
  });

  it("returnTo属性を取得・設定できる", () => {
    const el = document.createElement("hawc-auth0-logout") as AuthLogout;
    expect(el.returnTo).toBe("");
    el.returnTo = "/";
    expect(el.returnTo).toBe("/");
  });

  it("クリックでtarget IDのhawc-auth0のlogoutを呼び出す", async () => {
    const mockClient = createMockAuth0Client();
    createAuth0Client.mockResolvedValue(mockClient);

    const authEl = document.createElement("hawc-auth0") as Auth;
    authEl.id = "my-auth";
    authEl.setAttribute("domain", "test.auth0.com");
    authEl.setAttribute("client-id", "client-id");
    document.body.appendChild(authEl);
    await authEl.connectedCallbackPromise;

    const logoutEl = document.createElement("hawc-auth0-logout") as AuthLogout;
    logoutEl.target = "my-auth";
    document.body.appendChild(logoutEl);

    logoutEl.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockClient.logout).toHaveBeenCalled();
  });

  it("return-to属性付きでログアウトできる", async () => {
    const mockClient = createMockAuth0Client();
    createAuth0Client.mockResolvedValue(mockClient);

    const authEl = document.createElement("hawc-auth0") as Auth;
    authEl.id = "my-auth";
    authEl.setAttribute("domain", "test.auth0.com");
    authEl.setAttribute("client-id", "client-id");
    document.body.appendChild(authEl);
    await authEl.connectedCallbackPromise;

    const logoutEl = document.createElement("hawc-auth0-logout") as AuthLogout;
    logoutEl.target = "my-auth";
    logoutEl.returnTo = "http://localhost/";
    document.body.appendChild(logoutEl);

    logoutEl.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockClient.logout).toHaveBeenCalledWith(
      expect.objectContaining({
        logoutParams: { returnTo: "http://localhost/" },
      })
    );
  });

  it("ドキュメント内の最初のhawc-auth0にフォールバックする", async () => {
    const mockClient = createMockAuth0Client();
    createAuth0Client.mockResolvedValue(mockClient);

    const authEl = document.createElement("hawc-auth0") as Auth;
    authEl.setAttribute("domain", "test.auth0.com");
    authEl.setAttribute("client-id", "client-id");
    document.body.appendChild(authEl);
    await authEl.connectedCallbackPromise;

    const logoutEl = document.createElement("hawc-auth0-logout") as AuthLogout;
    document.body.appendChild(logoutEl);

    logoutEl.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockClient.logout).toHaveBeenCalled();
  });

  it("最寄りの祖先hawc-auth0にフォールバックする", async () => {
    const mockClient = createMockAuth0Client();
    createAuth0Client.mockResolvedValue(mockClient);

    const authEl = document.createElement("hawc-auth0") as Auth;
    authEl.setAttribute("domain", "test.auth0.com");
    authEl.setAttribute("client-id", "client-id");
    document.body.appendChild(authEl);
    await authEl.connectedCallbackPromise;

    // hawc-auth0の子要素としてlogoutを配置（target未指定）
    const logoutEl = document.createElement("hawc-auth0-logout") as AuthLogout;
    authEl.appendChild(logoutEl);

    logoutEl.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockClient.logout).toHaveBeenCalled();
  });

  it("disconnectedCallbackでイベントリスナーが解除される", () => {
    const logoutEl = document.createElement("hawc-auth0-logout") as AuthLogout;
    document.body.appendChild(logoutEl);
    logoutEl.remove();
    // disconnectedCallback後のクリックは何も起きない
    expect(() => logoutEl.click()).not.toThrow();
  });

  it("hawc-auth0が見つからない場合は何もしない", async () => {
    const logoutEl = document.createElement("hawc-auth0-logout") as AuthLogout;
    logoutEl.target = "nonexistent";
    document.body.appendChild(logoutEl);

    // エラーが発生しないことを確認
    expect(() => logoutEl.click()).not.toThrow();
  });
});

describe("autoTrigger", () => {
  let createAuth0Client: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import("@auth0/auth0-spa-js");
    createAuth0Client = (mod as any).createAuth0Client;
    createAuth0Client.mockReset();
    unregisterAutoTrigger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    unregisterAutoTrigger();
    document.body.innerHTML = "";
  });

  it("data-authtarget属性でloginをトリガーできる", async () => {
    const mockClient = createMockAuth0Client();
    createAuth0Client.mockResolvedValue(mockClient);

    registerAutoTrigger();

    const authEl = document.createElement("hawc-auth0") as Auth;
    authEl.id = "auth1";
    authEl.setAttribute("domain", "test.auth0.com");
    authEl.setAttribute("client-id", "client-id");
    document.body.appendChild(authEl);
    await authEl.connectedCallbackPromise;

    const button = document.createElement("button");
    button.setAttribute("data-authtarget", "auth1");
    document.body.appendChild(button);

    button.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockClient.loginWithRedirect).toHaveBeenCalled();
  });

  it("対象がAuth要素でない場合は無視する", () => {
    registerAutoTrigger();

    const div = document.createElement("div");
    div.id = "not-auth";
    document.body.appendChild(div);

    const button = document.createElement("button");
    button.setAttribute("data-authtarget", "not-auth");
    document.body.appendChild(button);

    expect(() => button.click()).not.toThrow();
  });

  it("存在しないIDを指定した場合は無視する", () => {
    registerAutoTrigger();

    const button = document.createElement("button");
    button.setAttribute("data-authtarget", "nonexistent");
    document.body.appendChild(button);

    expect(() => button.click()).not.toThrow();
  });

  it("属性値が空の場合は無視する", () => {
    registerAutoTrigger();

    const button = document.createElement("button");
    button.setAttribute("data-authtarget", "");
    document.body.appendChild(button);

    expect(() => button.click()).not.toThrow();
  });

  it("unregisterAutoTrigger()で解除できる", async () => {
    const mockClient = createMockAuth0Client();
    createAuth0Client.mockResolvedValue(mockClient);

    // autoTriggerを無効化してconnectedCallbackでの再登録を防ぐ
    setConfig({ autoTrigger: false });

    registerAutoTrigger();
    unregisterAutoTrigger();

    const authEl = document.createElement("hawc-auth0") as Auth;
    authEl.id = "auth1";
    authEl.setAttribute("domain", "test.auth0.com");
    authEl.setAttribute("client-id", "client-id");
    document.body.appendChild(authEl);
    await authEl.connectedCallbackPromise;

    const button = document.createElement("button");
    button.setAttribute("data-authtarget", "auth1");
    document.body.appendChild(button);

    button.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockClient.loginWithRedirect).not.toHaveBeenCalled();

    // 設定を元に戻す
    setConfig({ autoTrigger: true });
  });

  it("registerAutoTrigger()は重複登録しない", () => {
    registerAutoTrigger();
    registerAutoTrigger();
    // エラーなく呼び出せる
    unregisterAutoTrigger();
    unregisterAutoTrigger();
  });

  it("全Auth要素がdisconnectedCallbackで破棄されるとdocumentリスナーが解除される", async () => {
    // Regression: before the refcounted cleanup, the global click
    // listener was attached once and never detached — long-lived SPAs
    // that mount/unmount <hawc-auth0> (routing, dynamic toolbars)
    // accumulated a dangling listener for the session lifetime.
    const mockClient = createMockAuth0Client();
    createAuth0Client.mockResolvedValue(mockClient);

    // Start clean — no external callers holding the listener.
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");

    try {
      const el1 = document.createElement("hawc-auth0") as Auth;
      el1.id = "a1";
      el1.setAttribute("domain", "test.auth0.com");
      el1.setAttribute("client-id", "client-id");

      const el2 = document.createElement("hawc-auth0") as Auth;
      el2.id = "a2";
      el2.setAttribute("domain", "test.auth0.com");
      el2.setAttribute("client-id", "client-id");

      document.body.appendChild(el1);
      document.body.appendChild(el2);
      await el1.connectedCallbackPromise;
      await el2.connectedCallbackPromise;

      // Listener must have been attached exactly once even with two
      // simultaneous <hawc-auth0> elements.
      const clickAdds = addSpy.mock.calls.filter(
        (c: any[]) => c[0] === "click",
      );
      expect(clickAdds.length).toBe(1);

      // Removing the first element must NOT detach the listener — el2
      // is still on the page and needs the handler.
      el1.remove();
      let clickRemoves = removeSpy.mock.calls.filter(
        (c: any[]) => c[0] === "click",
      );
      expect(clickRemoves.length).toBe(0);

      // Removing the last element detaches the listener (refcount -> 0).
      el2.remove();
      clickRemoves = removeSpy.mock.calls.filter(
        (c: any[]) => c[0] === "click",
      );
      expect(clickRemoves.length).toBe(1);

      // Click on an <data-authtarget> element after teardown must NOT
      // fire login — the listener is gone.
      const danglingAuth = document.createElement("hawc-auth0") as Auth;
      danglingAuth.id = "a3";
      danglingAuth.setAttribute("domain", "test.auth0.com");
      danglingAuth.setAttribute("client-id", "client-id");
      // Connect with autoTrigger disabled so this element does NOT
      // re-register. We are specifically verifying that the listener
      // stays detached in that window.
      setConfig({ autoTrigger: false });
      document.body.appendChild(danglingAuth);
      await danglingAuth.connectedCallbackPromise;
      const loginSpy = vi.spyOn(danglingAuth, "login").mockResolvedValue(undefined);

      const button = document.createElement("button");
      button.setAttribute("data-authtarget", "a3");
      document.body.appendChild(button);
      button.click();
      await new Promise((r) => setTimeout(r, 0));

      expect(loginSpy).not.toHaveBeenCalled();
      setConfig({ autoTrigger: true });
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  it("autoTrigger無効で接続したAuth要素はdisconnect時にrefcountを減らさない", async () => {
    // Per-instance `_autoTriggerRegistered` flag guard: if an element
    // never registered (because `config.autoTrigger` was false at its
    // connect time), disconnect must NOT call unregister — otherwise
    // the shared refcount drifts negative and a later register could
    // re-attach a listener that nobody balances.
    const mockClient = createMockAuth0Client();
    createAuth0Client.mockResolvedValue(mockClient);

    // External caller holds the listener at refcount 1.
    registerAutoTrigger();
    const removeSpy = vi.spyOn(document, "removeEventListener");

    try {
      setConfig({ autoTrigger: false });

      const el = document.createElement("hawc-auth0") as Auth;
      el.id = "a4";
      el.setAttribute("domain", "test.auth0.com");
      el.setAttribute("client-id", "client-id");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      el.remove();

      // This element never registered, so disconnect must not fire
      // removeEventListener either directly or by draining the external
      // caller's refcount.
      const clickRemoves = removeSpy.mock.calls.filter(
        (c: any[]) => c[0] === "click",
      );
      expect(clickRemoves.length).toBe(0);

      setConfig({ autoTrigger: true });
    } finally {
      removeSpy.mockRestore();
      // External caller releases its refcount.
      unregisterAutoTrigger();
    }
  });

  it("event.targetがElementでない場合は無視する", () => {
    registerAutoTrigger();

    // テキストノードからのイベントをシミュレート
    const textNode = document.createTextNode("text");
    document.body.appendChild(textNode);

    const event = new Event("click", { bubbles: true });
    Object.defineProperty(event, "target", { value: textNode });
    document.dispatchEvent(event);

    // エラーなく処理される
  });

  it("data-authtarget属性のないクリックは無視する", () => {
    registerAutoTrigger();

    const button = document.createElement("button");
    document.body.appendChild(button);

    // data-authtarget属性なしのクリック
    expect(() => button.click()).not.toThrow();
  });
});
