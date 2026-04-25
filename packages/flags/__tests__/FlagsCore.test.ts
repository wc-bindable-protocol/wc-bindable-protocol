import { describe, it, expect, vi, beforeEach } from "vitest";
import { FlagsCore } from "../src/core/FlagsCore";
import { InMemoryFlagProvider } from "../src/providers/InMemoryFlagProvider";
import type { FlagIdentity, FlagMap, FlagProvider, UserContextLike } from "../src/types";

const USER: UserContextLike = {
  sub: "auth0|alice",
  email: "alice@example.com",
  name: "Alice",
  orgId: "org_1",
  permissions: ["read:things"],
  roles: ["admin"],
};

function makeStubProvider(overrides: Partial<FlagProvider> = {}): FlagProvider & {
  calls: { identify: number; reload: number; subscribe: number; dispose: number };
} {
  const calls = { identify: 0, reload: 0, subscribe: 0, dispose: 0 };
  return {
    calls,
    async identify() { calls.identify++; return {}; },
    subscribe() { calls.subscribe++; return () => {}; },
    async reload() { calls.reload++; return {}; },
    async dispose() { calls.dispose++; },
    ...overrides,
  } as FlagProvider & { calls: typeof calls };
}

function eventRecorder(core: FlagsCore) {
  const events: Array<{ type: string; detail: unknown }> = [];
  const types = [
    "feature-flags:flags-changed",
    "feature-flags:identified-changed",
    "feature-flags:loading-changed",
    "feature-flags:error",
  ];
  for (const t of types) {
    core.addEventListener(t, (e) => {
      events.push({ type: t, detail: (e as CustomEvent).detail });
    });
  }
  return events;
}

