/**
 * `syncOn: "define"` against a real browser.
 *
 * The unit suite in `packages/core/tests/index.test.ts` pins our own logic
 * but has to *simulate* custom element upgrade, because happy-dom does not
 * implement it. Everything here depends on the platform actually performing
 * the upgrade, so these are the cases that suite cannot honestly cover:
 *
 *   - a connected element upgraded in place by `define()`, node identity
 *     preserved (happy-dom replaces the node instead);
 *   - a **detached** element upgraded by `customElements.upgrade()`, which
 *     SPEC.md § Deferring Discovery Until Definition makes a MUST and which
 *     happy-dom implements as a no-op;
 *   - initial-sync values produced by the real constructor running at
 *     upgrade time, rather than by a prototype swap;
 *   - the two async error channels (uncaught error vs unhandled rejection)
 *     that SPEC.md § Teardown Contract keeps distinct.
 *
 * Runs against built `dist/`, so `npm run build` must precede it. See
 * CONFORMANCE.md vectors 38 and 39 for the normative statements.
 */
import { test, expect } from "@playwright/test";
import { startServer, type IntegrationServer } from "./server.js";

let server: IntegrationServer;

test.beforeAll(async () => {
  server = await startServer(0);
});

test.afterAll(async () => {
  await server.close();
});

test.beforeEach(async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/harness.html`);
  await expect(page.locator("#root")).toHaveText("ready");
});

/**
 * Source for a bindable custom element class, evaluated in the page.
 * `initial` is assigned as a real class field so the value can only be
 * observed if the constructor actually ran — i.e. if the element was really
 * upgraded.
 */
const bindableClassSource = (tag: string, initial: string) => `
  class extends HTMLElement {
    static wcBindable = {
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "value", event: "${tag}:value-changed" }],
    };
    value = ${JSON.stringify(initial)};
  }
