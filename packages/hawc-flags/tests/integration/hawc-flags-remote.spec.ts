import { test, expect } from "@playwright/test";
import { startServer } from "./server.js";

let server: Awaited<ReturnType<typeof startServer>>;

test.beforeAll(async () => {
  server = await startServer(0); // random available port
});

test.afterAll(async () => {
  await server.close();
});

test("initial sync: unidentified defaults delivered", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 10000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);

  // sync delivered initial values
  expect(results.syncReceived).toBe(true);

  // Before identify(), FlagsCore carries EMPTY_FLAGS / identified=false
  expect(results.initialFlags).toEqual({});
  expect(results.initialIdentified).toBe(false);
  expect(results.initialLoading).toBe(false);
});

test("identify('alice'): rule-targeted flag resolves to true", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 10000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);

  // alice matches the feature-x rule; feature-y falls back to default;
  // feature-z carries its default (nothing has been mutated yet).
  expect(results.aliceFlags).toEqual({
    "feature-x": true,
    "feature-y": "legacy",
    "feature-z": 42,
  });
  expect(results.aliceIdentified).toBe(true);
  expect(results.aliceLoading).toBe(false);
});

test("re-identify as 'bob' swaps rule targeting", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 10000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);

  // bob loses the feature-x rule (defaults to false) and gains feature-y.
  expect(results.bobFlags).toEqual({
    "feature-x": false,
    "feature-y": "new",
    "feature-z": 42,
  });
});

test("subscription push: server setFlag propagates to client", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 10000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);

  // After server-side setFlag("feature-z", 100), the subscriber path
  // delivers the new value to the client without an explicit reload.
  expect(results.pushedFeatureZ).toBe(100);
  // Other flags preserve their last-evaluated values.
  expect(results.pushedFlags["feature-x"]).toBe(false);
  expect(results.pushedFlags["feature-y"]).toBe("new");
});

test("reload(): fetches a fresh snapshot past the push pipeline", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 10000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);

  // After setFlag("feature-z", 999) + reload(), client observes 999.
  expect(results.reloadedFeatureZ).toBe(999);
  expect(results.finalLoading).toBe(false);
  expect(results.finalIdentified).toBe(true);
});

test("bind() updates include loading and flags transitions", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 10000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);
  const updates: { name: string; value: unknown }[] = results.updates;

  // loading should transition true ↔ false across identify/reload cycles
  const loadingValues = updates.filter((u) => u.name === "loading").map((u) => u.value);
  expect(loadingValues).toContain(true);
  expect(loadingValues).toContain(false);

  // identified should transition false → true
  const identifiedValues = updates.filter((u) => u.name === "identified").map((u) => u.value);
  expect(identifiedValues).toContain(true);

  // flags updates should include the feature-z mutations
  const flagsValues = updates.filter((u) => u.name === "flags").map((u) => u.value as Record<string, unknown>);
  expect(flagsValues.some((f) => f["feature-z"] === 100)).toBe(true);
  expect(flagsValues.some((f) => f["feature-z"] === 999)).toBe(true);
});