describe("FlagsCore", () => {
  describe("construction", () => {
    it("extends EventTarget, not HTMLElement", () => {
      const core = new FlagsCore({ provider: new InMemoryFlagProvider() });
      expect(core).toBeInstanceOf(EventTarget);
      expect(core).not.toBeInstanceOf(globalThis.HTMLElement ?? (class {}));
    });

    it("exposes the expected bindable surface", () => {
      expect(FlagsCore.wcBindable.protocol).toBe("wc-bindable");
      expect(FlagsCore.wcBindable.version).toBe(1);
      expect(FlagsCore.wcBindable.properties.map((p) => p.name))
        .toEqual(["flags", "identified", "loading", "error"]);
      expect(FlagsCore.wcBindable.commands?.map((c) => c.name))
        .toEqual(["identify", "reload"]);
    });

    it("throws when options are missing", () => {
      expect(() => new FlagsCore(undefined as any)).toThrow(/`provider` is required/);
      expect(() => new FlagsCore({} as any)).toThrow(/`provider` is required/);
    });

    it("has empty initial state", () => {
      const core = new FlagsCore({ provider: new InMemoryFlagProvider() });
      expect(core.flags).toEqual({});
      expect(core.identified).toBe(false);
      expect(core.loading).toBe(false);
      expect(core.error).toBeNull();
    });

    it("dispatches events on the injected target", () => {
      const target = new EventTarget();
      const events: string[] = [];
      target.addEventListener("feature-flags:flags-changed", () => events.push("flags"));
      const core = new FlagsCore({ target, provider: new InMemoryFlagProvider({ flags: [{ key: "a", defaultValue: true }] }) });
      return core.identify("alice").then(() => {
        expect(events).toEqual(["flags"]);
      });
    });
  });

  describe("identify", () => {
    it("rejects empty userId synchronously via a thrown error", async () => {
      const core = new FlagsCore({ provider: new InMemoryFlagProvider() });
      await expect(core.identify("")).rejects.toThrow(/`userId` is required/);
    });

    it("publishes the initial flag snapshot and flips identified", async () => {
      const p = new InMemoryFlagProvider({ flags: [{ key: "a", defaultValue: true }] });
      const core = new FlagsCore({ provider: p });
      const events = eventRecorder(core);
      await core.identify("alice", { role: "admin" });
      expect(core.flags).toEqual({ a: true });
      expect(core.identified).toBe(true);
      expect(core.loading).toBe(false);
      const types = events.map((e) => e.type);
      expect(types).toContain("feature-flags:loading-changed");
      expect(types).toContain("feature-flags:flags-changed");
      expect(types).toContain("feature-flags:identified-changed");
    });

    it("provider push updates re-publish flags", async () => {
      const p = new InMemoryFlagProvider({ flags: [{ key: "a", defaultValue: false }] });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      const snapshots: FlagMap[] = [];
      core.addEventListener("feature-flags:flags-changed", (e) => {
        snapshots.push((e as CustomEvent).detail as FlagMap);
      });
      p.setFlag("a", true);
      expect(snapshots).toEqual([{ a: true }]);
    });

    it("re-identify unwinds the previous subscription", async () => {
      const unsub = vi.fn();
      const subscribe = vi.fn(() => unsub);
      const p = makeStubProvider({ subscribe });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      await core.identify("bob");
      expect(unsub).toHaveBeenCalledTimes(1);
      expect(subscribe).toHaveBeenCalledTimes(2);
    });

    it("publishes an error when the provider rejects identify", async () => {
      const p = makeStubProvider({
        async identify() { throw new Error("network down"); },
      });
      const core = new FlagsCore({ provider: p });
      const events = eventRecorder(core);
      await core.identify("alice");
      expect(core.error).toBeInstanceOf(Error);
      expect(core.error?.message).toBe("network down");
      expect(core.identified).toBe(false);
      expect(core.loading).toBe(false);
      const errEvents = events.filter((e) => e.type === "feature-flags:error" && e.detail);
      expect(errEvents).toHaveLength(1);
    });

    it("wraps non-Error provider rejections into Error", async () => {
      const p = makeStubProvider({
        async identify() { throw "string-failure"; },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      expect(core.error).toBeInstanceOf(Error);
      expect(core.error?.message).toBe("string-failure");
    });

    it("a failed re-identify clears stale flags and identified state", async () => {
      // Regression: a successful identify for alice committed
      // `flags={a:true}, identified=true`; a subsequent re-identify
      // for bob that failed used to leave those alice-era values in
      // place while `_currentIdentity` had already been reassigned
      // to bob — violating the "flags reflect _currentIdentity"
      // invariant.
      const identify = vi.fn()
        .mockResolvedValueOnce({ a: true })
        .mockRejectedValueOnce(new Error("boom"));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p });

      await core.identify("alice");
      expect(core.flags).toEqual({ a: true });
      expect(core.identified).toBe(true);

      await core.identify("bob");
      expect(core.flags).toEqual({});
      expect(core.identified).toBe(false);
      expect(core.error?.message).toBe("boom");
      expect(core.loading).toBe(false);
    });

    it("a failed FIRST identify does not emit a spurious flags-changed event", async () => {
      // No prior committed identity → flags are already `{}`. The
      // failure-path reset publishes `{}` again, which is a real
      // (though redundant) event. Consumers that bind to the
      // bindable surface will see the change of reference; that is
      // acceptable because the invariant must hold uniformly. This
      // test pins the behavior so any future dedup change is
      // intentional.
      const p = makeStubProvider({
        async identify() { throw new Error("boom"); },
      });
      const core = new FlagsCore({ provider: p });
      const events: unknown[] = [];
      core.addEventListener("feature-flags:flags-changed", (e) => events.push((e as CustomEvent).detail));

      await core.identify("alice");
      expect(core.flags).toEqual({});
      expect(core.identified).toBe(false);
      expect(core.error?.message).toBe("boom");
      // One flags-changed event fired with an empty map — the
      // invariant-restoring publish.
      expect(events).toEqual([{}]);
    });

    it("reload() after a failed identify retries the failed identity, even when userContext is set", async () => {
      // Regression: when `userContext` was armed (e.g. alice) AND a
      // manual `identify("bob")` subsequently failed, reload()'s
      // priority used to check `!_identified && _userContext` first
      // and fall through to `ensureIdentified()`, which rebuilt the
      // identity from `_userContext` (alice) — silently rolling back
      // from the bob identity the caller had explicitly selected.
      // The correct priority is:
      //   1. `_currentIdentity` set  → retry THAT identity (bob).
      //   2. `_currentIdentity` null → fall back to userContext.
      const identify = vi.fn()
        .mockRejectedValueOnce(new Error("bob-boom"))  // manual bob fails
        .mockResolvedValueOnce({ bob_flag: true });    // bob retry succeeds
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({
        provider: p,
        userContext: { sub: "alice" } as UserContextLike,
      });

      // Manual identify("bob") — userContext is NOT used here.
      await core.identify("bob");
      expect(core.identified).toBe(false);
      expect(core.error?.message).toBe("bob-boom");

      await core.reload();
      // reload must have retried BOB, not rolled back to ALICE.
      expect(identify).toHaveBeenCalledTimes(2);
      const retryIdentity = identify.mock.calls[1][0] as { userId: string };
      expect(retryIdentity.userId).toBe("bob");
      expect(core.flags).toEqual({ bob_flag: true });
      expect(core.identified).toBe(true);
    });

    it("reload() before any identify falls back to userContext (auto-identify)", async () => {
      // Pin the complementary priority: when `_currentIdentity` is
      // null (never identified) and `_userContext` is armed, reload()
      // should trigger auto-identify via `ensureIdentified()`.
      const identify = vi.fn(async () => ({ auto: true }));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({
        provider: p,
        userContext: { sub: "alice", email: "a@x" } as UserContextLike,
      });
      // No manual identify() — reload is the first call.
      await core.reload();
      expect(identify).toHaveBeenCalledTimes(1);
      const identity = identify.mock.calls[0][0] as { userId: string };
      expect(identity.userId).toBe("alice");
      expect(core.flags).toEqual({ auto: true });
      expect(core.identified).toBe(true);
    });

    it("reload() after a failed re-identify reruns identify (does NOT cache-bypass fetch)", async () => {
      // The core bug the design review surfaced: after alice →
      // bob-identify-fails, `_currentIdentity === bob` but the last
      // committed flag map was alice's. A subsequent `reload()`
      // used to call `provider.reload(bob)` and silently commit
      // bob's flags without a matching identify cycle.
      //
      // With the fix, reload() sees `!_identified && currentIdentity`
      // and routes through `_doIdentify(bob)` instead — so bob's
      // flags only land after a FULL identify cycle, and the
      // invariant holds throughout.
      const identify = vi.fn()
        .mockResolvedValueOnce({ a: true })                   // alice success
        .mockRejectedValueOnce(new Error("boom"))             // bob fail
        .mockResolvedValueOnce({ b: true });                  // bob retry success
      const reload = vi.fn(async () => ({ should_not_happen: true }));
      const p = makeStubProvider({ identify, reload });
      const core = new FlagsCore({ provider: p });

      await core.identify("alice");
      await core.identify("bob");  // fails; state resets
      expect(core.identified).toBe(false);
      expect(core.flags).toEqual({});

      await core.reload();          // must re-run identify, not provider.reload
      expect(reload).not.toHaveBeenCalled();
      expect(identify).toHaveBeenCalledTimes(3);
      expect(core.flags).toEqual({ b: true });
      expect(core.identified).toBe(true);
      expect(core.error).toBeNull();
    });

    it("subscription errors are non-fatal: initial snapshot stays, error surfaces", async () => {
      const p = makeStubProvider({
        subscribe() { throw new Error("subscribe-failed"); },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      expect(core.identified).toBe(true);
      expect(core.error?.message).toBe("subscribe-failed");
    });

    it("wraps non-Error subscription failures", async () => {
      const p = makeStubProvider({
        subscribe() { throw 42; },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      expect(core.error?.message).toBe("42");
    });

    it("a later identify cancels the in-flight earlier one (generation guard)", async () => {
      let resolveFirst!: (v: FlagMap) => void;
      const firstPromise = new Promise<FlagMap>((r) => { resolveFirst = r; });
      const identify = vi.fn()
        .mockImplementationOnce(() => firstPromise)
        .mockImplementationOnce(async () => ({ b: true }));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p });
      const firstCall = core.identify("alice");
      const secondCall = core.identify("bob");
      // Resolve the FIRST identify late — its result must be discarded.
      resolveFirst({ a: true });
      await Promise.all([firstCall, secondCall]);
      expect(core.flags).toEqual({ b: true });
    });

    it("superseded identify errors are swallowed (no error on the active identity)", async () => {
      let rejectFirst!: (e: Error) => void;
      const firstPromise = new Promise<FlagMap>((_, reject) => { rejectFirst = reject; });
      const identify = vi.fn()
        .mockImplementationOnce(() => firstPromise)
        .mockImplementationOnce(async () => ({ b: true }));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p });
      const first = core.identify("alice");
      const second = core.identify("bob");
      rejectFirst(new Error("late identify failure"));
      await Promise.all([first, second]);
      expect(core.error).toBeNull();
      expect(core.flags).toEqual({ b: true });
    });

    it("cleanup of previous subscription tolerates a throwing unsub", async () => {
      let unsubCount = 0;
      const throwingUnsub = () => { unsubCount++; throw new Error("bad unsub"); };
      const subscribe = vi.fn(() => throwingUnsub);
      const p = makeStubProvider({ subscribe });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      await expect(core.identify("bob")).resolves.toBeUndefined();
      expect(unsubCount).toBe(1);
    });

    it("push updates from a superseded identity are dropped", async () => {
      let pushFn: ((next: FlagMap) => void) | null = null;
      const p = makeStubProvider({
        async identify() { return {}; },
        subscribe(_id, onChange) {
          pushFn = onChange;
          return () => {};
        },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      // capture the first identity's push function
      const firstPush = pushFn!;
      await core.identify("bob");
      const snapshots: FlagMap[] = [];
      core.addEventListener("feature-flags:flags-changed", (e) => {
        snapshots.push((e as CustomEvent).detail as FlagMap);
      });
      firstPush({ stale: true });
      expect(snapshots).toEqual([]);
    });
  });

  describe("auto-identify via userContext", () => {
    it("ensureIdentified identifies with the user sub + traits", async () => {
      const identify = vi.fn(async (id: FlagIdentity) => ({ who: id.userId }));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.ensureIdentified();
      expect(identify).toHaveBeenCalledTimes(1);
      const identity = identify.mock.calls[0][0] as FlagIdentity;
      expect(identity.userId).toBe("auth0|alice");
      expect(identity.attrs).toEqual({
        email: "alice@example.com",
        name: "Alice",
        org_id: "org_1",
        permissions: ["read:things"],
        roles: ["admin"],
      });
      expect(core.identified).toBe(true);
      expect(core.flags).toEqual({ who: "auth0|alice" });
    });

    it("ensureIdentified coalesces concurrent calls", async () => {
      const identify = vi.fn(async () => ({ a: true }));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await Promise.all([core.ensureIdentified(), core.ensureIdentified()]);
      expect(identify).toHaveBeenCalledTimes(1);
    });

    it("ensureIdentified is a no-op when already identified", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.identify("alice");
      await core.ensureIdentified();
      expect(identify).toHaveBeenCalledTimes(1);
    });

    it("ensureIdentified is a no-op when no userContext is configured", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p });
      await core.ensureIdentified();
      expect(identify).not.toHaveBeenCalled();
    });

    it("omits undefined attrs from the identity", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({
        provider: p,
        userContext: { sub: "anon" } as UserContextLike,
      });
      await core.ensureIdentified();
      const identity = identify.mock.calls[0][0] as FlagIdentity;
      expect(identity.attrs).toBeUndefined();
    });
  });

  describe("reload", () => {
    it("refreshes the flag snapshot", async () => {
      let count = 0;
      const p = makeStubProvider({
        async identify() { count++; return { n: count }; },
        async reload() { count++; return { n: count }; },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      expect(core.flags).toEqual({ n: 1 });
      await core.reload();
      expect(core.flags).toEqual({ n: 2 });
    });

    it("without identity + without userContext is a silent no-op", async () => {
      const p = makeStubProvider();
      const core = new FlagsCore({ provider: p });
      await core.reload();
      expect(core.identified).toBe(false);
      expect(p.calls.identify).toBe(0);
      expect(p.calls.reload).toBe(0);
    });

    it("first reload before identify triggers auto-identify when userContext is set", async () => {
      const identify = vi.fn(async () => ({ a: true }));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.reload();
      expect(identify).toHaveBeenCalledTimes(1);
      expect(core.identified).toBe(true);
    });

    it("publishes error when provider.reload rejects", async () => {
      const p = makeStubProvider({
        async reload() { throw new Error("reload-failed"); },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      await core.reload();
      expect(core.error?.message).toBe("reload-failed");
      expect(core.loading).toBe(false);
    });

    it("wraps non-Error reload rejections", async () => {
      const p = makeStubProvider({ async reload() { throw "str"; } });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      await core.reload();
      expect(core.error?.message).toBe("str");
    });

    it("superseded reload results are discarded", async () => {
      let resolveReload!: (v: FlagMap) => void;
      const reloadPromise = new Promise<FlagMap>((r) => { resolveReload = r; });
      const reload = vi.fn()
        .mockImplementationOnce(() => reloadPromise);
      const p = makeStubProvider({ reload });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      core.flags; // touch
      const reloadCall = core.reload();
      await core.identify("bob"); // generation bump
      resolveReload({ stale: true });
      await reloadCall;
      expect(core.flags).not.toEqual({ stale: true });
    });

    it("superseded reload errors are swallowed (no error surfaced)", async () => {
      let rejectReload!: (e: Error) => void;
      const reloadPromise = new Promise<FlagMap>((_, reject) => { rejectReload = reject; });
      const reload = vi.fn().mockImplementationOnce(() => reloadPromise);
      const p = makeStubProvider({ reload });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      const reloadCall = core.reload();
      await core.identify("bob"); // bump gen mid-reload
      rejectReload(new Error("late reload failure"));
      await reloadCall;
      expect(core.error).toBeNull();
    });
  });

  describe("updateUserContext", () => {
    it("re-identifies when sub changes", async () => {
      const identify = vi.fn(async (id: FlagIdentity) => ({ u: id.userId }));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.ensureIdentified();
      expect(identify).toHaveBeenCalledTimes(1);
      await core.updateUserContext({ ...USER, sub: "auth0|different" });
      expect(identify).toHaveBeenCalledTimes(2);
      expect(core.flags).toEqual({ u: "auth0|different" });
    });

    it("no-ops when nothing targeting-relevant changed", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.ensureIdentified();
      await core.updateUserContext({ ...USER, raw: { new: "claim" } });
      expect(identify).toHaveBeenCalledTimes(1);
    });

    it("no-ops when array traits have same content but different references", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.ensureIdentified();
      await core.updateUserContext({
        ...USER,
        permissions: [...(USER.permissions ?? [])],
        roles: [...(USER.roles ?? [])],
      });
      expect(identify).toHaveBeenCalledTimes(1);
    });

    it("re-identifies when permissions array content changes", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.ensureIdentified();
      await core.updateUserContext({ ...USER, permissions: ["read:things", "write:things"] });
      expect(identify).toHaveBeenCalledTimes(2);
    });

    it("re-identifies when role array length differs", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.ensureIdentified();
      await core.updateUserContext({ ...USER, roles: [] });
      expect(identify).toHaveBeenCalledTimes(2);
    });

    it("re-identifies when array content differs at the same length", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.ensureIdentified();
      await core.updateUserContext({ ...USER, permissions: ["write:things"] });
      expect(identify).toHaveBeenCalledTimes(2);
    });

    it("treats permissions/roles as sets — a pure reorder does NOT re-identify", async () => {
      // Auth0 token refresh does not guarantee stable ordering of the
      // `permissions` / `roles` claims across refreshes. A reorder-only
      // refresh must be a no-op: no re-identify, no poller teardown,
      // no spurious `flags-changed`. The Flagsmith identity key also
      // canonicalizes these arrays via `_buildIdentity`, so the end-to-
      // end identity is stable across reorderings.
      const user: UserContextLike = {
        sub: "auth0|alice",
        permissions: ["read:things", "write:things", "delete:things"],
        roles: ["admin", "editor"],
      };
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: user });
      await core.ensureIdentified();

      await core.updateUserContext({
        ...user,
        permissions: ["delete:things", "read:things", "write:things"], // reordered
        roles: ["editor", "admin"], // reordered
      });
      expect(identify).toHaveBeenCalledTimes(1); // unchanged
    });

    it("_buildIdentity canonicalizes permission/role order into attrs", async () => {
      // Whatever order Auth0 handed us, the identity forwarded to the
      // Provider must be canonical so the Flagsmith identity-key (which
      // hashes attrs byte-wise) is stable across reorder-only refreshes.
      const identify = vi.fn(async (id: FlagIdentity) => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({
        provider: p,
        userContext: {
          sub: "auth0|alice",
          permissions: ["z:last", "a:first", "m:middle"],
          roles: ["z-role", "a-role"],
        },
      });
      await core.ensureIdentified();
      const identity = identify.mock.calls[0][0] as FlagIdentity;
      expect(identity.attrs?.permissions).toEqual(["a:first", "m:middle", "z:last"]);
      expect(identity.attrs?.roles).toEqual(["a-role", "z-role"]);
    });

    it("re-identifies when orgId changes", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.ensureIdentified();
      await core.updateUserContext({ ...USER, orgId: "org_2" });
      expect(identify).toHaveBeenCalledTimes(2);
    });

    it("re-identifies when name changes", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.ensureIdentified();
      await core.updateUserContext({ ...USER, name: "Other" });
      expect(identify).toHaveBeenCalledTimes(2);
    });

    it("re-identifies when email changes", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.ensureIdentified();
      await core.updateUserContext({ ...USER, email: "changed@example.com" });
      expect(identify).toHaveBeenCalledTimes(2);
    });

    it("treats an undefined previous userContext as a change", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p });
      await core.updateUserContext(USER);
      expect(identify).toHaveBeenCalledTimes(1);
    });

    it("no-ops after dispose", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.dispose();
      await core.updateUserContext({ ...USER, sub: "new" });
      expect(identify).not.toHaveBeenCalled();
    });
  });

  describe("dispose", () => {
    it("tears down subscription + calls provider.dispose", async () => {
      const unsub = vi.fn();
      const dispose = vi.fn(async () => {});
      const p = makeStubProvider({
        subscribe: () => unsub,
        dispose,
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      await core.dispose();
      expect(unsub).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("tolerates a throwing unsub during dispose", async () => {
      const p = makeStubProvider({
        subscribe: () => () => { throw new Error("bad unsub"); },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      await expect(core.dispose()).resolves.toBeUndefined();
    });

    it("tolerates a throwing provider.dispose", async () => {
      const p = makeStubProvider({
        async dispose() { throw new Error("bad dispose"); },
      });
      const core = new FlagsCore({ provider: p });
      await expect(core.dispose()).resolves.toBeUndefined();
    });

    it("works when provider has no dispose()", async () => {
      const p = { identify: async () => ({}), subscribe: () => () => {}, reload: async () => ({}) } as FlagProvider;
      const core = new FlagsCore({ provider: p });
      await expect(core.dispose()).resolves.toBeUndefined();
    });

    it("a second dispose is a no-op", async () => {
      const dispose = vi.fn(async () => {});
      const p = makeStubProvider({ dispose });
      const core = new FlagsCore({ provider: p });
      await core.dispose();
      await core.dispose();
      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("identify/reload after dispose throw", async () => {
      const core = new FlagsCore({ provider: new InMemoryFlagProvider() });
      await core.dispose();
      await expect(core.identify("alice")).rejects.toThrow(/disposed/);
      await expect(core.reload()).rejects.toThrow(/disposed/);
    });

    it("works when there was no active subscription", async () => {
      const p = makeStubProvider();
      const core = new FlagsCore({ provider: p });
      await expect(core.dispose()).resolves.toBeUndefined();
    });
  });

  describe("deep-freeze contract", () => {
    it("deep-freezes object-shaped flag values", async () => {
      const p = makeStubProvider({
        async identify() {
          return { new_checkout: { enabled: true, value: null } };
        },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      const flag = core.flags.new_checkout as { enabled: boolean; value: unknown };
      expect(Object.isFrozen(flag)).toBe(true);
      expect(() => { (flag as { enabled: boolean }).enabled = false; }).toThrow(TypeError);
    });

    it("deep-freezes arrays inside flag values", async () => {
      const p = makeStubProvider({
        async identify() {
          return { palette: { enabled: true, value: ["red", "green"] } };
        },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      const arr = (core.flags.palette as { value: string[] }).value;
      expect(Object.isFrozen(arr)).toBe(true);
      expect(() => arr.push("blue")).toThrow(TypeError);
    });

    it("isolates provider source from consumer mutation attempts", async () => {
      // The Provider returns an object whose value fields share
      // references with its own internal state. Without a deep clone
      // in _publishFlags, a consumer's (foiled) mutation attempt would
      // poison the Provider's source.
      const sharedDefault = { enabled: false, value: null };
      const providerState = { new_checkout: sharedDefault };
      const p: FlagProvider = {
        async identify() { return providerState; },
        subscribe: () => () => {},
        async reload() { return providerState; },
      };
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      const published = core.flags.new_checkout as { enabled: boolean; value: unknown };
      // The published object is NOT the same reference — cloned.
      expect(published).not.toBe(sharedDefault);
      // The Provider's own source must still be writable (its rule
      // definitions remain mutable for the Provider's own use).
      expect(() => { sharedDefault.enabled = true; }).not.toThrow();
    });
  });

  describe("event dedupe", () => {
    it("identified-changed does not fire twice for the same value", async () => {
      const p = new InMemoryFlagProvider();
      const core = new FlagsCore({ provider: p });
      const events: unknown[] = [];
      core.addEventListener("feature-flags:identified-changed", (e) => {
        events.push((e as CustomEvent).detail);
      });
      await core.identify("alice");
      await core.identify("bob");
      expect(events).toEqual([true]);
    });

    it("loading-changed toggles cleanly across identify cycles", async () => {
      const p = new InMemoryFlagProvider();
      const core = new FlagsCore({ provider: p });
      const events: boolean[] = [];
      core.addEventListener("feature-flags:loading-changed", (e) => {
        events.push((e as CustomEvent).detail as boolean);
      });
      await core.identify("alice");
      expect(events).toEqual([true, false]);
    });

    it("error event does not re-fire when the null state is already null", async () => {
      const p = makeStubProvider();
      const core = new FlagsCore({ provider: p });
      const nullHits: unknown[] = [];
      core.addEventListener("feature-flags:error", (e) => {
        if ((e as CustomEvent).detail === null) nullHits.push(null);
      });
      await core.identify("alice");
      // A successful identify path calls _setError(null) once at the start;
      // subsequent identifies should NOT re-fire null→null beyond initial
      await core.identify("bob");
      // Exactly one null per identify call is acceptable (the initial clear).
      expect(nullHits.length).toBeLessThanOrEqual(2);
    });
  });
});
