import { test, expect } from "@playwright/test";
import { startServer } from "./server.js";

let server: Awaited<ReturnType<typeof startServer>>;

test.beforeAll(async () => {
  server = await startServer(0);
});

test.afterAll(async () => {
  await server.close();
});

test.beforeEach(() => {
  server.reset();
});

test("remote payment flow auto-prepares and submits through the fake Stripe.js bridge", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html?scenario=submit`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 15000 });

  const results = JSON.parse((await page.locator("#results").textContent()) ?? "{}");

  expect(results.status).toBe("succeeded");
  expect(results.intentId).toMatch(/^pi_e2e_\d+$/);
  expect(results.amount).toEqual({ value: 1980, currency: "jpy" });
  expect(results.paymentMethod).toEqual({ id: "pm_card_visa", brand: "visa", last4: "4242" });
  expect(results.error).toBeNull();
  expect(results.elementReadyCount).toBe(1);
  expect(results.loaderCalls).toEqual(["pk_test_e2e"]);
  expect(results.confirmCalls).toEqual([
    { kind: "payment", clientSecret: `${results.intentId}_secret_ok` },
  ]);
  expect(results.statusEvents).toContain("collecting");
  expect(results.statusEvents).toContain("succeeded");

  expect(server.state.createCalls).toHaveLength(1);
  expect(server.state.createCalls[0].mode).toBe("payment");
  expect(server.state.createCalls[0].options).toMatchObject({ amount: 1980, currency: "jpy" });
});

test("post-redirect resume hydrates remote state without mounting Stripe Elements", async ({ page }) => {
  server.state.resumeFixtures.set("pi_resume_ok", {
    id: "pi_resume_ok",
    mode: "payment",
    clientSecret: "pi_resume_ok_secret_ok",
    status: "succeeded",
    amount: { value: 2500, currency: "usd" },
    paymentMethod: { id: "pm_resume", brand: "visa", last4: "4242" },
  });

  await page.goto(
    `http://localhost:${server.port}/client.html?scenario=resume&payment_intent=pi_resume_ok&payment_intent_client_secret=pi_resume_ok_secret_ok&redirect_status=succeeded`,
  );
  await expect(page.locator("#status")).toHaveText("done", { timeout: 15000 });

  const results = JSON.parse((await page.locator("#results").textContent()) ?? "{}");

  expect(results.status).toBe("succeeded");
  expect(results.intentId).toBe("pi_resume_ok");
  expect(results.amount).toEqual({ value: 2500, currency: "usd" });
  expect(results.paymentMethod).toEqual({ id: "pm_resume", brand: "visa", last4: "4242" });
  expect(results.error).toBeNull();
  expect(results.loaderCalls).toEqual([]);
  expect(results.confirmCalls).toEqual([]);
  expect(results.elementReadyCount).toBe(0);
  expect(results.searchAfter).toBe("?scenario=resume");

  expect(server.state.retrieveCalls).toEqual([{ mode: "payment", id: "pi_resume_ok" }]);
});

test("post-redirect resume rejects a foreign client secret over the real remote boundary", async ({ page }) => {
  server.state.resumeFixtures.set("pi_resume_denied", {
    id: "pi_resume_denied",
    mode: "payment",
    clientSecret: "pi_resume_denied_secret_REAL",
    status: "succeeded",
    amount: { value: 9999, currency: "usd" },
    paymentMethod: { id: "pm_forbidden", brand: "visa", last4: "0000" },
  });

  await page.goto(
    `http://localhost:${server.port}/client.html?scenario=resume&payment_intent=pi_resume_denied&payment_intent_client_secret=pi_resume_denied_secret_GUESSED`,
  );
  await expect(page.locator("#status")).toHaveText("done", { timeout: 15000 });

  const results = JSON.parse((await page.locator("#results").textContent()) ?? "{}");

  expect(results.status).toBe("idle");
  expect(results.intentId).toBeNull();
  expect(results.paymentMethod).toBeNull();
  expect(results.error).toMatchObject({ code: "resume_client_secret_mismatch" });
  expect(results.loaderCalls).toEqual([]);
  expect(results.confirmCalls).toEqual([]);
  expect(server.state.retrieveCalls).toEqual([{ mode: "payment", id: "pi_resume_denied" }]);
});