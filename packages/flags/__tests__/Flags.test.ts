import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { bootstrapFlags } from "../src/bootstrapFlags";
import type { Flags } from "../src/components/Flags";
import type { FlagMap } from "../src/types";

bootstrapFlags();

// Minimal session element that matches the SessionLike shape used by
// <feature-flags>. Holds a proxy (EventTarget with getters + invoke()),
// a `ready` boolean, and fires `auth0-session:ready-changed`.
class MockSession extends HTMLElement {
  proxy: (EventTarget & {
    constructor: { wcBindable: unknown };
    invoke: (name: string, ...args: unknown[]) => Promise<unknown>;
    flags: FlagMap;
    identified: boolean;
    loading: boolean;
    error: Error | null;
    _publish: (name: string, value: unknown) => void;
  }) | null = null;
  ready = false;

  setReady(value: boolean): void {
    this.ready = value;
    this.dispatchEvent(new CustomEvent("auth0-session:ready-changed", {
      detail: value,
      bubbles: true,
    }));
  }

  attachProxy(): void {
    const PROXY_EVENT_PREFIX = "@wc-bindable/remote:";
    const declProps = [
      { name: "flags", event: PROXY_EVENT_PREFIX + "flags" },
      { name: "identified", event: PROXY_EVENT_PREFIX + "identified" },
      { name: "loading", event: PROXY_EVENT_PREFIX + "loading" },
      { name: "error", event: PROXY_EVENT_PREFIX + "error" },
    ];
    const target = new EventTarget() as any;
    const values: Record<string, unknown> = {};
    for (const p of declProps) {
      Object.defineProperty(target, p.name, {
        configurable: true,
        get: () => values[p.name],
      });
    }
    target.invoke = async (name: string, ...args: unknown[]) => {
      target.__lastInvoke = { name, args };
      return undefined;
    };
    target._publish = (name: string, value: unknown) => {
      values[name] = value;
      const event = declProps.find((p) => p.name === name)?.event;
      if (event) target.dispatchEvent(new CustomEvent(event, { detail: value }));
    };
    Object.defineProperty(target.constructor, "wcBindable", {
      configurable: true,
      value: { protocol: "wc-bindable", version: 1, properties: declProps },
    });
    this.proxy = target;
  }
}
customElements.define("mock-session", MockSession);

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((r) => queueMicrotask(() => r()));
}

function makeSession(id = "sess"): MockSession {
  const s = document.createElement("mock-session") as MockSession;
  s.id = id;
  document.body.appendChild(s);
  s.attachProxy();
  return s;
}

function makeFlagsEl(target = "sess"): Flags {
  const el = document.createElement("feature-flags") as Flags;
  el.target = target;
  document.body.appendChild(el);
  return el;
}

