import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { UnleashProvider } from "../src/providers/UnleashProvider";
import type { FlagIdentity } from "../src/types";

const ID_ALICE: FlagIdentity = { userId: "alice", attrs: { role: "admin" } };

interface MockInstance {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  isEnabled: ReturnType<typeof vi.fn>;
  getVariant: ReturnType<typeof vi.fn>;
  getFeatureToggleDefinitions: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  _listeners: Map<string, Array<(...args: unknown[]) => void>>;
  _emit(event: string, ...args: unknown[]): void;
}

// vi.hoisted ensures this state is initialized BEFORE the hoisted
// vi.mock() factory can close over it. Without this, vitest declines
// to hoist vi.mock (since the factory references post-import module
// state), leaving the real on-disk module to win the first resolution.
const { mockControl, buildInstance, mockFactory } = vi.hoisted(() => {
  interface MI {
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    isEnabled: ReturnType<typeof vi.fn>;
    getVariant: ReturnType<typeof vi.fn>;
    getFeatureToggleDefinitions: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    _listeners: Map<string, Array<(...args: unknown[]) => void>>;
    _emit(event: string, ...args: unknown[]): void;
  }
  const control: {
    constructor: ReturnType<typeof vi.fn>;
    instance: MI | null;
    autoReady: boolean;
    autoReadyError: unknown | null;
  } = {
    constructor: vi.fn(),
    instance: null,
    autoReady: true,
    autoReadyError: null,
  };
  const build = (): MI => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const inst: MI = {
      _listeners: listeners,
      _emit(event, ...args) {
        for (const l of listeners.get(event) ?? []) l(...args);
      },
      on: vi.fn((event: string, fn: (...a: unknown[]) => void) => {
        const bucket = listeners.get(event) ?? [];
        bucket.push(fn);
        listeners.set(event, bucket);
        if (event === "ready" && control.autoReady && !control.autoReadyError) {
          queueMicrotask(() => fn());
        }
        if (event === "error" && control.autoReadyError) {
          queueMicrotask(() => fn(control.autoReadyError));
        }
        return inst;
      }),
      off: vi.fn((event: string, fn: (...a: unknown[]) => void) => {
        const bucket = listeners.get(event) ?? [];
        listeners.set(event, bucket.filter((l) => l !== fn));
        return inst;
      }),
      isEnabled: vi.fn(() => false),
      getVariant: vi.fn(() => ({ name: "disabled", enabled: false })),
      getFeatureToggleDefinitions: vi.fn(() => []),
      destroy: vi.fn(),
    };
    return inst;
  };
  const factory = (): Record<string, unknown> => ({
    initialize: (opts: unknown) => {
      control.constructor(opts);
      // Reuse a test-preconfigured instance when provided (by beforeEach)
      // so tests can stub `isEnabled` / `getFeatureToggleDefinitions`
      // BEFORE calling `identify()`. Fall back to a fresh instance for
      // tests that did not preconfigure (e.g. tests that do not care
      // about evaluation results).
      if (!control.instance) control.instance = build();
      return control.instance;
    },
  });
  return { mockControl: control, buildInstance: build, mockFactory: factory };
});

vi.mock("unleash-client", mockFactory);

function configureDefaultToggles(): void {
  mockControl.instance!.getFeatureToggleDefinitions.mockReturnValue([
    { name: "new_checkout" },
    { name: "beta_nav" },
  ]);
  mockControl.instance!.isEnabled.mockImplementation((name: string) => name === "new_checkout");
  mockControl.instance!.getVariant.mockImplementation((name: string) => {
    if (name === "new_checkout") return { name: "disabled", enabled: false };
    return { name: "disabled", enabled: false };
  });
}

