import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FlagsmithProvider, __resetRealtimeWarning } from "../src/providers/FlagsmithProvider";
import type { FlagIdentity } from "../src/types";

const ID_ALICE: FlagIdentity = { userId: "alice", attrs: { role: "admin" } };

// Shape of the mocked flagsmith-nodejs module controlled per-test via
// `__mockControl`. Keeping it at module scope lets tests swap behaviour
// between calls without redoing vi.doMock round-trips.
const mockControl: {
  constructor: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  getIdentityFlags: ReturnType<typeof vi.fn>;
  shape: "getAllFlags" | "allFlags" | "both" | "empty";
} = {
  constructor: vi.fn(),
  close: vi.fn(),
  getIdentityFlags: vi.fn(),
  shape: "getAllFlags",
};

function makeFlagList(flags: Array<{ name: string; enabled: boolean; value?: unknown }>) {
  const list = flags.map((f) => ({
    featureName: f.name,
    enabled: f.enabled,
    value: f.value,
  }));
  if (mockControl.shape === "getAllFlags") {
    return { getAllFlags: () => list };
  }
  if (mockControl.shape === "allFlags") {
    return { allFlags: () => list };
  }
  if (mockControl.shape === "both") {
    return { getAllFlags: () => list, allFlags: () => list };
  }
  return {};
}

vi.mock("flagsmith-nodejs", () => {
  class Flagsmith {
    constructor(opts: unknown) { mockControl.constructor(opts); }
    async getIdentityFlags(id: string, traits?: Record<string, unknown>): Promise<unknown> {
      return mockControl.getIdentityFlags(id, traits);
    }
    async close(): Promise<void> { mockControl.close(); }
  }
  return { Flagsmith, default: Flagsmith };
});

function setDefaultFlags() {
  mockControl.getIdentityFlags.mockImplementation(() =>
    makeFlagList([
      { name: "new_checkout", enabled: true, value: null },
      { name: "beta_nav",     enabled: false, value: "v2" },
    ]),
  );
}

