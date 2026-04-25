import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LaunchDarklyProvider } from "../src/providers/LaunchDarklyProvider";
import type { FlagIdentity } from "../src/types";

const ID_ALICE: FlagIdentity = { userId: "alice", attrs: { role: "admin" } };

// vi.hoisted mirrors UnleashProvider.test.ts — the factory closes over
// this state and vitest must see it hoisted above imports so the mock
// beats the physical module (absent or not) in resolution.
const { mockControl, buildInstance, mockFactory } = vi.hoisted(() => {
  interface MI {
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    waitForInitialization: ReturnType<typeof vi.fn>;
    allFlagsState: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    _listeners: Map<string, Array<(...args: unknown[]) => void>>;
    _emit(event: string, ...args: unknown[]): void;
  }
  const control: {
    init: ReturnType<typeof vi.fn>;
    instance: MI | null;
    /** Values returned by the next allFlagsState() call. */
    values: Record<string, unknown>;
    /** If set, replaces the default waitForInitialization resolution. */
    initBehavior: "resolve" | "reject" | "pending";
    initRejectReason: unknown;
    /** If set, each allFlagsState call awaits this before resolving. */
    evalGate: Promise<void> | null;
    /** If set, each allFlagsState call throws instead of resolving. */
    evalError: unknown | null;
  } = {
    init: vi.fn(),
    instance: null,
    values: {},
    initBehavior: "resolve",
    initRejectReason: null,
    evalGate: null,
    evalError: null,
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
        return inst;
      }),
      off: vi.fn((event: string, fn: (...a: unknown[]) => void) => {
        const bucket = listeners.get(event) ?? [];
        listeners.set(event, bucket.filter((l) => l !== fn));
        return inst;
      }),
      waitForInitialization: vi.fn(() => {
        if (control.initBehavior === "reject") {
          return Promise.reject(
            control.initRejectReason instanceof Error
              ? control.initRejectReason
              : new Error(String(control.initRejectReason)),
          );
        }
        if (control.initBehavior === "pending") {
          return new Promise(() => {
            /* never resolves until the test swaps initBehavior and emits manually */
          });
        }
        return Promise.resolve(inst);
      }),
      allFlagsState: vi.fn(async () => {
        if (control.evalGate) await control.evalGate;
        if (control.evalError) {
          throw control.evalError instanceof Error
            ? control.evalError
            : new Error(String(control.evalError));
        }
        const snapshot = { ...control.values };
        return {
          allValues: () => snapshot,
        };
      }),
      close: vi.fn(async () => {}),
    };
    return inst;
  };
  const factory = (): Record<string, unknown> => ({
    init: (sdkKey: string, opts: unknown) => {
      control.init(sdkKey, opts);
      if (!control.instance) control.instance = build();
      return control.instance;
    },
  });
  return { mockControl: control, buildInstance: build, mockFactory: factory };
});

vi.mock("@launchdarkly/node-server-sdk", mockFactory);

