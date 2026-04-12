import { test, expect } from "@playwright/test";
import { startServer } from "./server.js";

let server: Awaited<ReturnType<typeof startServer>>;

test.beforeAll(async () => {
  server = await startServer(0); // random available port
});

test.afterAll(async () => {
  await server.close();
});

test("full round-trip: sync → set → invoke → events", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);

  // Wait for the client script to finish.
  await expect(page.locator("#status")).toHaveText("done", { timeout: 10000 });

  // Parse the results JSON from the page.
  const raw = await page.locator("#results").textContent();
  const results = JSON.parse(raw!);

  // 1. isWcBindable should recognize the proxy.
  expect(results.isWcBindable).toBe(true);

  // 2. sync should deliver initial values.
  expect(results.syncReceived).toBe(true);

  // 3. invoke("doFetch") should return the fetched data.
  expect(results.fetchResult).toEqual({ data: "fetched:/api/test" });

  // 4. Property access should reflect latest state.
  expect(results.proxyValue).toEqual({ data: "fetched:/api/test" });
  expect(results.proxyLoading).toBe(false);

  // 5. Updates should include the full event sequence:
  //    sync initial values → loading:true → value:result → loading:false
  const updates: { name: string; value: unknown }[] = results.updates;
  const names = updates.map((u) => u.name);
  expect(names).toContain("loading");
  expect(names).toContain("value");

  // There should be a loading:true followed by loading:false.
  const loadingValues = updates.filter((u) => u.name === "loading").map((u) => u.value);
  expect(loadingValues).toContain(true);
  expect(loadingValues).toContain(false);
  expect(loadingValues.lastIndexOf(true)).toBeLessThan(loadingValues.lastIndexOf(false));
});

test("WebSocket connection failure rejects invoke", async ({ page }) => {
  // Navigate to the page but with a port that doesn't exist.
  // We'll use page.evaluate to run the test inline.
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 10000 });

  // Now run a second test: connect to a non-existent WebSocket server.
  const errorMessage = await page.evaluate(async () => {
    const { WebSocketClientTransport, createRemoteCoreProxy } = await import("@wc-bindable/remote");

    const declaration = {
      protocol: "wc-bindable" as const,
      version: 1 as const,
      properties: [{ name: "value", event: "t:v" }],
    };

    const ws = new WebSocket("ws://localhost:1"); // will fail
    const transport = new WebSocketClientTransport(ws);
    const proxy = createRemoteCoreProxy(declaration, transport);

    try {
      await proxy.invoke("test");
      return "no error";
    } catch (e: any) {
      return e.message ?? String(e);
    }
  });

  expect(errorMessage).toContain("closed");
});
