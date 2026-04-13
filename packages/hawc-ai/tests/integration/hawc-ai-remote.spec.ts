import { test, expect } from "@playwright/test";
import { startServer } from "./server.js";

let server: Awaited<ReturnType<typeof startServer>>;

test.beforeAll(async () => {
  server = await startServer(0); // random available port
});

test.afterAll(async () => {
  await server.close();
});

test("non-streaming: send → response → state", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 10000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);

  // sync delivered initial values
  expect(results.syncReceived).toBe(true);

  // Non-streaming send returns echoed content
  expect(results.nonStreamResult).toBe("Echo: Hello");
  expect(results.contentAfterNonStream).toBe("Echo: Hello");
  expect(results.loadingAfterNonStream).toBe(false);

  // Usage was collected
  expect(results.usageAfterNonStream).toEqual({
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  });

  // Messages contain user + assistant
  expect(results.messagesAfterNonStream).toEqual([
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Echo: Hello" },
  ]);
});

test("streaming: send → chunked response → state", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 10000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);

  // Streaming send returns the full accumulated content
  expect(results.streamResult).toBe("Echo: World");
  expect(results.contentAfterStream).toBe("Echo: World");
});

test("conversation accumulation: multiple sends", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 10000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);

  // After non-stream + stream sends: 2 user + 2 assistant = 4 messages
  expect(results.messagesCount).toBe(4);
});

test("history reset via set()", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 10000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);

  // After proxy.set("messages", []), history should be empty
  expect(results.messagesAfterReset).toEqual([]);
});

test("HTTP error propagates to error state", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 10000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);

  // Error send returns null
  expect(results.errorResult).toBeNull();

  // Error state should contain the HTTP status
  expect(results.errorState).not.toBeNull();
  expect(results.errorState.status).toBe(500);
});

test("bind() updates include loading transitions", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 10000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);
  const updates: { name: string; value: unknown }[] = results.updates;

  // loading should have both true and false values
  const loadingValues = updates.filter((u) => u.name === "loading").map((u) => u.value);
  expect(loadingValues).toContain(true);
  expect(loadingValues).toContain(false);

  // content should have been updated
  const contentValues = updates.filter((u) => u.name === "content").map((u) => u.value);
  expect(contentValues.length).toBeGreaterThan(0);
  expect(contentValues).toContain("Echo: Hello");
});