describe("LaunchDarklyProvider", () => {
  beforeEach(() => {
    mockControl.init.mockReset();
    mockControl.instance = buildInstance();
    mockControl.values = {};
    mockControl.initBehavior = "resolve";
    mockControl.initRejectReason = null;
    mockControl.evalGate = null;
    mockControl.evalError = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockControl.instance = null;
  });

  describe("construction", () => {
    it("throws without sdkKey", () => {
      expect(() => new LaunchDarklyProvider({ sdkKey: "" })).toThrow(/sdkKey/);
    });

    it("throws when options is missing entirely", () => {
      expect(() => new LaunchDarklyProvider(undefined as never)).toThrow(/sdkKey/);
    });

    it("does not touch the SDK until first use", () => {
      new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      expect(mockControl.init).not.toHaveBeenCalled();
    });

    it("throws when contextKind is \"multi\"", () => {
      // `"multi"` is reserved for multi-kind roots. The default builder
      // would otherwise silently produce an invalid single-kind
      // context, so we reject at construction rather than letting the
      // LD SDK surface an opaque error downstream.
      expect(() => new LaunchDarklyProvider({ sdkKey: "sdk-1", contextKind: "multi" })).toThrow(/multi/);
    });
  });

  describe("identify", () => {
    it("wraps boolean values by default (boolean → {enabled: v, value: v})", async () => {
      mockControl.values = { on: true, off: false };
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      const map = await p.identify(ID_ALICE);
      expect(map).toEqual({
        on: { enabled: true, value: true },
        off: { enabled: false, value: false },
      });
      expect(Object.isFrozen(map)).toBe(true);
    });

    it("wraps non-boolean values as {enabled: true, value} by default", async () => {
      mockControl.values = { text: "hi", count: 3, cfg: { k: 1 } };
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      const map = await p.identify(ID_ALICE);
      expect(map).toEqual({
        text: { enabled: true, value: "hi" },
        count: { enabled: true, value: 3 },
        cfg: { enabled: true, value: { k: 1 } },
      });
    });

    it("wraps null/undefined as {enabled: false, value: null} by default", async () => {
      mockControl.values = { gone: null, absent: undefined };
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      const map = await p.identify(ID_ALICE);
      expect(map).toEqual({
        gone: { enabled: false, value: null },
        absent: { enabled: false, value: null },
      });
    });

    it("returns raw native values when valueShape is 'raw'", async () => {
      mockControl.values = {
        new_checkout: true,
        cta_text: "Buy now",
        max_items: 5,
        theme: { color: "blue" },
      };
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1", valueShape: "raw" });
      const map = await p.identify(ID_ALICE);
      expect(map).toEqual({
        new_checkout: true,
        cta_text: "Buy now",
        max_items: 5,
        theme: { color: "blue" },
      });
    });

    it("respects flagFilter", async () => {
      mockControl.values = { public_nav: true, internal_admin: true };
      const p = new LaunchDarklyProvider({
        sdkKey: "sdk-1",
        flagFilter: (name) => name.startsWith("public_"),
      });
      const map = await p.identify(ID_ALICE);
      expect(Object.keys(map)).toEqual(["public_nav"]);
    });

    it("forwards clientSideOnly into allFlagsState options", async () => {
      mockControl.values = { x: true };
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1", clientSideOnly: true });
      await p.identify(ID_ALICE);
      const callArgs = mockControl.instance!.allFlagsState.mock.calls[0];
      expect(callArgs[1]).toEqual({ clientSideOnly: true });
    });

    it("omits the options argument when clientSideOnly is not set", async () => {
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await p.identify(ID_ALICE);
      const callArgs = mockControl.instance!.allFlagsState.mock.calls[0];
      expect(callArgs[1]).toBeUndefined();
    });

    it("handles a FlagsState without allValues()", async () => {
      // Old/unexpected SDK shapes may not expose allValues(); treat as
      // empty rather than throwing.
      mockControl.instance!.allFlagsState = vi.fn(async () => ({})) as unknown as typeof mockControl.instance.allFlagsState;
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      const map = await p.identify(ID_ALICE);
      expect(map).toEqual({});
    });

    it("rejects when waitForInitialization rejects", async () => {
      mockControl.initBehavior = "reject";
      mockControl.initRejectReason = new Error("upstream dead");
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await expect(p.identify(ID_ALICE)).rejects.toThrow(/upstream dead/);
    });

    it("wraps non-Error init rejections", async () => {
      mockControl.initBehavior = "reject";
      mockControl.initRejectReason = "string-error";
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await expect(p.identify(ID_ALICE)).rejects.toThrow(/string-error/);
    });

    it("a subsequent identify after a failed init can retry", async () => {
      mockControl.initBehavior = "reject";
      mockControl.initRejectReason = new Error("transient");
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await expect(p.identify(ID_ALICE)).rejects.toThrow(/transient/);

      mockControl.initBehavior = "resolve";
      mockControl.values = { ok: true };
      const map = await p.identify(ID_ALICE);
      expect(map).toEqual({ ok: { enabled: true, value: true } });
    });

    it("tears down the half-initialized SDK client when init rejects", async () => {
      mockControl.initBehavior = "reject";
      mockControl.initRejectReason = new Error("upstream down");
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      const clientBefore = mockControl.instance!;
      await expect(p.identify(ID_ALICE)).rejects.toThrow(/upstream down/);
      expect(clientBefore.close).toHaveBeenCalledTimes(1);
    });

    it("cleanup path tolerates a throwing close() on init failure", async () => {
      mockControl.initBehavior = "reject";
      mockControl.initRejectReason = new Error("upstream down");
      mockControl.instance!.close.mockImplementation(() => {
        throw new Error("close-bang");
      });
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await expect(p.identify(ID_ALICE)).rejects.toThrow(/upstream down/);
    });

    it("cleanup on init failure works when the SDK has no close() method", async () => {
      mockControl.initBehavior = "reject";
      mockControl.initRejectReason = new Error("upstream down");
      (mockControl.instance as unknown as Record<string, unknown>).close = undefined;
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await expect(p.identify(ID_ALICE)).rejects.toThrow(/upstream down/);
    });

    it("skips waitForInitialization when SDK lacks it", async () => {
      (mockControl.instance as unknown as Record<string, unknown>).waitForInitialization = undefined;
      mockControl.values = { ok: true };
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      const map = await p.identify(ID_ALICE);
      expect(map).toEqual({ ok: { enabled: true, value: true } });
    });

    it("dispose mid-init throws `disposed during initialization` and tears down", async () => {
      // Replace waitForInitialization with a deferred we control
      // directly, so we can dispose() and THEN resolve to hit the
      // disposed re-check branch.
      let resolveInit: () => void = () => {};
      mockControl.instance!.waitForInitialization = vi.fn(
        () => new Promise<void>((res) => { resolveInit = res; }),
      ) as unknown as typeof mockControl.instance.waitForInitialization;

      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      const identifyPromise = p.identify(ID_ALICE);
      identifyPromise.catch(() => {});

      // Allow the IIFE to enter waitForInitialization.
      await vi.waitFor(() => {
        expect(mockControl.instance!.waitForInitialization).toHaveBeenCalled();
      }, { timeout: 2000, interval: 5 });

      const client = mockControl.instance!;
      const disposePromise = p.dispose();

      // Resolve init AFTER dispose flipped _disposed.
      resolveInit();

      await expect(identifyPromise).rejects.toThrow(/disposed during initialization/);
      await disposePromise;
      expect(client.close).toHaveBeenCalledTimes(1);
      // `update` listener must NOT have been attached — wiring happens
      // after the disposed re-check.
      const onCalls = client.on.mock.calls.map((c: unknown[]) => c[0]);
      expect(onCalls).not.toContain("update");
    });

    it("coalesces concurrent first-time calls onto a single SDK init", async () => {
      mockControl.values = { ok: true };
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await Promise.all([p.identify(ID_ALICE), p.identify(ID_ALICE)]);
      expect(mockControl.init).toHaveBeenCalledTimes(1);
    });
  });

  describe("context mapping", () => {
    it("default mapping yields { kind: 'user', key, ...attrs }", async () => {
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await p.identify({
        userId: "alice",
        attrs: {
          email: "a@x",
          orgId: 42,
          permissions: ["read", "write"],
          nil: null,
          gone: undefined,
        },
      });
      const ctx = mockControl.instance!.allFlagsState.mock.calls[0][0];
      expect(ctx).toEqual({
        kind: "user",
        key: "alice",
        email: "a@x",
        orgId: 42,
        permissions: ["read", "write"],
        nil: null,
      });
    });

    it("contextKind option overrides the default 'user' kind", async () => {
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1", contextKind: "org" });
      await p.identify({ userId: "org-1" });
      const ctx = mockControl.instance!.allFlagsState.mock.calls[0][0];
      expect(ctx.kind).toBe("org");
      expect(ctx.key).toBe("org-1");
    });

    it("forwards `_meta` from identity.attrs onto the single-kind context", async () => {
      // `_meta.privateAttributes` is how LD callers declare attributes
      // that should not be sent to analytics. Consumers building a
      // contextBuilder via the default path rely on identity.attrs
      // passthrough to carry this — the loop in _buildContext must
      // NOT strip `_meta` or coerce its shape.
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await p.identify({
        userId: "alice",
        attrs: {
          email: "a@x",
          _meta: { privateAttributes: ["email"] },
        },
      });
      const ctx = mockControl.instance!.allFlagsState.mock.calls[0][0];
      expect(ctx._meta).toEqual({ privateAttributes: ["email"] });
    });

    it("attrs named `kind` or `key` do not overwrite structural fields", async () => {
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await p.identify({
        userId: "alice",
        attrs: { kind: "hijack", key: "injected", other: "ok" },
      });
      const ctx = mockControl.instance!.allFlagsState.mock.calls[0][0];
      expect(ctx.kind).toBe("user");
      expect(ctx.key).toBe("alice");
      expect(ctx.other).toBe("ok");
    });

    it("contextBuilder replaces the default mapper (multi-kind shape allowed)", async () => {
      // Multi-kind contexts have `kind: "multi"` at the root and NO
      // root-level `key` — each child is keyed by its kind name and
      // carries its own `{ key, ... }`. Mirrors the SDK's LDMultiKindContext.
      const p = new LaunchDarklyProvider({
        sdkKey: "sdk-1",
        contextBuilder: (id) => ({
          kind: "multi",
          user: { key: id.userId, name: "Alice" },
          organization: { key: (id.attrs?.orgId as string) ?? "none" },
        }),
      });
      await p.identify({ userId: "alice", attrs: { orgId: "acme" } });
      const ctx = mockControl.instance!.allFlagsState.mock.calls[0][0];
      expect(ctx).toEqual({
        kind: "multi",
        user: { key: "alice", name: "Alice" },
        organization: { key: "acme" },
      });
      // Regression check: no root-level key sneaks into the multi-kind
      // payload (LD tolerates it but it is not the canonical shape and
      // earlier revisions of this test taught consumers the wrong
      // shape).
      expect("key" in ctx).toBe(false);
    });
  });

  describe("SDK options forwarding", () => {
    it("forwards streamUri / baseUri / eventsUri / stream / pollInterval", async () => {
      const p = new LaunchDarklyProvider({
        sdkKey: "sdk-1",
        streamUri: "https://stream.example.com",
        baseUri: "https://base.example.com",
        eventsUri: "https://events.example.com",
        stream: false,
        pollInterval: 30,
      });
      await p.identify(ID_ALICE);
      expect(mockControl.init).toHaveBeenCalledWith("sdk-1", expect.objectContaining({
        streamUri: "https://stream.example.com",
        baseUri: "https://base.example.com",
        eventsUri: "https://events.example.com",
        stream: false,
        pollInterval: 30,
      }));
    });

    it("forwards disableEvents as sendEvents: false", async () => {
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1", disableEvents: true });
      await p.identify(ID_ALICE);
      expect(mockControl.init.mock.calls[0][1]).toEqual(expect.objectContaining({ sendEvents: false }));
    });

    it("omits SDK options that are not set", async () => {
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await p.identify(ID_ALICE);
      const opts = mockControl.init.mock.calls[0][1];
      expect(opts).toEqual({});
    });

    it("forwards initializationTimeoutMs to waitForInitialization as seconds", async () => {
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1", initializationTimeoutMs: 2000 });
      await p.identify(ID_ALICE);
      expect(mockControl.instance!.waitForInitialization).toHaveBeenCalledWith({ timeout: 2 });
    });
  });

  describe("subscribe (event-driven fan-out)", () => {
    it("fires onChange on the SDK's `update` event when content differs from the initial", async () => {
      mockControl.values = { old: true };
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      const initial = await p.identify(ID_ALICE);
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => received.push(n), initial);

      mockControl.values = { fresh: true };
      mockControl.instance!._emit("update", { key: "fresh" });
      // allFlagsState is async — wait a microtask.
      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 1000, interval: 5 });
      expect(received[0]).toEqual({ fresh: { enabled: true, value: true } });
    });

    it("stays silent on an `update` event where content is unchanged from the initial", async () => {
      mockControl.values = { same: true };
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      const initial = await p.identify(ID_ALICE);
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => received.push(n), initial);

      mockControl.instance!._emit("update", { key: "same" });
      // Flush any in-flight evaluations.
      await new Promise((r) => setTimeout(r, 20));
      expect(received).toHaveLength(0);
    });

    it("without initial, the first `update` acts as the initial push", async () => {
      mockControl.values = { a: true };
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await p.identify(ID_ALICE);
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => received.push(n));
      mockControl.instance!._emit("update", { key: "a" });
      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 1000, interval: 5 });
    });

    it("multiple subscribers for the same identity share one bucket + fan-out", async () => {
      mockControl.values = { x: false };
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      const initial = await p.identify(ID_ALICE);
      const a: unknown[] = [];
      const b: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => a.push(n), initial);
      p.subscribe(ID_ALICE, (n) => b.push(n), initial);

      mockControl.values = { x: true };
      mockControl.instance!._emit("update", { key: "x" });
      await vi.waitFor(() => {
        expect(a).toHaveLength(1);
        expect(b).toHaveLength(1);
      }, { timeout: 1000, interval: 5 });
    });

    it("distinct identities do not share a bucket", async () => {
      mockControl.values = { x: false };
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      const initial = await p.identify(ID_ALICE);
      const bReceived: unknown[] = [];
      p.subscribe({ userId: "bob" }, (n) => bReceived.push(n), initial);

      mockControl.instance!._emit("update", { key: "x" });
      await new Promise((r) => setTimeout(r, 20));
      expect(bReceived).toHaveLength(0);

      mockControl.values = { x: true };
      mockControl.instance!._emit("update", { key: "x" });
      await vi.waitFor(() => expect(bReceived).toHaveLength(1), { timeout: 1000, interval: 5 });
    });

    it("N subscribes with the SAME onChange reference yield N independent unsubs", async () => {
      mockControl.values = { a: false };
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await p.identify(ID_ALICE);
      let hits = 0;
      const onChange = (): void => { hits++; };
      const unsub1 = p.subscribe(ID_ALICE, onChange);
      const unsub2 = p.subscribe(ID_ALICE, onChange);

      mockControl.values = { a: true };
      mockControl.instance!._emit("update", { key: "a" });
      await vi.waitFor(() => expect(hits).toBe(2), { timeout: 1000, interval: 5 });

      unsub1();
      mockControl.values = { a: false };
      mockControl.instance!._emit("update", { key: "a" });
      await vi.waitFor(() => expect(hits).toBe(3), { timeout: 1000, interval: 5 });

      unsub2();
      mockControl.values = { a: true };
      mockControl.instance!._emit("update", { key: "a" });
      await new Promise((r) => setTimeout(r, 20));
      expect(hits).toBe(3);
    });

    it("unsubscribe twice is a no-op", async () => {
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await p.identify(ID_ALICE);
      const unsub = p.subscribe(ID_ALICE, () => {});
      unsub();
      expect(() => unsub()).not.toThrow();
    });

    it("re-calling a spent unsub while the bucket still has peers is a no-op", async () => {
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await p.identify(ID_ALICE);
      const unsubA = p.subscribe(ID_ALICE, () => {});
      p.subscribe(ID_ALICE, () => {});
      unsubA();
      expect(() => unsubA()).not.toThrow();
    });

    it("a late subscriber's initial never overwrites an existing bucket's baseline", async () => {
      mockControl.values = { x: false };
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      const initial = await p.identify(ID_ALICE);
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => received.push(n), initial);

      p.subscribe(ID_ALICE, () => {}, { foreign: true });

      mockControl.values = { x: true };
      mockControl.instance!._emit("update", { key: "x" });
      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 1000, interval: 5 });
    });

    it("an `update` event with no active buckets is a no-op", async () => {
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await p.identify(ID_ALICE);
      expect(() => mockControl.instance!._emit("update", { key: "x" })).not.toThrow();
    });

    it("subscribe without prior identify fails without _getClient being called", async () => {
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      p.subscribe(ID_ALICE, () => {});
      expect(mockControl.init).not.toHaveBeenCalled();
    });

    it("subscribe throws after dispose", async () => {
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await p.identify(ID_ALICE);
      await p.dispose();
      expect(() => p.subscribe(ID_ALICE, () => {})).toThrow(/disposed/);
    });

    it("eval failure during fan-out is treated as no-change", async () => {
      mockControl.values = { x: true };
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      const initial = await p.identify(ID_ALICE);
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => received.push(n), initial);

      mockControl.evalError = new Error("evaluation dead");
      mockControl.instance!._emit("update", { key: "x" });
      await new Promise((r) => setTimeout(r, 20));
      expect(received).toHaveLength(0);

      // Recovers on the next update with no error.
      mockControl.evalError = null;
      mockControl.values = { x: false };
      mockControl.instance!._emit("update", { key: "x" });
      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 1000, interval: 5 });
    });

    it("drops the fan-out result when the bucket empties during an async eval", async () => {
      mockControl.values = { x: true };
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      const initial = await p.identify(ID_ALICE);
      const received: unknown[] = [];
      const unsub = p.subscribe(ID_ALICE, (n) => received.push(n), initial);

      // Gate the next allFlagsState so we can unsubscribe mid-flight.
      let openGate: () => void = () => {};
      mockControl.evalGate = new Promise<void>((res) => { openGate = res; });
      mockControl.values = { x: false };
      mockControl.instance!._emit("update", { key: "x" });

      // Unsubscribe WHILE the evaluation is pending.
      unsub();
      openGate();

      await new Promise((r) => setTimeout(r, 20));
      expect(received).toHaveLength(0);
    });

    it("coalesces overlapping update events into a single re-evaluation", async () => {
      mockControl.values = { x: false };
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      const initial = await p.identify(ID_ALICE);
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => received.push(n), initial);

      // Gate the first evaluation so we can stack a second update on it.
      let openGate: () => void = () => {};
      mockControl.evalGate = new Promise<void>((res) => { openGate = res; });
      mockControl.values = { x: true };
      mockControl.instance!._emit("update", { key: "x" });
      // While the first is in flight, a second update MUST be coalesced
      // into a `pending` flag rather than launching a second concurrent
      // evaluation — otherwise fan-outs could deliver out of order.
      mockControl.instance!._emit("update", { key: "x" });

      const evalCallsBeforeGate = mockControl.instance!.allFlagsState.mock.calls.length;
      // Only the first eval has started — the second is queued.
      expect(evalCallsBeforeGate).toBe(2); // identify + first update

      // Release the gate; the pending re-run fires on a fresh evaluation.
      mockControl.evalGate = null;
      openGate();
      await vi.waitFor(() => {
        // identify(1) + first-update(1) + pending-rerun(1) = 3
        expect(mockControl.instance!.allFlagsState.mock.calls.length).toBe(3);
      }, { timeout: 1000, interval: 5 });
      // The subscriber saw exactly one change (same content across the
      // two evaluations, so only one fan-out).
      expect(received).toHaveLength(1);
    });
  });

  describe("reload", () => {
    it("re-evaluates against the SDK's current cache and updates the bucket baseline", async () => {
      mockControl.values = { x: false };
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      const initial = await p.identify(ID_ALICE);
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => received.push(n), initial);

      mockControl.values = { fresh: true };
      const reloaded = await p.reload(ID_ALICE);
      expect(reloaded).toEqual({ fresh: { enabled: true, value: true } });

      // Same-content `update` now sees the updated baseline and stays silent.
      mockControl.instance!._emit("update", { key: "fresh" });
      await new Promise((r) => setTimeout(r, 20));
      expect(received).toHaveLength(0);
    });

    it("reload without an active bucket just returns the current evaluation", async () => {
      mockControl.values = { x: true };
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      const reloaded = await p.reload(ID_ALICE);
      expect(reloaded).toEqual({ x: { enabled: true, value: true } });
    });
  });

  describe("dispose", () => {
    it("removes the update listener, calls close, clears buckets", async () => {
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await p.identify(ID_ALICE);
      p.subscribe(ID_ALICE, () => {});
      const inst = mockControl.instance!;
      await p.dispose();
      expect(inst.off).toHaveBeenCalledWith("update", expect.any(Function));
      expect(inst.close).toHaveBeenCalledTimes(1);
    });

    it("tolerates a throwing close()", async () => {
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await p.identify(ID_ALICE);
      mockControl.instance!.close.mockImplementation(() => {
        throw new Error("dust");
      });
      await expect(p.dispose()).resolves.toBeUndefined();
    });

    it("tolerates a throwing off()", async () => {
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await p.identify(ID_ALICE);
      mockControl.instance!.off.mockImplementation(() => {
        throw new Error("off-bang");
      });
      await expect(p.dispose()).resolves.toBeUndefined();
    });

    it("no-op when no client was ever built", async () => {
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await expect(p.dispose()).resolves.toBeUndefined();
    });

    it("works when the SDK lacks close() entirely", async () => {
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await p.identify(ID_ALICE);
      (mockControl.instance as unknown as Record<string, unknown>).close = undefined;
      await expect(p.dispose()).resolves.toBeUndefined();
    });

    it("works when the SDK lacks off() entirely", async () => {
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await p.identify(ID_ALICE);
      (mockControl.instance as unknown as Record<string, unknown>).off = undefined;
      await expect(p.dispose()).resolves.toBeUndefined();
    });

    it("second dispose is a no-op", async () => {
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await p.identify(ID_ALICE);
      await p.dispose();
      const beforeCalls = mockControl.instance!.close.mock.calls.length;
      await p.dispose();
      expect(mockControl.instance!.close.mock.calls.length).toBe(beforeCalls);
    });

    it("identify after dispose throws", async () => {
      const p = new LaunchDarklyProvider({ sdkKey: "sdk-1" });
      await p.dispose();
      await expect(p.identify(ID_ALICE)).rejects.toThrow(/disposed/);
    });
  });
});