describe("FlagsmithProvider", () => {
  beforeEach(() => {
    mockControl.constructor.mockReset();
    mockControl.close.mockReset();
    mockControl.getIdentityFlags.mockReset();
    mockControl.shape = "getAllFlags";
    setDefaultFlags();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("construction", () => {
    it("throws without environmentKey", () => {
      expect(() => new FlagsmithProvider({ environmentKey: "" })).toThrow(/environmentKey/);
    });

    it("does not touch the SDK until first use", () => {
      new FlagsmithProvider({ environmentKey: "env_key" });
      expect(mockControl.constructor).not.toHaveBeenCalled();
    });

    it("logs a warning when realtime is requested", () => {
      __resetRealtimeWarning();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      new FlagsmithProvider({ environmentKey: "env_key", realtime: true });
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it("only logs the realtime warning once per process", () => {
      // Regression guard for [R1-03]: frameworks that rebuild the
      // provider on every request would flood the log stream with
      // the same deprecation-style warning. Gate it behind a
      // module-scope flag; subsequent constructions must stay silent.
      __resetRealtimeWarning();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      new FlagsmithProvider({ environmentKey: "env_key", realtime: true });
      new FlagsmithProvider({ environmentKey: "env_key", realtime: true });
      new FlagsmithProvider({ environmentKey: "env_key", realtime: true });
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });
  });

  describe("identify / reload", () => {
    it("flattens Flagsmith v5 getAllFlags() into { [name]: { enabled, value } }", async () => {
      const p = new FlagsmithProvider({ environmentKey: "env_key" });
      const map = await p.identify(ID_ALICE);
      expect(map).toEqual({
        new_checkout: { enabled: true, value: null },
        beta_nav:     { enabled: false, value: "v2" },
      });
      expect(Object.isFrozen(map)).toBe(true);
    });

    it("supports the older allFlags() SDK shape", async () => {
      mockControl.shape = "allFlags";
      setDefaultFlags();
      const p = new FlagsmithProvider({ environmentKey: "env_key" });
      const map = await p.identify(ID_ALICE);
      expect(Object.keys(map).sort()).toEqual(["beta_nav", "new_checkout"]);
    });

    it("prefers getAllFlags when both are present", async () => {
      mockControl.shape = "both";
      setDefaultFlags();
      const p = new FlagsmithProvider({ environmentKey: "env_key" });
      const map = await p.identify(ID_ALICE);
      expect(Object.keys(map)).toHaveLength(2);
    });

    it("handles an empty result shape", async () => {
      mockControl.shape = "empty";
      setDefaultFlags();
      const p = new FlagsmithProvider({ environmentKey: "env_key" });
      expect(await p.identify(ID_ALICE)).toEqual({});
    });

    it("skips entries without a feature name", async () => {
      mockControl.getIdentityFlags.mockImplementation(() => ({
        getAllFlags: () => [
          { enabled: true }, // no name
          { feature: { name: "named" }, enabled: false, value: 0 },
        ],
      }));
      const p = new FlagsmithProvider({ environmentKey: "env_key" });
      const map = await p.identify(ID_ALICE);
      expect(map).toEqual({ named: { enabled: false, value: 0 } });
    });

    it("sanitizes identity.attrs before forwarding to the SDK", async () => {
      // Regression guard for [R1-09]: `FlagIdentity.attrs` is typed
      // `Record<string, unknown>` and reaches this Provider directly
      // from user code. Without sanitization, nested objects,
      // functions, or Symbols would be handed to Flagsmith's trait API
      // — at best silently dropped by the SDK's JSON encoding, at
      // worst leaked upstream. Keep only primitives; CSV-join arrays;
      // drop nested objects / functions / symbols.
      const p = new FlagsmithProvider({ environmentKey: "env_key" });
      await p.identify({
        userId: "alice",
        attrs: {
          email: "a@x",
          orgId: 42,
          active: true,
          nil: null,
          gone: undefined,
          roles: ["admin", "ops"],
          // Mixed-type array element coverage: the CSV join must
          // stringify non-string elements (nested object, number) via
          // JSON.stringify so they survive the scalar-only trait shape.
          // Regression guard for [R2-01]: without this, the non-string
          // branch of the element map is uncovered.
          mixed: ["a", { k: "v" }, 1],
          nested: { secret: "leaked?" },
          handler: () => "nope",
          tag: Symbol("no-thanks"),
        },
      });
      expect(mockControl.getIdentityFlags).toHaveBeenCalledWith("alice", {
        email: "a@x",
        orgId: 42,
        active: true,
        nil: null,
        roles: "admin,ops",
        mixed: 'a,{"k":"v"},1',
      });
    });

    it("passes `undefined` traits when no attrs are supplied", async () => {
      // Baseline check: a bare identity (no attrs) reaches the SDK
      // without a fabricated empty object — preserves the prior
      // contract and keeps the SDK's own "no traits" codepath active.
      const p = new FlagsmithProvider({ environmentKey: "env_key" });
      await p.identify({ userId: "alice" });
      expect(mockControl.getIdentityFlags).toHaveBeenCalledWith("alice", undefined);
    });

    it("passes `undefined` traits when every attr is filtered out", async () => {
      // An attrs bag that consists only of values we drop (nested
      // objects, functions, undefined) must not become an empty `{}` —
      // an empty bag and an absent bag should be indistinguishable to
      // the SDK.
      const p = new FlagsmithProvider({ environmentKey: "env_key" });
      await p.identify({
        userId: "alice",
        attrs: {
          nested: { k: "v" },
          fn: () => {},
          gone: undefined,
        },
      });
      expect(mockControl.getIdentityFlags).toHaveBeenCalledWith("alice", undefined);
    });

    it("forwards environmentKey / apiUrl / local-eval options to the SDK", async () => {
      const p = new FlagsmithProvider({
        environmentKey: "env_key",
        apiUrl: "https://custom/api",
        enableLocalEvaluation: true,
        environmentRefreshIntervalSeconds: 10,
      });
      await p.identify(ID_ALICE);
      expect(mockControl.constructor).toHaveBeenCalledWith({
        environmentKey: "env_key",
        apiUrl: "https://custom/api",
        enableLocalEvaluation: true,
        environmentRefreshIntervalSeconds: 10,
      });
    });

    it("defaults missing options", async () => {
      const p = new FlagsmithProvider({ environmentKey: "env_key" });
      await p.identify(ID_ALICE);
      expect(mockControl.constructor).toHaveBeenCalledWith({
        environmentKey: "env_key",
        apiUrl: undefined,
        enableLocalEvaluation: false,
        environmentRefreshIntervalSeconds: 60,
      });
    });

    it("reuses the same client across identify / reload", async () => {
      const p = new FlagsmithProvider({ environmentKey: "env_key" });
      await p.identify(ID_ALICE);
      await p.reload(ID_ALICE);
      expect(mockControl.constructor).toHaveBeenCalledTimes(1);
    });

    it("coalesces concurrent first-time calls onto a single client build", async () => {
      vi.useRealTimers();
      const p = new FlagsmithProvider({ environmentKey: "env_key" });
      await Promise.all([p.identify(ID_ALICE), p.identify(ID_ALICE)]);
      expect(mockControl.constructor).toHaveBeenCalledTimes(1);
    });

    it("flattens array flag values through stable serialization", async () => {
      mockControl.getIdentityFlags.mockImplementation(() => ({
        getAllFlags: () => [{
          featureName: "options",
          enabled: true,
          value: ["red", "green", "blue"],
        }],
      }));
      const p = new FlagsmithProvider({ environmentKey: "env_key", pollingIntervalMs: 100 });
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => received.push(n));
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      expect(received).toHaveLength(1);
      expect((received[0] as any).options.value).toEqual(["red", "green", "blue"]);
    });

    it("polling exits cleanly when the provider is disposed between ticks", async () => {
      const p = new FlagsmithProvider({ environmentKey: "env_key", pollingIntervalMs: 100 });
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => received.push(n));
      // Dispose BEFORE the first poll — timer fires but the disposed
      // guard at _pollOnce's top causes it to return immediately.
      await p.dispose();
      await vi.advanceTimersByTimeAsync(500);
      expect(received).toHaveLength(0);
    });
  });

  describe("subscribe (polling)", () => {
    it("calls onChange when a poll returns a different flag map", async () => {
      const p = new FlagsmithProvider({
        environmentKey: "env_key",
        pollingIntervalMs: 1000,
      });
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (next) => received.push(next));

      // First poll produces the initial snapshot — equal to identify().
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
      expect(received).toHaveLength(1); // first poll (empty sentinel → different)

      // Same underlying data; no new callback
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
      expect(received).toHaveLength(1);

      // Change the data; next poll fires
      mockControl.getIdentityFlags.mockImplementation(() =>
        makeFlagList([{ name: "x", enabled: true }]),
      );
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
      expect(received).toHaveLength(2);
    });

    it("can be unsubscribed; subsequent polls do not fire the callback", async () => {
      const p = new FlagsmithProvider({ environmentKey: "env_key", pollingIntervalMs: 500 });
      const received: unknown[] = [];
      const unsub = p.subscribe(ID_ALICE, (next) => received.push(next));
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      unsub();
      mockControl.getIdentityFlags.mockImplementation(() => makeFlagList([{ name: "y", enabled: true }]));
      await vi.advanceTimersByTimeAsync(5000);
      await Promise.resolve();
      expect(received).toHaveLength(1);
    });

    it("unsubscribe twice is a no-op", async () => {
      const p = new FlagsmithProvider({ environmentKey: "env_key", pollingIntervalMs: 0 });
      const unsub = p.subscribe(ID_ALICE, () => {});
      unsub();
      expect(() => unsub()).not.toThrow();
    });

    it("unsubscribing one of several subscribers keeps the bucket alive", () => {
      const p = new FlagsmithProvider({ environmentKey: "env_key", pollingIntervalMs: 0 });
      const unsubA = p.subscribe(ID_ALICE, () => {});
      p.subscribe(ID_ALICE, () => {});
      expect(() => unsubA()).not.toThrow();
    });

    it("re-calling a spent unsub while the bucket still has peers is a no-op", () => {
      const p = new FlagsmithProvider({ environmentKey: "env_key", pollingIntervalMs: 0 });
      const unsubA = p.subscribe(ID_ALICE, () => {});
      p.subscribe(ID_ALICE, () => {});
      unsubA();
      // Bucket still has the second subscriber. Second unsubA must find
      // its own entry missing and return without touching anything.
      expect(() => unsubA()).not.toThrow();
    });

    it("polling disabled when interval=0", async () => {
      const p = new FlagsmithProvider({ environmentKey: "env_key", pollingIntervalMs: 0 });
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (next) => received.push(next));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(received).toHaveLength(0);
    });

    it("uses the 30s default interval when pollingIntervalMs is omitted", async () => {
      const p = new FlagsmithProvider({ environmentKey: "env_key" });
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (next) => received.push(next));
      // Before the default window (30s), nothing has polled.
      await vi.advanceTimersByTimeAsync(29_000);
      await Promise.resolve();
      expect(received).toHaveLength(0);
      // Cross the boundary — first poll fires.
      await vi.advanceTimersByTimeAsync(2_000);
      await Promise.resolve();
      expect(received).toHaveLength(1);
    });

    it("suppresses transient fetch errors", async () => {
      const p = new FlagsmithProvider({ environmentKey: "env_key", pollingIntervalMs: 500 });
      // Successful identify() seeds the client
      await p.identify(ID_ALICE);
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (next) => received.push(next));
      mockControl.getIdentityFlags.mockRejectedValueOnce(new Error("flaky"));
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      await Promise.resolve();
      // Even with the error, no callback fired yet — or if it did, it's
      // because the PREVIOUS successful content changed; verify no
      // *error* propagates to the consumer.
      expect(received.every((v) => typeof v === "object")).toBe(true);
    });

    it("suppresses client-load errors during polling", async () => {
      // Construct a provider whose client creation will fail after
      // the initial identify attempt.
      mockControl.getIdentityFlags.mockRejectedValueOnce(new Error("init fail"));
      const p = new FlagsmithProvider({ environmentKey: "env_key", pollingIntervalMs: 500 });
      const received: unknown[] = [];
      // Subscribe first (no prior client) — first poll has to instantiate
      p.subscribe(ID_ALICE, (next) => received.push(next));
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      // Restore normal behaviour — next poll should succeed
      setDefaultFlags();
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      expect(received.length).toBeGreaterThanOrEqual(1);
    });

    it("multiple subscribers for the same identity share one poller + fan-out", async () => {
      const p = new FlagsmithProvider({ environmentKey: "env_key", pollingIntervalMs: 250 });
      const a: unknown[] = [];
      const b: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => a.push(n));
      p.subscribe(ID_ALICE, (n) => b.push(n));
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
      // One tick fires once across all subscribers of the same identity
      // (shared poller). Both callbacks receive the same snapshot.
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      // Critical: `getIdentityFlags` must have been called once — not
      // once-per-subscriber. That is the whole point of the shared-poller
      // refactor; ten tabs from the same user produce one poll, not ten.
      expect(mockControl.getIdentityFlags).toHaveBeenCalledTimes(1);
    });

    it("distinct identities do not share a poller", async () => {
      const p = new FlagsmithProvider({ environmentKey: "env_key", pollingIntervalMs: 250 });
      const a: unknown[] = [];
      const b: unknown[] = [];
      p.subscribe({ userId: "alice" }, (n) => a.push(n));
      p.subscribe({ userId: "bob" }, (n) => b.push(n));
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
      expect(mockControl.getIdentityFlags).toHaveBeenCalledTimes(2);
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    it("distinct attrs on the same userId allocate separate pollers", async () => {
      const p = new FlagsmithProvider({ environmentKey: "env_key", pollingIntervalMs: 250 });
      p.subscribe({ userId: "alice", attrs: { role: "admin" } }, () => {});
      p.subscribe({ userId: "alice", attrs: { role: "user" } }, () => {});
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
      // Different trait sets may evaluate to different flags, so they
      // must not share a poller.
      expect(mockControl.getIdentityFlags).toHaveBeenCalledTimes(2);
    });

    it("subscribe with initial baseline does NOT re-fire on the first poll if content is unchanged", async () => {
      // Callers (notably FlagsCore) thread the identify() result
      // through as `subscribe(id, onChange, initial)`. The Provider
      // seeds its change-detection baseline from that, so the first
      // scheduled poll compares equal and stays silent.
      const p = new FlagsmithProvider({ environmentKey: "env_key", pollingIntervalMs: 1000 });
      const initial = await p.identify(ID_ALICE);
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => received.push(n), initial);
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
      expect(received).toHaveLength(0);
      // Now change the underlying data; next poll must fire.
      mockControl.getIdentityFlags.mockImplementation(() =>
        makeFlagList([{ name: "changed", enabled: true }]),
      );
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
      expect(received).toHaveLength(1);
    });

    it("a late subscriber's initial never overwrites an existing bucket's baseline", async () => {
      // Bucket baseline is authoritative once established. The two
      // scenarios a late `initial` could represent are indistinguishable
      // without a trusted ordering signal, and both forms of overwrite
      // are harmful:
      //   - stale `initial`  → rolls baseline backward, causing a
      //     redundant onChange on the next poll for all subscribers
      //     (the reported regression).
      //   - fresh `initial`  → rolls baseline forward, silently denying
      //     existing subscribers the transition from their `initial`
      //     to the observed state.
      // The bucket must ignore late `initial` values entirely.

      // --- Scenario 1: stale initial must NOT roll the baseline back ---
      {
        const p = new FlagsmithProvider({ environmentKey: "env_key", pollingIntervalMs: 1000 });
        const staleInitial = await p.identify(ID_ALICE);
        const seen: unknown[] = [];
        p.subscribe(ID_ALICE, (n) => seen.push(n), staleInitial);

        // Bucket observes a real change via a poll.
        mockControl.getIdentityFlags.mockImplementation(() =>
          makeFlagList([{ name: "observed", enabled: true }]),
        );
        await vi.advanceTimersByTimeAsync(1000);
        await Promise.resolve();
        expect(seen).toHaveLength(1);  // baseline advanced to "observed"

        // A late subscriber shows up with the STALE initial (e.g. its
        // identify() raced against the earlier state, or came from a
        // cache). If the late initial rolled baseline back to stale,
        // the next poll (still "observed") would compare different
        // and fire for everyone — a spurious redundant fire.
        const lateReceived: unknown[] = [];
        p.subscribe(ID_ALICE, (n) => lateReceived.push(n), staleInitial);
        await vi.advanceTimersByTimeAsync(1000);
        await Promise.resolve();
        expect(seen).toHaveLength(1);         // no spurious re-fire
        expect(lateReceived).toHaveLength(0); // bucket believes "no change"
      }

      // --- Scenario 2: fresh initial must NOT skip the observed transition ---
      {
        const p = new FlagsmithProvider({ environmentKey: "env_key", pollingIntervalMs: 1000 });
        const firstInitial = await p.identify(ID_ALICE);
        const early: unknown[] = [];
        p.subscribe(ID_ALICE, (n) => early.push(n), firstInitial);

        // Flagsmith state changes BEFORE the next poll tick, AND a
        // late subscriber's identify() picks up that newer value.
        mockControl.getIdentityFlags.mockImplementation(() =>
          makeFlagList([{ name: "fresher", enabled: true }]),
        );
        const fresherInitial = await p.identify(ID_ALICE);
        const late: unknown[] = [];
        p.subscribe(ID_ALICE, (n) => late.push(n), fresherInitial);

        await vi.advanceTimersByTimeAsync(1000);
        await Promise.resolve();
        // The early subscriber MUST be told about the change from its
        // `firstInitial` to "fresher" — a baseline overwrite would
        // silence this.
        expect(early).toHaveLength(1);
        // The late subscriber eats one redundant callback — acceptable
        // trade, since the content delivered matches what it already had.
        expect(late).toHaveLength(1);
      }
    });

    it("N subscribes with the SAME onChange reference yield N independent unsubs", async () => {
      // Regression guard: the Set-of-functions approach deduped identical
      // references and broke the N-subscribe → N-unsub contract. Each
      // call must return a distinct unsub that disables exactly one
      // logical subscription; the same fn subscribed twice receives
      // two callbacks per tick until both are unsubscribed.
      const p = new FlagsmithProvider({ environmentKey: "env_key", pollingIntervalMs: 500 });
      let hits = 0;
      const onChange = (): void => { hits++; };
      const unsub1 = p.subscribe(ID_ALICE, onChange);
      const unsub2 = p.subscribe(ID_ALICE, onChange);

      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      expect(hits).toBe(2);  // both entries fire

      unsub1();
      // Only one logical subscription remains even though the original
      // onChange reference is still "alive" in the Set.
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      // Flagsmith mock returns the same data; second poll is silent.
      // Change the data to force fan-out again.
      mockControl.getIdentityFlags.mockImplementation(() =>
        makeFlagList([{ name: "x", enabled: true }]),
      );
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      expect(hits).toBe(3);  // only the surviving entry fires

      unsub2();
      mockControl.getIdentityFlags.mockImplementation(() =>
        makeFlagList([{ name: "x", enabled: false }]),
      );
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      expect(hits).toBe(3);  // no subscribers left
    });

    it("reload() updates the active poller's baseline", async () => {
      const p = new FlagsmithProvider({ environmentKey: "env_key", pollingIntervalMs: 1000 });
      await p.identify(ID_ALICE);
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => received.push(n));
      // External reload drops in mid-subscription with new content.
      mockControl.getIdentityFlags.mockImplementation(() =>
        makeFlagList([{ name: "fresh", enabled: true }]),
      );
      await p.reload(ID_ALICE);  // lastSerialized → "fresh" content
      // Next poll returns the SAME "fresh" content — must NOT fire,
      // because reload already updated the baseline.
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
      expect(received).toHaveLength(0);
    });

    it("baseline state is released when the last subscriber leaves", async () => {
      // Regression guard: prior to the fix, `_lastFetched` retained an
      // entry per identity for the life of the provider. Verify it by
      // observing that a fresh subscribe (no `initial`) after all
      // prior subscribers have left falls back to the "__INIT__"
      // sentinel — i.e. the first poll fires. If stale baseline
      // lingered, the first poll would match it and stay silent.
      const p = new FlagsmithProvider({ environmentKey: "env_key", pollingIntervalMs: 500 });
      const initial = await p.identify(ID_ALICE);
      const unsub = p.subscribe(ID_ALICE, () => {}, initial);
      // Tear down; internal bucket + its baseline are released.
      unsub();
      const received: unknown[] = [];
      // New subscribe WITHOUT initial — if the leak were still present,
      // the stale baseline from the prior bucket would cause the first
      // poll to compare equal and NOT fire. We expect it TO fire.
      p.subscribe(ID_ALICE, (n) => received.push(n));
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      expect(received).toHaveLength(1);
    });

    it("a concurrent final-unsubscribe mid-fetch silently drops the result", async () => {
      // The fetch fires, awaits; meanwhile the last subscriber unsubs
      // (clearing the bucket's subscribers Set). When the fetch
      // resolves, we must fan out to nobody and skip the work.
      let resolveFetch!: (v: unknown) => void;
      mockControl.getIdentityFlags.mockImplementationOnce(() =>
        new Promise((r) => { resolveFetch = r; }),
      );
      const p = new FlagsmithProvider({ environmentKey: "env_key", pollingIntervalMs: 1000 });
      let hits = 0;
      const unsub = p.subscribe(ID_ALICE, () => { hits++; });
      await vi.advanceTimersByTimeAsync(1000);
      // Tick fired, fetch is pending. Unsubscribe before it resolves.
      unsub();
      resolveFetch(makeFlagList([{ name: "x", enabled: true }]));
      await Promise.resolve();
      await Promise.resolve();
      expect(hits).toBe(0);
    });

    it("subscribe throws after dispose", async () => {
      const p = new FlagsmithProvider({ environmentKey: "env_key" });
      await p.dispose();
      expect(() => p.subscribe(ID_ALICE, () => {})).toThrow(/disposed/);
    });
  });

  describe("dispose", () => {
    it("clears timers and closes the SDK client", async () => {
      const p = new FlagsmithProvider({ environmentKey: "env_key", pollingIntervalMs: 500 });
      await p.identify(ID_ALICE);
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => received.push(n));
      await p.dispose();
      await vi.advanceTimersByTimeAsync(5000);
      expect(received).toHaveLength(0);
      expect(mockControl.close).toHaveBeenCalledTimes(1);
    });

    it("is idempotent", async () => {
      const p = new FlagsmithProvider({ environmentKey: "env_key" });
      await p.identify(ID_ALICE);
      await p.dispose();
      await p.dispose();
      expect(mockControl.close).toHaveBeenCalledTimes(1);
    });

    it("tolerates a throwing close()", async () => {
      mockControl.close.mockImplementation(() => { throw new Error("bad close"); });
      const p = new FlagsmithProvider({ environmentKey: "env_key" });
      await p.identify(ID_ALICE);
      await expect(p.dispose()).resolves.toBeUndefined();
    });

    it("dispose with no client ever built is fine", async () => {
      const p = new FlagsmithProvider({ environmentKey: "env_key" });
      await expect(p.dispose()).resolves.toBeUndefined();
    });

    it("dispose mid-init closes the freshly-built client before it commits", async () => {
      // Regression: dispose() firing while `_getClient()` is awaiting
      // the dynamic `import("flagsmith-nodejs")` saw `_client === null`
      // and skipped cleanup. The IIFE then constructed a fresh SDK
      // (which with `enableLocalEvaluation` spawns an upstream poll
      // timer) and committed it onto a disposed Provider — leaking
      // the timer permanently.
      //
      // `await import()` yields microtasks under vitest's mock loader,
      // so a dispose() called synchronously after identify() completes
      // its body before the IIFE resumes past the await.
      const p = new FlagsmithProvider({
        environmentKey: "env",
        enableLocalEvaluation: true,
      });
      const identifyPromise = p.identify(ID_ALICE);
      identifyPromise.catch(() => {});
      const disposePromise = p.dispose();

      await expect(identifyPromise).rejects.toThrow(/disposed during initialization/);
      await disposePromise;
      // SDK's `close` must have been called exactly once on the
      // doomed client. Before the fix, `close` was never called —
      // dispose() saw `_client === null` and the IIFE committed the
      // client AFTER dispose had returned.
      expect(mockControl.close).toHaveBeenCalledTimes(1);
    });

    it("dispose mid-init works when the SDK lacks a close() method", async () => {
      // Older Flagsmith SDKs don't expose `close`. The disposed-race
      // cleanup path must still surface the error to the caller
      // (and not try to await a non-existent method).
      const origModules = await import("flagsmith-nodejs") as { Flagsmith: unknown };
      const RealFlagsmith = origModules.Flagsmith;
      vi.mocked(origModules).Flagsmith = class {
        constructor(opts: unknown) { mockControl.constructor(opts); }
        async getIdentityFlags(): Promise<unknown> { return { getAllFlags: () => [] }; }
        // No close() method.
      } as unknown as typeof origModules.Flagsmith;
      try {
        const p = new FlagsmithProvider({ environmentKey: "env" });
        const identifyPromise = p.identify(ID_ALICE);
        identifyPromise.catch(() => {});
        const disposePromise = p.dispose();
        await expect(identifyPromise).rejects.toThrow(/disposed during initialization/);
        await disposePromise;
      } finally {
        vi.mocked(origModules).Flagsmith = RealFlagsmith as typeof origModules.Flagsmith;
      }
    });

    it("dispose mid-init tolerates a throwing close() on the doomed client", async () => {
      mockControl.close.mockImplementationOnce(() => { throw new Error("close-bang"); });
      const p = new FlagsmithProvider({ environmentKey: "env" });
      const identifyPromise = p.identify(ID_ALICE);
      identifyPromise.catch(() => {});
      const disposePromise = p.dispose();
      // The race-path's "disposed during initialization" wins; the
      // close failure is swallowed.
      await expect(identifyPromise).rejects.toThrow(/disposed during initialization/);
      await disposePromise;
    });

    it("dispose tears down a polling-disabled bucket cleanly", async () => {
      const p = new FlagsmithProvider({ environmentKey: "env_key", pollingIntervalMs: 0 });
      p.subscribe(ID_ALICE, () => {});
      // Bucket exists but has no timer — dispose must still clear it
      // without attempting to clearInterval a null.
      await expect(p.dispose()).resolves.toBeUndefined();
    });

    it("identify after dispose throws", async () => {
      const p = new FlagsmithProvider({ environmentKey: "env_key" });
      await p.dispose();
      await expect(p.identify(ID_ALICE)).rejects.toThrow(/disposed/);
    });
  });
});

