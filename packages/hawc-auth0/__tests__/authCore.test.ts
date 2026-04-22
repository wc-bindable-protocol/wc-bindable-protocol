import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AuthCore } from "../src/core/AuthCore";

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

describe("AuthCore", () => {
  let createAuth0Client: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import("@auth0/auth0-spa-js");
    createAuth0Client = (mod as any).createAuth0Client;
    createAuth0Client.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("EventTargetを継承している", () => {
    const core = new AuthCore();
    expect(core).toBeInstanceOf(EventTarget);
  });

  it("wcBindableプロパティが正しく定義されている", () => {
    expect(AuthCore.wcBindable.protocol).toBe("wc-bindable");
    expect(AuthCore.wcBindable.version).toBe(1);
    expect(AuthCore.wcBindable.properties).toHaveLength(5);
    expect(AuthCore.wcBindable.properties[0].name).toBe("authenticated");
    expect(AuthCore.wcBindable.properties[1].name).toBe("user");
    expect(AuthCore.wcBindable.properties[2].name).toBe("token");
    expect(AuthCore.wcBindable.properties[3].name).toBe("loading");
    expect(AuthCore.wcBindable.properties[4].name).toBe("error");
  });

  it("初期状態が正しい", () => {
    const core = new AuthCore();
    expect(core.authenticated).toBe(false);
    expect(core.user).toBeNull();
    expect(core.token).toBeNull();
    expect(core.loading).toBe(false);
    expect(core.error).toBeNull();
    expect(core.client).toBeNull();
    expect(core.initPromise).toBeNull();
  });

  it("HTMLElementではなくEventTargetベースである", () => {
    const core = new AuthCore();
    expect(core).toBeInstanceOf(EventTarget);
    expect(core).not.toBeInstanceOf(HTMLElement);
  });

  describe("initialize", () => {
    it("domain未指定時にエラーをスローする", () => {
      const core = new AuthCore();
      expect(() => core.initialize({ domain: "", clientId: "id" })).toThrow(
        "[@wc-bindable/hawc-auth0] domain is required."
      );
    });

    it("clientId未指定時にエラーをスローする", () => {
      const core = new AuthCore();
      expect(() => core.initialize({ domain: "test.auth0.com", clientId: "" })).toThrow(
        "[@wc-bindable/hawc-auth0] clientId is required."
      );
    });

    it("Auth0クライアントを初期化できる（未認証）", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const core = new AuthCore();
      const events: string[] = [];
      core.addEventListener("hawc-auth0:loading-changed", () => events.push("loading"));
      core.addEventListener("hawc-auth0:authenticated-changed", () => events.push("authenticated"));

      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });

      expect(core.authenticated).toBe(false);
      expect(core.user).toBeNull();
      expect(core.token).toBeNull();
      expect(core.loading).toBe(false);
      expect(core.client).toBe(mockClient);
      expect(events).toContain("loading");
      expect(events).toContain("authenticated");
    });

    it("Auth0クライアントを初期化できる（認証済み）", async () => {
      const mockUser = { sub: "auth0|123", name: "Test User", email: "test@example.com" };
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue(mockUser),
        getTokenSilently: vi.fn().mockResolvedValue("access-token-123"),
      });
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const core = new AuthCore();
      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });

      expect(core.authenticated).toBe(true);
      expect(core.user).toEqual(mockUser);
      expect(core.token).toBe("access-token-123");
      expect(core.loading).toBe(false);
    });

    it("getUser()がundefinedを返した場合はnullになる", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue(undefined),
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const core = new AuthCore();
      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });

      expect(core.user).toBeNull();
    });

    it("getTokenSilently()がundefinedを返した場合はnullになる", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "auth0|123" }),
        getTokenSilently: vi.fn().mockResolvedValue(undefined),
      });
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const core = new AuthCore();
      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });

      expect(core.token).toBeNull();
    });

    it("トークン取得失敗時も authenticated は維持され、error にエラーが公開される", async () => {
      // Cycle 7 contract change (I-004): `_syncState()` now publishes
      // the Auth0 SDK rejection via `_setError` so subscribers can
      // distinguish "authenticated but no token yet" from "authenticated
      // with a working token". Mirrors the error contract of `getToken()`
      // and prevents the silent authenticated=true/token=null/error=null
      // state that previously stranded Authorization-header flows without
      // any observable signal.
      const tokenError = new Error("token error");
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "auth0|123" }),
        getTokenSilently: vi.fn().mockRejectedValue(tokenError),
      });
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const core = new AuthCore();
      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });

      expect(core.authenticated).toBe(true);
      expect(core.token).toBeNull();
      expect(core.error).toBe(tokenError);
    });

    it("_syncState トークン取得失敗時に hawc-auth0:error が発火する (I-004)", async () => {
      // Regression: previously `_syncState`'s catch block was bare
      // (`catch (_e)`) so no error event was dispatched. Subscribers
      // binding through `hawc-auth0:error` would never learn the token
      // fetch failed — now the event fires with the normalised error
      // as its detail, mirroring `getToken()`'s event contract.
      const tokenError = new Error("login_required");
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "auth0|123" }),
        getTokenSilently: vi.fn().mockRejectedValue(tokenError),
      });
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const core = new AuthCore();
      const errorEvents: unknown[] = [];
      core.addEventListener("hawc-auth0:error", (e) => {
        errorEvents.push((e as CustomEvent).detail);
      });
      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });

      // Event sequence: _doInitialize clears error at start (null), then
      // _syncState publishes the token-fetch failure.
      expect(errorEvents[0]).toBeNull();
      expect(errorEvents[errorEvents.length - 1]).toBe(tokenError);
      expect(core.error).toBe(tokenError);
    });

    it("initPromiseが設定される", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const core = new AuthCore();
      const promise = core.initialize({ domain: "test.auth0.com", clientId: "client-id" });

      expect(core.initPromise).toBe(promise);
      await promise;
    });

    it("リダイレクトコールバックでcode/stateのみ除去し他のパラメータは保持する", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const savedHref = globalThis.location.href;
      const savedSearch = globalThis.location.search;

      // happy-domのlocationを直接書き換え
      Object.defineProperty(globalThis.location, "search", { value: "?code=abc&state=xyz&returnTo=/dashboard&utm_source=email", configurable: true });
      Object.defineProperty(globalThis.location, "href", { value: "http://localhost/callback?code=abc&state=xyz&returnTo=/dashboard&utm_source=email", configurable: true });

      const replaceStateSpy = vi.spyOn(globalThis.history, "replaceState");

      try {
        const core = new AuthCore();
        await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });

        expect(mockClient.handleRedirectCallback).toHaveBeenCalled();
        const calledUrl = replaceStateSpy.mock.calls[0][2] as string;
        expect(calledUrl).not.toContain("code=");
        expect(calledUrl).not.toContain("state=");
        expect(calledUrl).toContain("returnTo=");
        expect(calledUrl).toContain("utm_source=email");
      } finally {
        Object.defineProperty(globalThis.location, "search", { value: savedSearch, configurable: true });
        Object.defineProperty(globalThis.location, "href", { value: savedHref, configurable: true });
        replaceStateSpy.mockRestore();
      }
    });

    it("リダイレクトコールバックを処理する", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const savedHref = globalThis.location.href;
      const savedSearch = globalThis.location.search;

      Object.defineProperty(globalThis.location, "search", { value: "?code=abc&state=xyz", configurable: true });
      Object.defineProperty(globalThis.location, "href", { value: "http://localhost/callback?code=abc&state=xyz", configurable: true });

      const replaceStateSpy = vi.spyOn(globalThis.history, "replaceState");

      try {
        const core = new AuthCore();
        await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });

        expect(mockClient.handleRedirectCallback).toHaveBeenCalled();
        expect(replaceStateSpy).toHaveBeenCalled();
      } finally {
        Object.defineProperty(globalThis.location, "search", { value: savedSearch, configurable: true });
        Object.defineProperty(globalThis.location, "href", { value: savedHref, configurable: true });
        replaceStateSpy.mockRestore();
      }
    });

    it("`code`/`state` を部分文字列として含むクエリ（promo_code/session_state 等）では handleRedirectCallback を呼ばない", async () => {
      // 素の `query.includes("code=") && query.includes("state=")` 判定だと
      // `?promo_code=abc&session_state=xyz` のようなクーポン/UTM クエリを
      // 誤検知して Auth0 の handleRedirectCallback を走らせ、"Invalid state"
      // で初期化が失敗する。`URLSearchParams.has()` に揃えて回避済みであることを
      // 保証する回帰テスト。
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const savedHref = globalThis.location.href;
      const savedSearch = globalThis.location.search;

      Object.defineProperty(globalThis.location, "search", {
        value: "?promo_code=abc&session_state=xyz&no_code=1&my_state=2",
        configurable: true,
      });
      Object.defineProperty(globalThis.location, "href", {
        value: "http://localhost/?promo_code=abc&session_state=xyz&no_code=1&my_state=2",
        configurable: true,
      });

      const replaceStateSpy = vi.spyOn(globalThis.history, "replaceState");

      try {
        const core = new AuthCore();
        await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });

        // 本物の ?code=&state= ではないので callback 経路は踏まないはず
        expect(mockClient.handleRedirectCallback).not.toHaveBeenCalled();
        expect(replaceStateSpy).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(globalThis.location, "search", { value: savedSearch, configurable: true });
        Object.defineProperty(globalThis.location, "href", { value: savedHref, configurable: true });
        replaceStateSpy.mockRestore();
      }
    });

    it("初期化時にerrorクリアイベントが発火する", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const core = new AuthCore();
      const errorEvents: any[] = [];
      core.addEventListener("hawc-auth0:error", (e: Event) => {
        errorEvents.push((e as CustomEvent).detail);
      });

      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });

      // error=nullのイベントが発火していること（バインディング先が観測可能）
      expect(errorEvents).toContain(null);
    });

    it("初期化エラーを処理できる", async () => {
      createAuth0Client.mockRejectedValueOnce(new Error("init failed"));

      const core = new AuthCore();
      const errors: any[] = [];
      core.addEventListener("hawc-auth0:error", (e: Event) => {
        errors.push((e as CustomEvent).detail);
      });

      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });

      expect(core.error).toBeInstanceOf(Error);
      expect(core.loading).toBe(false);
      // error=null（初期化冒頭クリア）とError（初期化失敗）の2回
      expect(errors).toHaveLength(2);
      expect(errors[0]).toBeNull();
      expect(errors[1]).toBeInstanceOf(Error);
    });
  });

  describe("target指定", () => {
    it("target未指定時はイベントが自身にディスパッチされる", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const core = new AuthCore();
      const events: string[] = [];
      core.addEventListener("hawc-auth0:loading-changed", () => events.push("loading"));

      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });

      expect(events.length).toBeGreaterThan(0);
    });

    it("target指定時はイベントがtargetにディスパッチされる", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const target = new EventTarget();
      const core = new AuthCore(target);
      const coreEvents: string[] = [];
      const targetEvents: string[] = [];

      core.addEventListener("hawc-auth0:loading-changed", () => coreEvents.push("loading"));
      target.addEventListener("hawc-auth0:loading-changed", () => targetEvents.push("loading"));

      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });

      expect(coreEvents).toEqual([]);
      expect(targetEvents.length).toBeGreaterThan(0);
    });
  });

  describe("login", () => {
    it("クライアント未初期化時にエラーをスローする", async () => {
      const core = new AuthCore();
      await expect(core.login()).rejects.toThrow("[@wc-bindable/hawc-auth0] Auth0 client is not initialized.");
    });

    it("loginWithRedirectを呼び出す", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const core = new AuthCore();
      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });
      await core.login();

      expect(mockClient.loginWithRedirect).toHaveBeenCalled();
    });

    it("login()でloadingがtrueになりerrorがクリアされる", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const core = new AuthCore();
      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });

      const events: Array<{ name: string; detail: any }> = [];
      core.addEventListener("hawc-auth0:loading-changed", (e: Event) => {
        events.push({ name: "loading", detail: (e as CustomEvent).detail });
      });
      core.addEventListener("hawc-auth0:error", (e: Event) => {
        events.push({ name: "error", detail: (e as CustomEvent).detail });
      });

      await core.login();

      // loading=trueとerror=nullのイベントが発火していることを確認
      expect(events.some(e => e.name === "loading" && e.detail === true)).toBe(true);
      expect(events.some(e => e.name === "error" && e.detail === null)).toBe(true);
    });

    it("ログインエラーを処理できる", async () => {
      const mockClient = createMockAuth0Client({
        loginWithRedirect: vi.fn().mockRejectedValue(new Error("login failed")),
      });
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const core = new AuthCore();
      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });
      await core.login();

      expect(core.error).toBeInstanceOf(Error);
      expect(core.loading).toBe(false);
    });
  });

  describe("loginWithPopup", () => {
    it("クライアント未初期化時にエラーをスローする", async () => {
      const core = new AuthCore();
      await expect(core.loginWithPopup()).rejects.toThrow("[@wc-bindable/hawc-auth0] Auth0 client is not initialized.");
    });

    it("ポップアップログイン後に状態を同期する", async () => {
      const mockUser = { sub: "auth0|456", name: "Popup User" };
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue(mockUser),
        getTokenSilently: vi.fn().mockResolvedValue("popup-token"),
      });
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const core = new AuthCore();
      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });

      // 初期化後にisAuthenticatedの戻り値を変更
      mockClient.isAuthenticated.mockResolvedValue(true);

      await core.loginWithPopup();

      expect(core.authenticated).toBe(true);
      expect(core.user).toEqual(mockUser);
      expect(core.loading).toBe(false);
    });

    it("ポップアップログインエラーを処理できる", async () => {
      const mockClient = createMockAuth0Client({
        loginWithPopup: vi.fn().mockRejectedValue(new Error("popup blocked")),
      });
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const core = new AuthCore();
      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });
      await core.loginWithPopup();

      expect(core.error).toBeInstanceOf(Error);
      expect(core.loading).toBe(false);
    });
  });

  describe("logout", () => {
    it("クライアント未初期化時にエラーをスローする", async () => {
      const core = new AuthCore();
      await expect(core.logout()).rejects.toThrow("[@wc-bindable/hawc-auth0] Auth0 client is not initialized.");
    });

    it("ログアウト後に状態をリセットする", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "auth0|123" }),
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const core = new AuthCore();
      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });

      expect(core.authenticated).toBe(true);

      await core.logout();

      expect(core.authenticated).toBe(false);
      expect(core.user).toBeNull();
      expect(core.token).toBeNull();
    });

    it("ログアウトエラーを処理できる", async () => {
      const mockClient = createMockAuth0Client({
        logout: vi.fn().mockRejectedValue(new Error("logout failed")),
      });
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const core = new AuthCore();
      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });
      await core.logout();

      expect(core.error).toBeInstanceOf(Error);
    });

    it("ログアウト成功時にerrorがクリアされる", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockRejectedValue(new Error("token error")),
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "auth0|123" }),
      });
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const core = new AuthCore();
      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });

      // getTokenで失敗させてerrorを入れる
      await core.getToken();
      expect(core.error).toBeInstanceOf(Error);

      // logoutの成功でerrorがクリアされることを確認
      await core.logout();
      expect(core.error).toBeNull();
    });
  });

  describe("getToken", () => {
    it("クライアント未初期化時にエラーをスローする", async () => {
      const core = new AuthCore();
      await expect(core.getToken()).rejects.toThrow("[@wc-bindable/hawc-auth0] Auth0 client is not initialized.");
    });

    it("アクセストークンを取得できる", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("fresh-token"),
      });
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const core = new AuthCore();
      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });
      const token = await core.getToken();

      expect(token).toBe("fresh-token");
      expect(core.token).toBe("fresh-token");
    });

    it("getTokenSilently()がundefinedを返した場合はnullになる（getToken経由）", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue(undefined),
      });
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const core = new AuthCore();
      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });
      const token = await core.getToken();

      expect(token).toBeNull();
      expect(core.token).toBeNull();
    });

    it("トークン取得エラーを処理できる", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn()
          .mockResolvedValueOnce("initial-token") // initialize時
          .mockRejectedValueOnce(new Error("token refresh failed")), // getToken時
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "auth0|123" }),
      });
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const core = new AuthCore();
      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });
      const token = await core.getToken();

      expect(token).toBeNull();
      expect(core.error).toBeInstanceOf(Error);
    });

    it("トークン取得成功時にerrorがクリアされる", async () => {
      const mockClient = createMockAuth0Client({
        loginWithPopup: vi.fn().mockRejectedValue(new Error("popup failed")),
        getTokenSilently: vi.fn().mockResolvedValue("recovered-token"),
      });
      createAuth0Client.mockResolvedValueOnce(mockClient);

      const core = new AuthCore();
      await core.initialize({ domain: "test.auth0.com", clientId: "client-id" });

      // loginWithPopupで失敗させてerrorを入れる
      await core.loginWithPopup();
      expect(core.error).toBeInstanceOf(Error);

      // getTokenの成功でerrorがクリアされることを確認
      const token = await core.getToken();
      expect(token).toBe("recovered-token");
      expect(core.error).toBeNull();
    });
  });

  describe("getTokenExpiry", () => {
    function makeJwt(payload: Record<string, unknown>): string {
      const toBase64Url = (s: string) =>
        Buffer.from(s).toString("base64")
          .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const header = toBase64Url(JSON.stringify({ alg: "RS256" }));
      const body = toBase64Url(JSON.stringify(payload));
      return `${header}.${body}.sig`;
    }

    it("no token → null", () => {
      const core = new AuthCore();
      expect(core.getTokenExpiry()).toBeNull();
    });

    it("token without exp claim → null", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "auth0|1" }),
        getTokenSilently: vi.fn().mockResolvedValue(makeJwt({ sub: "auth0|1" })),
      });
      createAuth0Client.mockResolvedValue(mockClient);
      const core = new AuthCore();
      await core.initialize({ domain: "d", clientId: "c" });
      expect(core.getTokenExpiry()).toBeNull();
    });

    it("token with exp → ms epoch", async () => {
      const expSeconds = Math.floor(Date.now() / 1000) + 300;
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "auth0|1" }),
        getTokenSilently: vi.fn().mockResolvedValue(
          makeJwt({ sub: "auth0|1", exp: expSeconds }),
        ),
      });
      createAuth0Client.mockResolvedValue(mockClient);
      const core = new AuthCore();
      await core.initialize({ domain: "d", clientId: "c" });
      expect(core.getTokenExpiry()).toBe(expSeconds * 1000);
    });

    it("malformed token → null", () => {
      const core = new AuthCore();
      (core as any)._token = "not.a.valid.jwt.at.all";
      expect(core.getTokenExpiry()).toBeNull();
    });

    it("uses Buffer fallback when atob is unavailable", () => {
      const expSeconds = Math.floor(Date.now() / 1000) + 60;
      const core = new AuthCore();
      const savedAtob = globalThis.atob;
      try {
        vi.stubGlobal("atob", undefined);
        (core as any)._token = makeJwt({ sub: "auth0|1", exp: expSeconds });
        expect(core.getTokenExpiry()).toBe(expSeconds * 1000);
      } finally {
        vi.stubGlobal("atob", savedAtob);
      }
    });

    it("decodes JWTs whose payload contains non-ASCII claims without corrupting exp", () => {
      // Regression: decoder used to return a "binary string" via atob,
      // which garbles non-ASCII code units and can break JSON.parse.
      // Read the exp claim from a JWT whose `name` is a Japanese string
      // to lock in UTF-8 round-tripping.
      const expSeconds = Math.floor(Date.now() / 1000) + 120;
      const core = new AuthCore();
      (core as any)._token = makeJwt({
        sub: "auth0|1",
        name: "山田 太郎",
        email: "太郎@例.jp",
        exp: expSeconds,
      });
      expect(core.getTokenExpiry()).toBe(expSeconds * 1000);
    });

    it("decodes non-ASCII JWT payloads under the Buffer fallback too", () => {
      const expSeconds = Math.floor(Date.now() / 1000) + 120;
      const core = new AuthCore();
      const savedAtob = globalThis.atob;
      try {
        vi.stubGlobal("atob", undefined);
        (core as any)._token = makeJwt({
          sub: "auth0|1",
          name: "山田 太郎",
          exp: expSeconds,
        });
        expect(core.getTokenExpiry()).toBe(expSeconds * 1000);
      } finally {
        vi.stubGlobal("atob", savedAtob);
      }
    });
  });

  describe("fetchToken / fetchFreshToken / commitToken", () => {
    it("fetchToken throws when called before initialize", async () => {
      const core = new AuthCore();
      await expect(core.fetchToken()).rejects.toThrow(
        "[@wc-bindable/hawc-auth0] Auth0 client is not initialized.",
      );
    });

    it("fetchToken returns null and stores the error when the SDK rejects", async () => {
      const sdkError = new Error("fetch failed");
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockRejectedValue(sdkError),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const core = new AuthCore();
      await core.initialize({ domain: "d", clientId: "c" });

      await expect(core.fetchToken()).resolves.toBeNull();
      expect(core.error).toBe(sdkError);
    });

    it("fetchFreshToken forces cacheMode off", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("fresh-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const core = new AuthCore();
      await core.initialize({ domain: "d", clientId: "c" });

      await expect(core.fetchFreshToken()).resolves.toBe("fresh-token");
      expect(mockClient.getTokenSilently).toHaveBeenLastCalledWith({ cacheMode: "off" });
    });

    it("commitToken updates token and dispatches token-changed", () => {
      const core = new AuthCore();
      const events: Array<string | null> = [];
      core.addEventListener("hawc-auth0:token-changed", (e: Event) => {
        events.push((e as CustomEvent).detail);
      });

      core.commitToken("committed-token");

      expect(core.token).toBe("committed-token");
      expect(events).toEqual(["committed-token"]);
    });
  });

  describe("getTokenExpiry", () => {
    it("returns null for malformed tokens without a payload segment", () => {
      const core = new AuthCore();

      core.commitToken("not-a-jwt");

      expect(core.getTokenExpiry()).toBeNull();
    });
  });
});