describe("<feature-flags>", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("registered as a custom element", () => {
    expect(customElements.get("feature-flags")).toBeDefined();
  });

  it("exposes the expected bindable surface", async () => {
    const { Flags } = await import("../src/components/Flags");
    expect(Flags.wcBindable.properties.map((p) => p.name))
      .toEqual(["flags", "identified", "loading", "error"]);
    expect(Flags.wcBindable.commands?.map((c) => c.name))
      .toEqual(["identify", "reload"]);
  });

  it("target attribute round-trips", () => {
    const el = makeFlagsEl("abc");
    expect(el.target).toBe("abc");
    el.target = "xyz";
    expect(el.getAttribute("target")).toBe("xyz");
  });

  it("publishes an error when target does not resolve", async () => {
    const el = makeFlagsEl("does-not-exist");
    await flush();
    expect(el.error).not.toBeNull();
    expect(el.error?.message).toMatch(/target "does-not-exist"/);
  });

  it("recovers when the target session is inserted AFTER <feature-flags>", async () => {
    // Regression: framework / SSR-hydrate / async-mount ordering
    // sometimes lands <feature-flags> in the DOM before its target
    // session. Before the fix this left the element permanently
    // stuck with `error` set and `flags = {}` even after the target
    // appeared. The rescue observer retries resolution on DOM
    // mutations and clears the error once the target shows up.
    const el = makeFlagsEl("late");
    await flush();
    expect(el.error).not.toBeNull();

    // Now insert the late-bound session.
    const sess = makeSession("late");
    sess.ready = true;
    // MutationObserver callbacks fire on the next microtask boundary
    // — yield enough for the observer to pick up the insertion.
    await flush();
    await flush();

    expect(el.error).toBeNull();
    sess.proxy!._publish("flags", { late_flag: true });
    expect(el.flags).toEqual({ late_flag: true });
  });

  it("keeps observing if an unrelated element is inserted first", async () => {
    const el = makeFlagsEl("late");
    await flush();
    expect(el.error).not.toBeNull();

    // Unrelated insertion — observer fires but resolve still fails.
    const decoy = document.createElement("div");
    decoy.id = "decoy";
    document.body.appendChild(decoy);
    await flush();
    await flush();
    expect(el.error).not.toBeNull();

    // Actual target arrives — observer reattempts and succeeds.
    const sess = makeSession("late");
    sess.ready = true;
    await flush();
    await flush();
    expect(el.error).toBeNull();
    expect(el.flags).toEqual({});
  });

  it("the rescue observer disconnects on disconnectedCallback", async () => {
    const el = makeFlagsEl("gone");
    await flush();
    expect(el.error).not.toBeNull();

    // Detach the element — observer must be torn down.
    el.remove();

    // A subsequent matching insert must NOT re-attach (element is
    // disconnected, and even if the observer fired it would abort).
    const sess = makeSession("gone");
    sess.ready = true;
    await flush();
    await flush();

    // Element stays detached, no listeners to assert — sanity check:
    // emitting from the session should not reach the old element.
    let hits = 0;
    el.addEventListener("feature-flags:flags-changed", () => hits++);
    sess.proxy!._publish("flags", { should_not_fire: true });
    expect(hits).toBe(0);
  });

  it("recovers when the target element exists but its proxy/ready are ASSIGNED in place later", async () => {
    // Regression: `<feature-flags>`'s structural contract is "any
    // element exposing `.proxy` / `.ready`". MutationObserver only
    // sees DOM-tree / attribute mutations — NOT property writes —
    // so a matching `<div id="late">` that gets its session surface
    // grafted on afterwards (custom-element upgrade, imperative
    // SDK wiring) was leaving <feature-flags> permanently stuck.
    vi.useFakeTimers();
    try {
      // Plain container present BEFORE <feature-flags>, but lacking
      // `.proxy` / `.ready` — fails the structural check.
      const late = document.createElement("div");
      late.id = "late";
      document.body.appendChild(late);

      const el = makeFlagsEl("late");
      await vi.advanceTimersByTimeAsync(0);
      expect(el.error).not.toBeNull();

      // Now graft the session surface onto the existing element —
      // pure property assignments. MutationObserver cannot observe
      // these; only the 200 ms poll fallback picks them up.
      const PROXY_EVENT_PREFIX = "@wc-bindable/remote:";
      const declProps = [
        { name: "flags", event: PROXY_EVENT_PREFIX + "flags" },
        { name: "identified", event: PROXY_EVENT_PREFIX + "identified" },
        { name: "loading", event: PROXY_EVENT_PREFIX + "loading" },
        { name: "error", event: PROXY_EVENT_PREFIX + "error" },
      ];
      const target = new EventTarget() as any;
      const values: Record<string, unknown> = { flags: { grafted: true } };
      for (const p of declProps) {
        Object.defineProperty(target, p.name, { configurable: true, get: () => values[p.name] });
      }
      target.invoke = async () => undefined;
      Object.defineProperty(target.constructor, "wcBindable", {
        configurable: true,
        value: { protocol: "wc-bindable", version: 1, properties: declProps },
      });
      (late as any).proxy = target;
      (late as any).ready = true;

      // Advance past one poll interval.
      await vi.advanceTimersByTimeAsync(250);
      expect(el.error).toBeNull();
      expect(el.flags).toEqual({ grafted: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers when the target gets its `id` attribute set AFTER insertion", async () => {
    // An element is already in the DOM but without the matching id.
    // Later it's branded with `id="late"` via attribute set — this
    // is a mutation MutationObserver DOES see (when we filter on
    // `id`), so rescue should complete without needing the poll
    // fallback.
    vi.useFakeTimers();
    try {
      const sess = document.createElement("mock-session") as MockSession;
      // Intentionally no id yet.
      document.body.appendChild(sess);
      sess.attachProxy();
      sess.ready = true;

      const el = makeFlagsEl("late");
      await vi.advanceTimersByTimeAsync(0);
      expect(el.error).not.toBeNull();

      sess.id = "late";
      // A single microtask tick lets MutationObserver drain without
      // needing a full poll interval.
      await vi.advanceTimersByTimeAsync(0);
      expect(el.error).toBeNull();
      sess.proxy!._publish("flags", { branded: true });
      expect(el.flags).toEqual({ branded: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rescue stops itself after ~30s if the target never arrives", async () => {
    // Regression guard for [R1-01]: without a lifetime cap, a
    // `<feature-flags target="gone">` whose target is misconfigured
    // would keep a 200 ms setInterval running forever. 30 s is
    // generous for any plausible hydration / SSR cycle; a target
    // that hasn't appeared by then is a config bug, not a race.
    vi.useFakeTimers();
    try {
      const el = makeFlagsEl("never-ever");
      await vi.advanceTimersByTimeAsync(0);
      expect(el.error).not.toBeNull();

      // Let the rescue run past its hard cap.
      await vi.advanceTimersByTimeAsync(31_000);

      // Now drop a matching session in — the rescue should NOT
      // resurrect, because its triggers were torn down by the cap.
      const sess = makeSession("never-ever");
      sess.ready = true;
      await vi.advanceTimersByTimeAsync(500);
      // flags stays empty and error stays set: rescue really is off.
      expect(el.flags).toEqual({});
      expect(el.error).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("poll timer is cleared on disconnectedCallback even when target never arrives", async () => {
    vi.useFakeTimers();
    try {
      const el = makeFlagsEl("never");
      await vi.advanceTimersByTimeAsync(0);
      expect(el.error).not.toBeNull();
      el.remove();
      // Run a long while — no work should happen, no errors thrown.
      await vi.advanceTimersByTimeAsync(10_000);
      // State stays where we left it; timer was cleared cleanly.
      expect(el.error).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("changing the target attribute disconnects the prior rescue observer", async () => {
    // If `target` is flipped from "first" to "second" before the
    // first target is ever inserted, the old observer must be
    // disconnected so a "first" element that arrives later cannot
    // drive a late attach to the wrong session.
    const el = makeFlagsEl("first");
    await flush();
    expect(el.error).not.toBeNull();

    el.target = "second";
    await flush();
    expect(el.error).not.toBeNull();  // "second" doesn't exist yet

    // Inserting the ORIGINAL target must not resolve — we are now
    // watching for "second".
    const firstSess = makeSession("first");
    firstSess.ready = true;
    firstSess.proxy!._publish("flags", { wrong: true });
    await flush();
    await flush();
    expect(el.flags).toEqual({});
    expect(el.error).not.toBeNull();

    // Inserting the NEW target resolves cleanly.
    const secondSess = makeSession("second");
    secondSess.ready = true;
    await flush();
    await flush();
    expect(el.error).toBeNull();
    secondSess.proxy!._publish("flags", { right: true });
    expect(el.flags).toEqual({ right: true });
  });

  it("binds to proxy once the target becomes ready", async () => {
    const sess = makeSession("sess");
    const el = makeFlagsEl("sess");
    await flush();
    const seen: FlagMap[] = [];
    el.addEventListener("feature-flags:flags-changed", (e) => {
      seen.push((e as CustomEvent).detail as FlagMap);
    });

    sess.proxy!._publish("flags", { a: true });
    sess.setReady(true);
    sess.proxy!._publish("flags", { a: false });

    expect(seen[seen.length - 1]).toEqual({ a: false });
    expect(el.flags).toEqual({ a: false });
  });

  it("picks up proxy state that was already ready at attach time", async () => {
    const sess = makeSession("sess");
    sess.ready = true;
    sess.proxy!._publish("flags", { pre: true });
    const el = makeFlagsEl("sess");
    await flush();
    expect(el.flags).toEqual({ pre: true });
  });

  it("re-dispatches identified / loading / error changes", async () => {
    const sess = makeSession();
    const el = makeFlagsEl();
    sess.ready = true;
    await flush();

    const events: Array<{ type: string; detail: unknown }> = [];
    for (const type of ["feature-flags:identified-changed", "feature-flags:loading-changed", "feature-flags:error"]) {
      el.addEventListener(type, (e) => events.push({ type, detail: (e as CustomEvent).detail }));
    }

    sess.proxy!._publish("identified", true);
    sess.proxy!._publish("loading", true);
    const err = new Error("push");
    sess.proxy!._publish("error", err);

    expect(el.identified).toBe(true);
    expect(el.loading).toBe(true);
    expect(el.error?.message).toBe("push");
    expect(events.some((e) => e.type === "feature-flags:identified-changed" && e.detail === true)).toBe(true);
    expect(events.some((e) => e.type === "feature-flags:loading-changed" && e.detail === true)).toBe(true);
  });

  it("unbinds when session signals ready=false but keeps last flag map", async () => {
    const sess = makeSession();
    const el = makeFlagsEl();
    sess.ready = true;
    await flush();
    sess.proxy!._publish("flags", { a: true });
    sess.setReady(false);
    // After ready=false, further proxy pushes must NOT leak through
    sess.proxy!._publish("flags", { a: false });
    expect(el.flags).toEqual({ a: true });
  });

  it("deep-freezes flag values from the proxy", async () => {
    const sess = makeSession();
    sess.ready = true;
    const el = makeFlagsEl();
    await flush();
    sess.proxy!._publish("flags", { new_checkout: { enabled: true, value: null } });
    const flag = el.flags.new_checkout as { enabled: boolean };
    expect(Object.isFrozen(flag)).toBe(true);
    expect(() => { (flag as { enabled: boolean }).enabled = false; }).toThrow(TypeError);
  });

  it("treats non-object flag values as empty map", async () => {
    const sess = makeSession();
    const el = makeFlagsEl();
    sess.ready = true;
    await flush();
    sess.proxy!._publish("flags", "not-an-object");
    expect(el.flags).toEqual({});
  });

  it("wraps non-Error error payloads", async () => {
    const sess = makeSession();
    const el = makeFlagsEl();
    sess.ready = true;
    await flush();
    sess.proxy!._publish("error", "plain string");
    expect(el.error?.message).toBe("plain string");
    sess.proxy!._publish("error", { toString() { return "boom"; } });
    expect(el.error?.message).toContain("boom");
  });

  it("clearing error back to null is idempotent", async () => {
    const sess = makeSession();
    const el = makeFlagsEl();
    sess.ready = true;
    await flush();
    let nullCount = 0;
    el.addEventListener("feature-flags:error", (e) => {
      if ((e as CustomEvent).detail === null) nullCount++;
    });
    sess.proxy!._publish("error", null);
    sess.proxy!._publish("error", null);
    expect(nullCount).toBe(0);
  });

  it("identified-changed is deduped when the same value is re-emitted", async () => {
    const sess = makeSession();
    const el = makeFlagsEl();
    sess.ready = true;
    await flush();
    let hits = 0;
    el.addEventListener("feature-flags:identified-changed", () => hits++);
    sess.proxy!._publish("identified", true);
    sess.proxy!._publish("identified", true);
    expect(hits).toBe(1);
  });

  it("loading-changed is deduped", async () => {
    const sess = makeSession();
    const el = makeFlagsEl();
    sess.ready = true;
    await flush();
    let hits = 0;
    el.addEventListener("feature-flags:loading-changed", () => hits++);
    sess.proxy!._publish("loading", true);
    sess.proxy!._publish("loading", true);
    expect(hits).toBe(1);
  });

  it("forwards identify() to the proxy", async () => {
    const sess = makeSession();
    const el = makeFlagsEl();
    sess.ready = true;
    await flush();
    await el.identify("alice", { role: "admin" });
    expect((sess.proxy as any).__lastInvoke).toEqual({
      name: "identify",
      args: ["alice", { role: "admin" }],
    });
  });

  it("forwards reload() to the proxy", async () => {
    const sess = makeSession();
    const el = makeFlagsEl();
    sess.ready = true;
    await flush();
    await el.reload();
    expect((sess.proxy as any).__lastInvoke).toEqual({ name: "reload", args: [] });
  });

  it("identify() without a proxy throws", async () => {
    const el = makeFlagsEl("missing");
    await flush();
    await expect(el.identify("alice")).rejects.toThrow(/proxy is attached/);
  });

  it("reload() without a proxy throws", async () => {
    const el = makeFlagsEl("missing");
    await flush();
    await expect(el.reload()).rejects.toThrow(/proxy is attached/);
  });

  it("a redundant ready=true does not double-subscribe", async () => {
    const sess = makeSession();
    const el = makeFlagsEl();
    // Wait for the element to attach its ready listener first, then
    // emit the two ready=true events — otherwise the listener misses
    // them and both `_bindToProxy` calls never happen.
    await flush();
    sess.setReady(true);
    sess.setReady(true);
    let hits = 0;
    el.addEventListener("feature-flags:flags-changed", () => hits++);
    sess.proxy!._publish("flags", { a: 1 });
    expect(hits).toBe(1);
  });

  it("tolerates ready=false when no subscription was active", async () => {
    const sess = makeSession();
    makeFlagsEl();
    await flush();
    expect(() => sess.setReady(false)).not.toThrow();
  });

  it("detaches on disconnectedCallback — subsequent ready signals are ignored", async () => {
    const sess = makeSession();
    const el = makeFlagsEl();
    sess.ready = true;
    await flush();
    let hits = 0;
    el.addEventListener("feature-flags:flags-changed", () => hits++);
    el.remove();
    sess.proxy!._publish("flags", { after: true });
    expect(hits).toBe(0);
  });

  it("re-attaches when target attribute changes", async () => {
    const a = makeSession("a");
    const b = makeSession("b");
    a.ready = true;
    b.ready = true;
    const el = makeFlagsEl("a");
    await flush();
    a.proxy!._publish("flags", { src: "a" });
    expect(el.flags).toEqual({ src: "a" });

    el.target = "b";
    await flush();
    b.proxy!._publish("flags", { src: "b" });
    expect(el.flags).toEqual({ src: "b" });
    // Pushes to the OLD session must no longer reach us
    a.proxy!._publish("flags", { src: "a-again" });
    expect(el.flags).toEqual({ src: "b" });
  });

  it("attributeChangedCallback coalesces bursts of attribute writes", async () => {
    const a = makeSession("a");
    a.ready = true;
    const el = makeFlagsEl("a");
    await flush();
    el.target = "b";
    el.target = "c";
    // A second synchronous write must not fire a second microtask-rescheduled attach
    await flush();
    expect(el.error).not.toBeNull(); // "c" does not exist
  });

  it("ignores attributeChangedCallback when disconnected", async () => {
    const a = makeSession("a");
    a.ready = true;
    const el = makeFlagsEl("a");
    await flush();
    el.remove();
    // Changing an attribute on a detached element must not restart binding
    el.setAttribute("target", "a");
    await flush();
    expect(el.error).toBeNull();
  });

  it("attr change → detach race: microtask exits if element detached before it runs", async () => {
    const a = makeSession("a");
    const b = makeSession("b");
    a.ready = true;
    b.ready = true;
    const el = makeFlagsEl("a");
    await flush();
    // Schedule the attribute-restart microtask, then detach synchronously
    // so the microtask observes `!this.isConnected` and returns early.
    el.setAttribute("target", "b");
    el.remove();
    await flush();
    // No attach to "b" happened — the microtask bailed.
    expect(el.error).toBeNull();
  });

  it("ignores attribute no-op (same value)", async () => {
    const a = makeSession("a");
    a.ready = true;
    const el = makeFlagsEl("a");
    await flush();
    // Setting the same value again should be a short-circuit branch
    el.setAttribute("target", "a");
    await flush();
    expect(el.error).toBeNull();
  });

  it("falls back gracefully when target element lacks proxy/ready", async () => {
    const bogus = document.createElement("div");
    bogus.id = "bogus";
    document.body.appendChild(bogus);
    const el = makeFlagsEl("bogus");
    await flush();
    expect(el.error).not.toBeNull();
  });

  it("falls back when target attribute is empty", async () => {
    const el = makeFlagsEl("");
    await flush();
    expect(el.error).not.toBeNull();
  });

  it("exits _attach cleanly if element is removed before the microtask runs", async () => {
    const sess = makeSession();
    const el = makeFlagsEl();
    el.remove();
    await flush();
    expect(el.flags).toEqual({});
    expect(el.error).toBeNull();
    // Prevent `sess` unused warning
    expect(sess.ready).toBe(false);
  });

  it("bindToProxy with a proxy that has no values yet leaves state untouched", async () => {
    const sess = makeSession();
    sess.ready = true;
    // Don't publish anything — proxy getters all return undefined.
    const el = makeFlagsEl();
    await flush();
    expect(el.flags).toEqual({});
    expect(el.identified).toBe(false);
  });

  it("skips bindToProxy when session has no proxy yet", async () => {
    const sess = makeSession();
    sess.proxy = null;
    sess.ready = true;
    const el = makeFlagsEl();
    await flush();
    // Neither an error nor any flag update — the bind call short-circuits.
    expect(el.flags).toEqual({});
    expect(el.error).toBeNull();
  });

  it("ignores ready-changed events with non-boolean details", async () => {
    const sess = makeSession();
    const el = makeFlagsEl();
    await flush();
    // Dispatch a ready-changed with a non-true, non-false detail —
    // the listener must fall through without action.
    sess.dispatchEvent(new CustomEvent("auth0-session:ready-changed", {
      detail: "weird",
      bubbles: true,
    }));
    expect(el.flags).toEqual({});
    expect(el.error).toBeNull();
  });

  it("ignores unknown proxy properties (forward compatibility)", async () => {
    // Augment the mock's declaration with a 5th property the Shell
    // does not recognize. Exercises the `default` branch in the
    // bind() switch.
    const sess = makeSession();
    sess.ready = true;
    const PROXY_EVENT_PREFIX = "@wc-bindable/remote:";
    const proxy = sess.proxy!;
    const currentDecl = (proxy.constructor as any).wcBindable;
    Object.defineProperty(proxy.constructor, "wcBindable", {
      configurable: true,
      value: {
        protocol: "wc-bindable",
        version: 1,
        properties: [
          ...currentDecl.properties,
          { name: "futureSurface", event: PROXY_EVENT_PREFIX + "futureSurface" },
        ],
      },
    });
    Object.defineProperty(proxy, "futureSurface", {
      configurable: true,
      get: () => (proxy as any).__futureSurface,
    });
    (proxy as any).__futureSurface = "hello";

    const el = makeFlagsEl();
    await flush();
    // No crash, no side effect on the known surface.
    expect(el.flags).toEqual({});

    // Runtime-emitted future event is also ignored.
    proxy.dispatchEvent(new CustomEvent(PROXY_EVENT_PREFIX + "futureSurface", { detail: "hi" }));
    expect(el.flags).toEqual({});
  });
});