`;

test("a connected element is upgraded in place and binds, preserving node identity", async ({ page }) => {
  const result = await page.evaluate(async ({ src }) => {
    const tag = "late-connected";
    document.getElementById("root")!.innerHTML = `<${tag}></${tag}>`;
    const el = document.querySelector(tag)! as HTMLElement;

    const updates: [string, unknown][] = [];
    window.__wcb.bind(el, (name, value) => updates.push([name, value]), { syncOn: "define" });

    const beforeUpgrade = el.constructor.name;
    el.dispatchEvent(new CustomEvent(`${tag}:value-changed`, { detail: "early" }));
    const updatesBeforeDefine = updates.length;

    customElements.define(tag, eval(`(${src})`));
    await customElements.whenDefined(tag);
    await new Promise((r) => setTimeout(r, 0));

    el.dispatchEvent(new CustomEvent(`${tag}:value-changed`, { detail: "after" }));

    return {
      beforeUpgrade,
      afterUpgrade: el.constructor.name,
      updatesBeforeDefine,
      updates,
      // The reference the bind holds must still be the node in the tree.
      // This is the assertion happy-dom cannot satisfy — it swaps the node.
      sameNode: document.querySelector(tag) === el,
      isConnected: el.isConnected,
      parentIsRoot: el.parentElement?.id === "root",
    };
  }, { src: bindableClassSource("late-connected", "from-constructor") });

  expect(result.updatesBeforeDefine).toBe(0);
  expect(result.beforeUpgrade).toBe("HTMLElement");
  // The platform really upgraded it: the constructor identity changed.
  expect(result.afterUpgrade).not.toBe("HTMLElement");
  expect(result.sameNode).toBe(true);
  expect(result.isConnected).toBe(true);
  expect(result.parentIsRoot).toBe(true);
  // Initial sync reads the class field the real constructor assigned, then
  // the listener installed in the same reaction delivers the next event.
  expect(result.updates).toEqual([
    ["value", "from-constructor"],
    ["value", "after"],
  ]);
});

test("a detached element is upgraded by customElements.upgrade() and binds", async ({ page }) => {
  const result = await page.evaluate(async ({ src }) => {
    const tag = "late-detached";
    const el = document.createElement(tag);  // never appended

    const updates: [string, unknown][] = [];
    window.__wcb.bind(el, (name, value) => updates.push([name, value]), { syncOn: "define" });

    customElements.define(tag, eval(`(${src})`));
    await customElements.whenDefined(tag);
    await new Promise((r) => setTimeout(r, 0));

    el.dispatchEvent(new CustomEvent(`${tag}:value-changed`, { detail: "after" }));

    return { updates, isConnected: el.isConnected, ctor: el.constructor.name };
  }, { src: bindableClassSource("late-detached", "detached-initial") });

  // `define()` does NOT upgrade a detached element — only insertion does, or
  // an explicit `customElements.upgrade()`. Without that call the bind would
  // resolve and still see `constructor === HTMLElement`, silently
  // reproducing the failure this mode exists to fix.
  expect(result.isConnected).toBe(false);
  expect(result.ctor).not.toBe("HTMLElement");
  expect(result.updates).toEqual([
    ["value", "detached-initial"],
    ["value", "after"],
  ]);
});

test("[\"define\", \"connect\"] defers discovery and then the initial read", async ({ page }) => {
  const result = await page.evaluate(async ({ src }) => {
    const tag = "late-composed";
    const el = document.createElement(tag);

    const updates: [string, unknown][] = [];
    window.__wcb.bind(el, (name, value) => updates.push([name, value]), {
      syncOn: ["define", "connect"],
    });

    customElements.define(tag, eval(`(${src})`));
    await customElements.whenDefined(tag);
    await new Promise((r) => setTimeout(r, 0));

    const afterDefine = updates.length;

    // Move the value between definition and connection: the deferred sync
    // must read at connection time, per the "connect" ordering rule.
    (el as unknown as Record<string, unknown>).value = "at-connection";
    document.getElementById("root")!.appendChild(el);
    await new Promise((r) => setTimeout(r, 0));

    return { afterDefine, updates };
  }, { src: bindableClassSource("late-composed", "at-definition") });

  expect(result.afterDefine).toBe(0);
  expect(result.updates).toEqual([["value", "at-connection"]]);
});

test("cleanup while the wait is pending registers nothing after a later define()", async ({ page }) => {
  const result = await page.evaluate(async ({ src }) => {
    const tag = "late-cancelled";
    const el = document.createElement(tag);
    document.getElementById("root")!.appendChild(el);

    const updates: [string, unknown][] = [];
    const unbind = window.__wcb.bind(el, (name, value) => updates.push([name, value]), {
      syncOn: "define",
    });
    unbind();

    customElements.define(tag, eval(`(${src})`));
    await customElements.whenDefined(tag);
    await new Promise((r) => setTimeout(r, 0));

    el.dispatchEvent(new CustomEvent(`${tag}:value-changed`, { detail: "after" }));

    let threwOnSecondUnbind = false;
    try { unbind(); } catch { threwOnSecondUnbind = true; }

    return { updates, threwOnSecondUnbind };
  }, { src: bindableClassSource("late-cancelled", "never") });

  expect(result.updates).toEqual([]);
  expect(result.threwOnSecondUnbind).toBe(false);
});

test("one whenDefined() wait per tag, and every bind on it still registers", async ({ page }) => {
  const result = await page.evaluate(async ({ src }) => {
    const tag = "late-pooled";
    const first = document.createElement(tag);
    const second = document.createElement(tag);
    const third = document.createElement(tag);

    const original = customElements.whenDefined.bind(customElements);
    let calls = 0;
    customElements.whenDefined = (name: string) => { calls++; return original(name); };

    const updates: string[] = [];
    const track = (label: string) => (name: string, value: unknown) =>
      updates.push(`${label}:${name}=${String(value)}`);

    try {
      const unbindFirst = window.__wcb.bind(first, track("first"), { syncOn: "define" });
      window.__wcb.bind(second, track("second"), { syncOn: "define" });
      window.__wcb.bind(third, track("third"), { syncOn: "define" });
      // Cancelling one must not disturb the others.
      unbindFirst();
    } finally {
      customElements.whenDefined = original;
    }

    const whenDefinedCalls = calls;

    customElements.define(tag, eval(`(${src})`));
    await customElements.whenDefined(tag);
    await new Promise((r) => setTimeout(r, 0));

    return { whenDefinedCalls, updates };
  }, { src: bindableClassSource("late-pooled", "pooled") });

  // Pooling: three deferred binds on one tag arm a single wait. This is the
  // observable proxy for "a cancelled wait releases its target", which is
  // not directly assertable without WeakRef plus a forced GC — see
  // CONFORMANCE.md vector 38.
  expect(result.whenDefinedCalls).toBe(1);
  expect(result.updates).toEqual(["second:value=pooled", "third:value=pooled"]);
});

test("a throwing bind reports on its own rejection without stopping a sibling", async ({ page }) => {
  const result = await page.evaluate(async ({ src }) => {
    const tag = "late-throwing";
    const throwing = document.createElement(tag);
    const healthy = document.createElement(tag);

    const updates: unknown[] = [];
    window.__wcb.bind(throwing, () => { throw new Error("consumer onUpdate exploded"); }, {
      syncOn: "define",
    });
    window.__wcb.bind(healthy, (_name, value) => updates.push(value), { syncOn: "define" });

    customElements.define(tag, eval(`(${src})`));
    await customElements.whenDefined(tag);
    // `unhandledrejection` is dispatched after the microtask checkpoint that
    // leaves the rejection unhandled, which is strictly later than the
    // reaction that produced it — so the wait has to outlast the turn, not
    // merely the microtask queue.
    await new Promise((r) => setTimeout(r, 50));

    return { updates, errors: window.__errors };
  }, { src: bindableClassSource("late-throwing", "survives") });

  // Isolation: the pooled reaction runs every waiter even when one throws.
  expect(result.updates).toEqual(["survives"]);
  // Channel: a deferred `"define"` registration runs in a promise reaction,
  // so its throw is an unhandled *rejection* — NOT the uncaught error that
  // the MutationObserver-based `"connect"` path produces. SPEC.md
  // § Teardown Contract forbids converting one into the other.
  expect(result.errors.rejections).toContain("consumer onUpdate exploded");
  expect(result.errors.uncaught).toEqual([]);
});

test("a reserved hyphenated name produces no unhandled rejection", async ({ page }) => {
  const result = await page.evaluate(async () => {
    // `font-face` clears the `-` gate but is not a valid custom element
    // name, so `whenDefined()` returns a rejected promise. Leaving that
    // unhandled would fire on every page that binds one.
    const el = document.createElement("font-face");
    const updates: unknown[] = [];

    let threw = false;
    try {
      window.__wcb.bind(el, (_n, v) => updates.push(v), { syncOn: "define" })();
    } catch {
      threw = true;
    }

    await new Promise((r) => setTimeout(r, 50));
    return { threw, updates, errors: window.__errors };
  });

  expect(result.threw).toBe(false);
  expect(result.updates).toEqual([]);
  expect(result.errors.rejections).toEqual([]);
  expect(result.errors.uncaught).toEqual([]);
});

test("the default modes still skip a not-yet-upgraded element permanently", async ({ page }) => {
  const result = await page.evaluate(async ({ src }) => {
    const tag = "late-default";
    const el = document.createElement(tag);
    document.getElementById("root")!.appendChild(el);

    const call: unknown[] = [];
    const connect: unknown[] = [];
    const unknown: unknown[] = [];

    window.__wcb.bind(el, (_n, v) => call.push(v));
    window.__wcb.bind(el, (_n, v) => connect.push(v), { syncOn: "connect" });
    window.__wcb.bind(el, (_n, v) => unknown.push(v), { syncOn: "later" as never });

    customElements.define(tag, eval(`(${src})`));
    await customElements.whenDefined(tag);
    await new Promise((r) => setTimeout(r, 0));
    document.querySelector(tag)!.dispatchEvent(
      new CustomEvent(`${tag}:value-changed`, { detail: "after" }),
    );

    return { call, connect, unknown };
  }, { src: bindableClassSource("late-default", "ignored") });

  // The "no default behavior change" claim, against a real upgrade.
  expect(result.call).toEqual([]);
  expect(result.connect).toEqual([]);
  expect(result.unknown).toEqual([]);
});

test("an already-defined element binds in the same synchronous frame", async ({ page }) => {
  const result = await page.evaluate(async ({ src }) => {
    const tag = "already-defined";
    customElements.define(tag, eval(`(${src})`));
    const el = document.createElement(tag);

    const original = customElements.whenDefined.bind(customElements);
    let calls = 0;
    customElements.whenDefined = (name: string) => { calls++; return original(name); };

    const updates: unknown[] = [];
    try {
      window.__wcb.bind(el, (_n, v) => updates.push(v), { syncOn: "define" });
    } finally {
      customElements.whenDefined = original;
    }

    // Read synchronously — no await between bind() and this snapshot.
    return { synchronousUpdates: [...updates], whenDefinedCalls: calls };
  }, { src: bindableClassSource("already-defined", "sync") });

  expect(result.synchronousUpdates).toEqual(["sync"]);
  expect(result.whenDefinedCalls).toBe(0);
});
