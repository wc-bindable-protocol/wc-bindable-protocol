/**
 * Inputs written to a composite element before it is upgraded (#33), against
 * a real browser.
 *
 * The unit suite (`tests/declarative.test.ts`) covers an element that is
 * already upgraded but not yet connected. An element created before its tag
 * is defined needs real custom element upgrade, which happy-dom does not
 * implement (see `server.ts`), so those cases live here:
 *
 *   - a connected element upgraded in place by `customElements.define()`;
 *   - a detached element, which the platform upgrades only on insertion.
 *
 * In both, the write lands as an own data property on the not-yet-upgraded
 * element, and the composite must forward it to the source when its facade is
 * installed (SPEC-extensions.md § Producer guidance for inputs, P4; § Applier
 * profile A1).
 *
 * Runs against built `dist/`, so `npm run build` must precede it.
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

test("a connected element upgraded in place by define() keeps an input written before the definition", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const received: unknown[] = [];
    customElements.define(
      "rec-src-a",
      class extends HTMLElement {
        static wcBindable = { protocol: "wc-bindable", version: 1, properties: [], inputs: [{ name: "v" }] };
        set v(x: unknown) { received.push(x); }
        get v(): unknown { return undefined; }
      },
    );
    const root = document.getElementById("root")!;
    root.innerHTML = "<early-composite-a></early-composite-a>";
    const el = root.firstElementChild as HTMLElement & Record<string, unknown>;
    const upgradedBefore = el.constructor !== HTMLElement;
    el["s.v"] = "written before define";

    await window.__wcb.defineComposite({
      tagName: "early-composite-a",
      sources: [{ id: "s", tag: "rec-src-a" }],
      logger: window.__wcb.silentLogger,
    });

    return {
      upgradedBefore,
      upgradedAfter: el.constructor !== HTMLElement,
      sameNode: root.firstElementChild === el,
      received,
      facadeInstalled: typeof Object.getOwnPropertyDescriptor(el, "s.v")?.set === "function",
    };
  });

  expect(result).toEqual({
    upgradedBefore: false,
    upgradedAfter: true,
    sameNode: true, // upgraded in place, not replaced
    received: ["written before define"],
    facadeInstalled: true,
  });
});

test("a detached element created before define() keeps its input until it is inserted and upgraded", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const log: unknown[] = [];
    customElements.define(
      "rec-src-b",
      class extends HTMLElement {
        static wcBindable = {
          protocol: "wc-bindable",
          version: 1,
          properties: [{ name: "echo", event: "rec-src-b:echo" }],
          inputs: [{ name: "v" }],
        };
        echo: unknown = "initial";
        set v(x: unknown) {
          log.push(x);
          this.echo = x;
          this.dispatchEvent(new CustomEvent("rec-src-b:echo", { detail: x }));
        }
        get v(): unknown { return undefined; }
      },
    );
    const el = document.createElement("early-composite-b") as HTMLElement & Record<string, unknown>;
    el["s.v"] = "first";
    el["s.v"] = "second"; // the last write before upgrade wins

    await window.__wcb.defineComposite({
      tagName: "early-composite-b",
      sources: [{ id: "s", tag: "rec-src-b" }],
      logger: window.__wcb.silentLogger,
    });
    const upgradedWhileDetached = el.constructor !== HTMLElement;

    const updates: [string, unknown][] = [];
    document.getElementById("root")!.appendChild(el); // upgrade + connect
    window.__wcb.bind(el, (name, value) => updates.push([name, value]));

    return { upgradedWhileDetached, upgradedAfterInsert: el.constructor !== HTMLElement, log, updates };
  });

  expect(result.upgradedWhileDetached).toBe(false);
  expect(result.upgradedAfterInsert).toBe(true);
  expect(result.log).toEqual(["second"]);
  // The forwarded write reached the source, whose output the shell exposes.
  expect(result.updates).toContainEqual(["s.echo", "second"]);
});