describe("UnleashProvider", () => {
  beforeEach(() => {
    mockControl.constructor.mockReset();
    mockControl.autoReady = true;
    mockControl.autoReadyError = null;
    // Pre-build a fresh instance so tests can configure
    // `isEnabled` / `getFeatureToggleDefinitions` / variants BEFORE
    // calling `identify()` — the factory reuses this preconfigured
    // instance instead of constructing a fresh one at init time.
    mockControl.instance = buildInstance();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockControl.instance = null;
  });

  describe("construction", () => {
    it("throws without url", () => {
      expect(() => new UnleashProvider({ url: "", appName: "app" })).toThrow(/url/);
    });

    it("throws without appName", () => {
      expect(() => new UnleashProvider({ url: "http://u", appName: "" })).toThrow(/appName/);
    });

    it("does not touch the SDK until first use", () => {
      new UnleashProvider({ url: "http://u", appName: "app" });
      expect(mockControl.constructor).not.toHaveBeenCalled();
    });
  });

  describe("identify", () => {
    it("returns the evaluated flag map shaped as { enabled, value }", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      // Defer toggles to be configured once the instance exists.
      const identifyPromise = p.identify(ID_ALICE);
      await Promise.resolve();
      configureDefaultToggles();
      // Variant-enabled toggle → value from payload
      mockControl.instance!.getVariant.mockImplementation((name: string) => {
        if (name === "new_checkout") {
          return { name: "layout_v2", enabled: true, payload: { type: "string", value: "rich" } };
        }
        return { name: "disabled", enabled: false };
      });
      const map = await identifyPromise;
      expect(map).toEqual({
        new_checkout: { enabled: true, value: "rich" },
        beta_nav: { enabled: false, value: null },
      });
      expect(Object.isFrozen(map)).toBe(true);
    });

    it("falls back to the variant name when no payload is provided", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      const ident = p.identify(ID_ALICE);
      await Promise.resolve();
      mockControl.instance!.getFeatureToggleDefinitions.mockReturnValue([{ name: "exp" }]);
      mockControl.instance!.isEnabled.mockReturnValue(true);
      mockControl.instance!.getVariant.mockReturnValue({ name: "bucket_B", enabled: true });
      const map = await ident;
      expect(map).toEqual({ exp: { enabled: true, value: "bucket_B" } });
    });

    it("produces value=null when the toggle is disabled", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      const ident = p.identify(ID_ALICE);
      await Promise.resolve();
      mockControl.instance!.getFeatureToggleDefinitions.mockReturnValue([{ name: "off" }]);
      mockControl.instance!.isEnabled.mockReturnValue(false);
      const map = await ident;
      expect(map).toEqual({ off: { enabled: false, value: null } });
    });

    it("parses payload.type === 'json' into a structured value", async () => {
      // Unleash JSON-typed payloads arrive on the wire as strings. Publishing
      // the raw string forces every consumer to re-parse; surface the parsed
      // structure directly so `values.flags.X.value.<path>` is usable.
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      const ident = p.identify(ID_ALICE);
      await Promise.resolve();
      mockControl.instance!.getFeatureToggleDefinitions.mockReturnValue([{ name: "cfg" }]);
      mockControl.instance!.isEnabled.mockReturnValue(true);
      mockControl.instance!.getVariant.mockReturnValue({
        name: "layout_v2",
        enabled: true,
        payload: { type: "json", value: '{"limit":42,"features":["a","b"]}' },
      });
      const map = await ident;
      expect(map).toEqual({
        cfg: {
          enabled: true,
          value: { limit: 42, features: ["a", "b"] },
        },
      });
    });

    it("falls back to the raw string when a json payload fails to parse", async () => {
      // A malformed JSON payload from the upstream is a vendor-side
      // data issue — surface the raw string so consumers can observe
      // and diagnose, rather than silently collapsing to null.
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      const ident = p.identify(ID_ALICE);
      await Promise.resolve();
      mockControl.instance!.getFeatureToggleDefinitions.mockReturnValue([{ name: "cfg" }]);
      mockControl.instance!.isEnabled.mockReturnValue(true);
      mockControl.instance!.getVariant.mockReturnValue({
        name: "layout_v2",
        enabled: true,
        payload: { type: "json", value: "{not valid json" },
      });
      const map = await ident;
      expect(map).toEqual({
        cfg: { enabled: true, value: "{not valid json" },
      });
    });

    it("keeps non-json payload types as raw strings", async () => {
      // `"string"` / `"number"` / `"csv"` payloads are all delivered
      // as strings on Unleash's wire; auto-coercing would surprise
      // consumers expecting the documented native type of the variant.
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      const ident = p.identify(ID_ALICE);
      await Promise.resolve();
      mockControl.instance!.getFeatureToggleDefinitions.mockReturnValue([{ name: "num" }]);
      mockControl.instance!.isEnabled.mockReturnValue(true);
      mockControl.instance!.getVariant.mockReturnValue({
        name: "v1",
        enabled: true,
        payload: { type: "number", value: "42" },
      });
      const map = await ident;
      expect(map).toEqual({ num: { enabled: true, value: "42" } });
    });

    it("produces value=null when the variant is disabled (multivariate miss)", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      const ident = p.identify(ID_ALICE);
      await Promise.resolve();
      mockControl.instance!.getFeatureToggleDefinitions.mockReturnValue([{ name: "mv" }]);
      mockControl.instance!.isEnabled.mockReturnValue(true);
      mockControl.instance!.getVariant.mockReturnValue({ name: "disabled", enabled: false });
      const map = await ident;
      expect(map).toEqual({ mv: { enabled: true, value: null } });
    });

    it("respects toggleFilter", async () => {
      const p = new UnleashProvider({
        url: "http://u", appName: "app",
        toggleFilter: (name) => name.startsWith("public_"),
      });
      const ident = p.identify(ID_ALICE);
      await Promise.resolve();
      mockControl.instance!.getFeatureToggleDefinitions.mockReturnValue([
        { name: "public_nav" },
        { name: "internal_admin" },
      ]);
      mockControl.instance!.isEnabled.mockReturnValue(false);
      const map = await ident;
      expect(Object.keys(map)).toEqual(["public_nav"]);
    });

    it("rejects when the SDK emits an error before ready", async () => {
      mockControl.autoReady = false;
      mockControl.autoReadyError = new Error("upstream dead");
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await expect(p.identify(ID_ALICE)).rejects.toThrow(/upstream dead/);
    });

    it("wraps non-Error SDK errors", async () => {
      mockControl.autoReady = false;
      mockControl.autoReadyError = "string-error";
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await expect(p.identify(ID_ALICE)).rejects.toThrow(/string-error/);
    });

    it("a subsequent identify after a failed init can retry", async () => {
      mockControl.autoReady = false;
      mockControl.autoReadyError = new Error("transient");
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await expect(p.identify(ID_ALICE)).rejects.toThrow(/transient/);

      // Provider recovers — fresh _getClient() retries.
      mockControl.autoReady = true;
      mockControl.autoReadyError = null;
      const ident = p.identify(ID_ALICE);
      await Promise.resolve();
      mockControl.instance!.getFeatureToggleDefinitions.mockReturnValue([{ name: "ok" }]);
      const map = await ident;
      expect(map).toEqual({ ok: { enabled: false, value: null } });
    });

    it("tears down the half-initialized SDK client when `ready` rejects", async () => {
      // Previously, an init-time error left the SDK client alive with
      // its ready/error listeners still attached and its background
      // polling / metrics loops still running — one leaked SDK instance
      // per failed retry. Verify the cleanup path detaches listeners
      // and calls destroy().
      mockControl.autoReady = false;
      mockControl.autoReadyError = new Error("upstream down");
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      const clientBefore = mockControl.instance!;
      await expect(p.identify(ID_ALICE)).rejects.toThrow(/upstream down/);
      expect(clientBefore.off).toHaveBeenCalledWith("ready", expect.any(Function));
      expect(clientBefore.off).toHaveBeenCalledWith("error", expect.any(Function));
      expect(clientBefore.destroy).toHaveBeenCalledTimes(1);
    });

    it("cleanup path tolerates a throwing destroy() on init failure", async () => {
      mockControl.autoReady = false;
      mockControl.autoReadyError = new Error("upstream down");
      mockControl.instance!.destroy.mockImplementation(() => { throw new Error("destroy-bang"); });
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      // The original init error must win; destroy failure is swallowed.
      await expect(p.identify(ID_ALICE)).rejects.toThrow(/upstream down/);
    });

    it("cleanup path tolerates a throwing off() on init failure", async () => {
      mockControl.autoReady = false;
      mockControl.autoReadyError = new Error("upstream down");
      mockControl.instance!.off.mockImplementation(() => { throw new Error("off-bang"); });
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await expect(p.identify(ID_ALICE)).rejects.toThrow(/upstream down/);
    });

    it("cleanup on init failure works when the SDK has no destroy() method", async () => {
      mockControl.autoReady = false;
      mockControl.autoReadyError = new Error("upstream down");
      (mockControl.instance as unknown as Record<string, unknown>).destroy = undefined;
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await expect(p.identify(ID_ALICE)).rejects.toThrow(/upstream down/);
    });

    it("cleanup on init failure works when the SDK has no off() method", async () => {
      // Older Unleash SDK versions may lack `off()`. Cleanup must
      // skip the detach path cleanly and still surface the init
      // error to the caller.
      mockControl.autoReady = false;
      mockControl.autoReadyError = new Error("upstream down");
      (mockControl.instance as unknown as Record<string, unknown>).off = undefined;
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await expect(p.identify(ID_ALICE)).rejects.toThrow(/upstream down/);
    });

    it("dispose mid-init tears down the freshly-built client before it commits", async () => {
      // Regression: dispose() that lands while `_getClient()` is
      // awaiting `ready` (or `import`) saw `_client === null` and
      // skipped cleanup, but the in-flight IIFE then committed the
      // SDK client onto a Provider already marked disposed — leaking
      // polling / metrics / listeners forever.
      mockControl.autoReady = false;
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      const identifyPromise = p.identify(ID_ALICE);
      identifyPromise.catch(() => {});

      // Wait until the IIFE has progressed through the dynamic
      // `import("unleash-client")` and registered the ready listener
      // on the SDK client. Under vitest's ESM mock loader the import
      // resolves across macrotask boundaries, so poll with a
      // macrotask yield rather than a fixed microtask count.
      const client = await vi.waitFor(() => {
        const c = mockControl.instance!;
        if ((c._listeners.get("ready")?.length ?? 0) === 0) {
          throw new Error("ready listener not yet registered");
        }
        return c;
      }, { timeout: 2000, interval: 5 });
      expect(client.destroy).not.toHaveBeenCalled();

      // Dispose while init is still waiting on ready.
      const disposePromise = p.dispose();

      // Now unblock the init: fire ready manually. The disposed
      // re-check inside the IIFE should throw, and the catch path
      // should call destroy() on the doomed client.
      client._emit("ready");

      await expect(identifyPromise).rejects.toThrow(/disposed during initialization/);
      await disposePromise;
      expect(client.destroy).toHaveBeenCalledTimes(1);
    });

    it("dispose mid-init does not leak the `changed` listener", async () => {
      // Same race as above, but tightened on the observation that
      // `changed` is attached AFTER the disposed re-check and MUST
      // remain unattached when the race fires.
      mockControl.autoReady = false;
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      const identifyPromise = p.identify(ID_ALICE);
      identifyPromise.catch(() => {});
      const client = await vi.waitFor(() => {
        const c = mockControl.instance!;
        if ((c._listeners.get("ready")?.length ?? 0) === 0) {
          throw new Error("ready listener not yet registered");
        }
        return c;
      }, { timeout: 2000, interval: 5 });
      const disposePromise = p.dispose();
      client._emit("ready");
      await expect(identifyPromise).rejects.toThrow(/disposed during initialization/);
      await disposePromise;
      expect(client.on.mock.calls.map((c: unknown[]) => c[0])).not.toContain("changed");
    });

    it("ready/error listeners are detached on SUCCESS once settled", async () => {
      // Leaner dispatch map across the client's lifetime: the one-shot
      // ready/error listeners must be off() once we've committed the
      // client. This is not a leak (the client lives on) but the event
      // bus should not keep dispatching no-op listeners on every tick.
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await p.identify(ID_ALICE);
      const inst = mockControl.instance!;
      const offCalls = inst.off.mock.calls.map((c: unknown[]) => c[0]);
      expect(offCalls).toContain("ready");
      expect(offCalls).toContain("error");
    });

    it("coalesces concurrent first-time calls onto a single SDK init", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await Promise.all([p.identify(ID_ALICE), p.identify(ID_ALICE)]);
      expect(mockControl.constructor).toHaveBeenCalledTimes(1);
    });
  });

  describe("context mapping", () => {
    it("default mapping stringifies attrs into properties", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app", environment: "prod" });
      const ident = p.identify({
        userId: "alice",
        attrs: {
          email: "a@x",
          orgId: 42,
          permissions: ["read", "write"],
          nested: { k: "v" },
          nil: null,
          gone: undefined,
        },
      });
      await Promise.resolve();
      mockControl.instance!.getFeatureToggleDefinitions.mockReturnValue([{ name: "x" }]);
      mockControl.instance!.isEnabled.mockReturnValue(false);
      await ident;
      const ctx = mockControl.instance!.isEnabled.mock.calls[0][1] as any;
      expect(ctx.userId).toBe("alice");
      expect(ctx.environment).toBe("prod");
      expect(ctx.properties).toEqual({
        email: "a@x",
        orgId: "42",
        permissions: "read,write",
        nested: '{"k":"v"}',
      });
    });

    it("nested arrays are JSON-stringified element-wise", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      const ident = p.identify({
        userId: "alice",
        attrs: { payloads: [{ a: 1 }, { b: 2 }] },
      });
      await Promise.resolve();
      mockControl.instance!.getFeatureToggleDefinitions.mockReturnValue([{ name: "x" }]);
      mockControl.instance!.isEnabled.mockReturnValue(false);
      await ident;
      const ctx = mockControl.instance!.isEnabled.mock.calls[0][1] as any;
      expect(ctx.properties.payloads).toBe('{"a":1},{"b":2}');
    });

    it("drops function / symbol attrs rather than stringifying them", async () => {
      // Regression guard for [R3-05]: the pre-fix `String(v)` catch-all
      // stringified functions (emitting their full source into the
      // upstream context — information leak) and Symbols (`Symbol(desc)`).
      // Aligned with FlagsmithProvider's trait sanitizer: only
      // string / number / boolean / bigint primitives fall through;
      // exotic types are dropped outright. Booleans and bigints must
      // still stringify so covered targeting rules keep working.
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      const ident = p.identify({
        userId: "alice",
        attrs: {
          active: true,
          count: 10n,
          handler: () => "nope",
          tag: Symbol("no-thanks"),
        },
      });
      await Promise.resolve();
      mockControl.instance!.getFeatureToggleDefinitions.mockReturnValue([{ name: "x" }]);
      mockControl.instance!.isEnabled.mockReturnValue(false);
      await ident;
      const ctx = mockControl.instance!.isEnabled.mock.calls[0][1] as any;
      expect(ctx.properties).toEqual({
        active: "true",
        count: "10",
      });
    });

    it("contextBuilder option replaces the default mapper", async () => {
      const p = new UnleashProvider({
        url: "http://u", appName: "app",
        contextBuilder: (id) => ({
          userId: id.userId.toUpperCase(),
          sessionId: "sess-1",
          properties: { custom: "yes" },
        }),
      });
      const ident = p.identify(ID_ALICE);
      await Promise.resolve();
      mockControl.instance!.getFeatureToggleDefinitions.mockReturnValue([{ name: "x" }]);
      mockControl.instance!.isEnabled.mockReturnValue(false);
      await ident;
      const ctx = mockControl.instance!.isEnabled.mock.calls[0][1] as any;
      expect(ctx.userId).toBe("ALICE");
      expect(ctx.sessionId).toBe("sess-1");
      expect(ctx.properties).toEqual({ custom: "yes" });
    });
  });

  describe("SDK options", () => {
    it("forwards refreshInterval / metricsInterval / environment etc. to initialize()", async () => {
      const fn = async (): Promise<Record<string, string>> => ({ X: "y" });
      const p = new UnleashProvider({
        url: "http://u", appName: "app",
        instanceId: "inst-1",
        environment: "staging",
        refreshInterval: 5000,
        metricsInterval: 30000,
        disableMetrics: true,
        customHeadersFunction: fn,
      });
      await p.identify(ID_ALICE);
      expect(mockControl.constructor).toHaveBeenCalledWith(expect.objectContaining({
        url: "http://u",
        appName: "app",
        instanceId: "inst-1",
        environment: "staging",
        refreshInterval: 5000,
        metricsInterval: 30000,
        disableMetrics: true,
        customHeadersFunction: fn,
      }));
    });

    it("maps clientKey onto customHeaders.Authorization", async () => {
      const p = new UnleashProvider({
        url: "http://u", appName: "app",
        clientKey: "secret-token",
        customHeaders: { Trace: "abc" },
      });
      await p.identify(ID_ALICE);
      expect(mockControl.constructor.mock.calls[0][0].customHeaders).toEqual({
        Trace: "abc",
        Authorization: "secret-token",
      });
    });

    it("omits customHeaders when neither clientKey nor customHeaders is supplied", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await p.identify(ID_ALICE);
      expect(mockControl.constructor.mock.calls[0][0].customHeaders).toBeUndefined();
    });
  });

  describe("subscribe (event-driven fan-out)", () => {
    it("fires onChange on the SDK's `changed` event when content differs from the initial", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      const initial = await p.identify(ID_ALICE);
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => received.push(n), initial);

      // Simulate upstream toggle change
      mockControl.instance!.getFeatureToggleDefinitions.mockReturnValue([{ name: "new" }]);
      mockControl.instance!.isEnabled.mockReturnValue(true);
      mockControl.instance!.getVariant.mockReturnValue({ name: "disabled", enabled: false });
      mockControl.instance!._emit("changed");
      expect(received).toHaveLength(1);
      expect((received[0] as Record<string, unknown>).new).toEqual({ enabled: true, value: null });
    });

    it("stays silent on a `changed` event where content is unchanged from the initial", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      const ident = p.identify(ID_ALICE);
      await Promise.resolve();
      mockControl.instance!.getFeatureToggleDefinitions.mockReturnValue([{ name: "same" }]);
      mockControl.instance!.isEnabled.mockReturnValue(false);
      const initial = await ident;
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => received.push(n), initial);
      // Same toggle state — changed event is a no-op.
      mockControl.instance!._emit("changed");
      expect(received).toHaveLength(0);
    });

    it("without initial, the first `changed` acts as the initial push", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await p.identify(ID_ALICE);
      mockControl.instance!.getFeatureToggleDefinitions.mockReturnValue([{ name: "a" }]);
      mockControl.instance!.isEnabled.mockReturnValue(false);
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => received.push(n));
      mockControl.instance!._emit("changed");
      expect(received).toHaveLength(1);
    });

    it("multiple subscribers for the same identity share one bucket + fan-out", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      const initial = await p.identify(ID_ALICE);
      const a: unknown[] = [];
      const b: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => a.push(n), initial);
      p.subscribe(ID_ALICE, (n) => b.push(n), initial);
      mockControl.instance!.getFeatureToggleDefinitions.mockReturnValue([{ name: "x" }]);
      mockControl.instance!.isEnabled.mockReturnValue(true);
      mockControl.instance!._emit("changed");
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    it("distinct identities do not share a bucket", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      const initial = await p.identify(ID_ALICE);
      const bReceived: unknown[] = [];
      p.subscribe({ userId: "bob" }, (n) => bReceived.push(n), initial);
      // Bob's bucket was seeded with the same initial, so a `changed`
      // that yields the same evaluation stays silent across identities.
      mockControl.instance!._emit("changed");
      expect(bReceived).toHaveLength(0);

      // But a content change propagates to any bucket that observes it.
      mockControl.instance!.getFeatureToggleDefinitions.mockReturnValue([{ name: "n" }]);
      mockControl.instance!.isEnabled.mockReturnValue(true);
      mockControl.instance!._emit("changed");
      expect(bReceived).toHaveLength(1);
    });

    it("N subscribes with the SAME onChange reference yield N independent unsubs", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await p.identify(ID_ALICE);
      let hits = 0;
      const onChange = (): void => { hits++; };
      const unsub1 = p.subscribe(ID_ALICE, onChange);
      const unsub2 = p.subscribe(ID_ALICE, onChange);

      mockControl.instance!.getFeatureToggleDefinitions.mockReturnValue([{ name: "a" }]);
      mockControl.instance!.isEnabled.mockReturnValue(true);
      mockControl.instance!._emit("changed");
      expect(hits).toBe(2);

      unsub1();
      mockControl.instance!.isEnabled.mockReturnValue(false);
      mockControl.instance!._emit("changed");
      expect(hits).toBe(3);  // only the surviving entry

      unsub2();
      mockControl.instance!.isEnabled.mockReturnValue(true);
      mockControl.instance!._emit("changed");
      expect(hits).toBe(3);  // no subscribers left
    });

    it("unsubscribe twice is a no-op", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await p.identify(ID_ALICE);
      const unsub = p.subscribe(ID_ALICE, () => {});
      unsub();
      expect(() => unsub()).not.toThrow();
    });

    it("re-calling a spent unsub while the bucket still has peers is a no-op", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await p.identify(ID_ALICE);
      const unsubA = p.subscribe(ID_ALICE, () => {});
      p.subscribe(ID_ALICE, () => {});
      unsubA();
      expect(() => unsubA()).not.toThrow();
    });

    it("a late subscriber's initial never overwrites an existing bucket's baseline", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      const initial = await p.identify(ID_ALICE);
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => received.push(n), initial);

      // Late subscriber arrives with a different initial — must not
      // roll the baseline; next changed compared to the ORIGINAL seed.
      p.subscribe(ID_ALICE, () => {}, { foreign: { enabled: true, value: null } });

      mockControl.instance!.getFeatureToggleDefinitions.mockReturnValue([{ name: "n" }]);
      mockControl.instance!.isEnabled.mockReturnValue(true);
      mockControl.instance!._emit("changed");
      expect(received).toHaveLength(1);  // fired against the original seed
    });

    it("a `changed` event with no active buckets is a no-op", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await p.identify(ID_ALICE);
      // No subscribe — buckets map is empty. The SDK's `changed`
      // should fire cleanly with nothing to fan out to.
      expect(() => mockControl.instance!._emit("changed")).not.toThrow();
    });

    it("subscribe without prior identify fails without _getClient being called", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      // The Provider contract says subscribe does NOT fetch; it lives
      // off the SDK's existing change stream. Verify that the SDK
      // constructor hasn't been invoked yet.
      p.subscribe(ID_ALICE, () => {});
      expect(mockControl.constructor).not.toHaveBeenCalled();
    });

    it("subscribe throws after dispose", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await p.identify(ID_ALICE);
      await p.dispose();
      expect(() => p.subscribe(ID_ALICE, () => {})).toThrow(/disposed/);
    });
  });

  describe("reload", () => {
    it("re-evaluates against the SDK's current cache and updates the bucket baseline", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      const initial = await p.identify(ID_ALICE);
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => received.push(n), initial);

      // External reload picks up fresher cache.
      mockControl.instance!.getFeatureToggleDefinitions.mockReturnValue([{ name: "fresh" }]);
      mockControl.instance!.isEnabled.mockReturnValue(true);
      const reloaded = await p.reload(ID_ALICE);
      expect(reloaded).toEqual({ fresh: { enabled: true, value: null } });

      // A same-content `changed` now sees the updated baseline and stays silent.
      mockControl.instance!._emit("changed");
      expect(received).toHaveLength(0);
    });

    it("reload without an active bucket just returns the current evaluation", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      mockControl.autoReady = true;
      const reloaded = await p.reload(ID_ALICE);
      expect(reloaded).toEqual({});
    });
  });

  describe("dispose", () => {
    it("removes the changed listener, calls destroy, clears buckets", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await p.identify(ID_ALICE);
      p.subscribe(ID_ALICE, () => {});
      const inst = mockControl.instance!;
      await p.dispose();
      expect(inst.off).toHaveBeenCalledWith("changed", expect.any(Function));
      expect(inst.destroy).toHaveBeenCalledTimes(1);
    });

    it("tolerates a throwing destroy()", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await p.identify(ID_ALICE);
      mockControl.instance!.destroy.mockImplementation(() => { throw new Error("dust"); });
      await expect(p.dispose()).resolves.toBeUndefined();
    });

    it("tolerates a throwing off()", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await p.identify(ID_ALICE);
      mockControl.instance!.off.mockImplementation(() => { throw new Error("off-bang"); });
      await expect(p.dispose()).resolves.toBeUndefined();
    });

    it("no-op when no client was ever built", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await expect(p.dispose()).resolves.toBeUndefined();
    });

    it("works when the SDK lacks destroy() entirely", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await p.identify(ID_ALICE);
      // Simulate an SDK version that doesn't expose destroy
      (mockControl.instance as unknown as Record<string, unknown>).destroy = undefined;
      await expect(p.dispose()).resolves.toBeUndefined();
    });

    it("works when the SDK lacks off() entirely", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await p.identify(ID_ALICE);
      (mockControl.instance as unknown as Record<string, unknown>).off = undefined;
      await expect(p.dispose()).resolves.toBeUndefined();
    });

    it("second dispose is a no-op", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await p.identify(ID_ALICE);
      await p.dispose();
      const beforeCalls = mockControl.instance!.destroy.mock.calls.length;
      await p.dispose();
      expect(mockControl.instance!.destroy.mock.calls.length).toBe(beforeCalls);
    });

    it("identify after dispose throws", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      await p.dispose();
      await expect(p.identify(ID_ALICE)).rejects.toThrow(/disposed/);
    });

    it("a `changed` event that fires after dispose is silently ignored", async () => {
      const p = new UnleashProvider({ url: "http://u", appName: "app" });
      const initial = await p.identify(ID_ALICE);
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => received.push(n), initial);
      const inst = mockControl.instance!;
      // Capture the listener before dispose runs so we can re-emit it.
      const listener = (inst._listeners.get("changed") ?? [])[0];
      await p.dispose();
      // Emit post-dispose — provider is torn down but listener ref
      // might still be reachable via a closure (defensive path).
      listener?.();
      expect(received).toHaveLength(0);
    });
  });
});
