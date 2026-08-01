/**
 * The Alpine late-definition scenario, in a real browser.
 *
 * This is the one adapter whose late-definition behavior the unit suite
 * cannot cover — see the note at the bottom of
 * `packages/alpine/tests/wcBindable.test.ts` and the header of `server.ts`
 * for why. Everything else about the plugin is covered there; this file
 * covers only what needs a real custom element upgrade.
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

/**
 * Dispatch a real `CustomEvent` from inside the page.
 *
 * Not `locator.dispatchEvent()`: that constructs the event from a type name
 * and an init bag, and does not reliably produce a `CustomEvent` carrying
 * `detail` for a custom type — which silently delivers `undefined` to
 * `onUpdate` and makes the assertion fail for the wrong reason.
 */
async function dispatchValue(page: import("@playwright/test").Page, detail: string) {
  await page.evaluate((value) => {
    document.getElementById("target")!.dispatchEvent(
      new CustomEvent("late-alpine:value-changed", { detail: value }),
    );
  }, detail);
}

/**
 * Define `late-alpine` in the page. `initial` is assigned as a real class
 * field, so it can only be observed if the constructor actually ran — i.e.
 * if the platform really upgraded the element that was already in the tree.
 */
async function defineLateAlpine(page: import("@playwright/test").Page, initial: string) {
  await page.evaluate((constructed) => {
    customElements.define("late-alpine", class extends HTMLElement {
      static wcBindable = {
        protocol: "wc-bindable",
        version: 1,
        properties: [{ name: "value", event: "late-alpine:value-changed" }],
      };
      value = constructed;
    });
    return customElements.whenDefined("late-alpine");
  }, initial);
  // Let the deferred registration's promise reaction run.
  await page.waitForTimeout(50);
}

test("x-wc-bindable binds an element defined after the directive ran", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/harness.html`);
  await expect(page.locator("#ready")).toHaveText("ready");

  // Nothing bound yet: the tag is undefined, so discovery fails and the
  // deferred wait is armed.
  await dispatchValue(page, "early");
  await expect(page.locator("#out")).toHaveText("");

  // The node identity assertion that happy-dom cannot satisfy: a real
  // browser upgrades in place, so the element the directive bound is still
  // the element in Alpine's scope tree.
  await defineLateAlpine(page, "from-constructor");
  expect(await page.evaluate(() => document.querySelector("late-alpine") === document.getElementById("target"))).toBe(true);

  // The initial sync alone is enough — no event needed, no re-render.
  await expect(page.locator("#out")).toHaveText("from-constructor");

  // And the listener installed in the same reaction is live.
  await dispatchValue(page, "after");
  await expect(page.locator("#out")).toHaveText("after");
});

test("the plugin's syncOn option opts back into skipping a late definition", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/harness.html?syncOn=call`);
  await expect(page.locator("#ready")).toHaveText("ready");

  await defineLateAlpine(page, "ignored");

  await dispatchValue(page, "after");
  await expect(page.locator("#out")).toHaveText("");
});

test("Alpine teardown before the definition arrives registers nothing", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/harness.html`);
  await expect(page.locator("#ready")).toHaveText("ready");

  // `Alpine.destroyTree` runs the directive's `cleanup`, which is the
  // deferral's cancel path.
  await page.evaluate(() => {
    (window as unknown as { Alpine: { destroyTree: (el: Element) => void } })
      .Alpine.destroyTree(document.getElementById("scope")!);
  });

  await defineLateAlpine(page, "never");

  await dispatchValue(page, "after");
  await expect(page.locator("#out")).toHaveText("");
});