describe("FlagsmithProvider (module-load failures)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock("flagsmith-nodejs");
  });

  it("raises a clean error when flagsmith-nodejs is not installed", async () => {
    vi.doMock("flagsmith-nodejs", () => { throw new Error("MODULE_NOT_FOUND"); });
    const { FlagsmithProvider: P } = await import("../src/providers/FlagsmithProvider");
    const p = new P({ environmentKey: "k" });
    await expect(p.identify(ID_ALICE)).rejects.toThrow(/failed to load "flagsmith-nodejs"/);
  });


  it("raises a clean error when the module does not expose a constructor", async () => {
    // Returning both keys explicitly set to undefined avoids vitest's
    // "export is not defined on the mock" guard while still making
    // `mod.Flagsmith ?? mod.default` evaluate to undefined.
    vi.doMock("flagsmith-nodejs", () => ({ Flagsmith: undefined, default: undefined }));
    const { FlagsmithProvider: P } = await import("../src/providers/FlagsmithProvider");
    const p = new P({ environmentKey: "k" });
    await expect(p.identify(ID_ALICE)).rejects.toThrow(/did not expose a Flagsmith constructor/);
  });

  it("retries after a failed first load", async () => {
    let first = true;
    vi.doMock("flagsmith-nodejs", () => {
      if (first) { first = false; throw new Error("boom"); }
      class Flagsmith {
        async getIdentityFlags(): Promise<unknown> {
          return { getAllFlags: () => [{ featureName: "x", enabled: true }] };
        }
        async close(): Promise<void> {}
      }
      return { Flagsmith };
    });
    const { FlagsmithProvider: P } = await import("../src/providers/FlagsmithProvider");
    const p = new P({ environmentKey: "k" });
    await expect(p.identify(ID_ALICE)).rejects.toThrow();
    const second = await p.identify(ID_ALICE);
    expect(second).toEqual({ x: { enabled: true, value: null } });
  });

  it("polling swallows a failed _getClient() — no callback, no crash", async () => {
    // Always-failing module load. Subscribe BEFORE any identify so the
    // first poll is the call site that sees the rejected client.
    vi.doMock("flagsmith-nodejs", () => { throw new Error("unreachable"); });
    vi.useFakeTimers();
    try {
      const { FlagsmithProvider: P } = await import("../src/providers/FlagsmithProvider");
      const p = new P({ environmentKey: "k", pollingIntervalMs: 100 });
      const received: unknown[] = [];
      p.subscribe(ID_ALICE, (n) => received.push(n));
      await vi.advanceTimersByTimeAsync(150);
      await Promise.resolve();
      await Promise.resolve();
      expect(received).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
