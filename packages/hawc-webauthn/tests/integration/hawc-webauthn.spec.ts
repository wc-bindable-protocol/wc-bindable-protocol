import { test, expect, type CDPSession, type Page } from "@playwright/test";
import { startServer } from "./server.js";

let server: Awaited<ReturnType<typeof startServer>>;

test.beforeAll(async () => {
  server = await startServer(0);
});

test.afterAll(async () => {
  await server.close();
});

test.beforeEach(() => {
  // Per-test reset of in-memory stores so credential carryover does not
  // contaminate independent specs.
  server.reset();
});

/**
 * Install a Chromium virtual authenticator via CDP. Returns the
 * authenticatorId so the test can later query / mutate it (e.g. fetch
 * the persisted credentials, change UV state, simulate user dismissal).
 *
 * Why CDP and not WebAuthn-the-real-thing: there is no real authenticator
 * in CI. Chromium's virtual authenticator implements the CTAP protocol
 * end-to-end inside the browser process, so navigator.credentials.create()
 * / .get() run their full code paths and produce valid attestation /
 * assertion blobs — exactly what the Shell serializes onto the wire.
 */
async function installVirtualAuthenticator(page: Page): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const result = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  return { cdp, authenticatorId: result.authenticatorId };
}

test("registers a passkey end-to-end through a real Chromium virtual authenticator", async ({ page }) => {
  await installVirtualAuthenticator(page);
  await page.goto(`http://localhost:${server.port}/client.html`);

  await page.evaluate(() => (window as any).runRegister({
    "user-id": "alice",
    "user-name": "alice@example.com",
    "user-display-name": "Alice",
  }));

  await expect(page.locator("#status")).toHaveText("done");
  const result = JSON.parse(await page.locator("#results").textContent() ?? "{}");

  expect(result.error).toBeUndefined();
  expect(result.status).toBe("completed");
  expect(result.statuses).toEqual(["challenging", "creating", "verifying", "completed"]);
  expect(result.credentialId).toMatch(/^[A-Za-z0-9_-]+$/);  // base64url
  expect(result.user).toEqual({ id: "alice", name: "alice@test", displayName: "alice" });
});

test("authenticates with a previously-registered passkey", async ({ page }) => {
  await installVirtualAuthenticator(page);
  await page.goto(`http://localhost:${server.port}/client.html`);

  // Register first.
  await page.evaluate(() => (window as any).runRegister({
    "user-id": "alice",
    "user-name": "alice@example.com",
    "user-display-name": "Alice",
  }));
  await expect(page.locator("#status")).toHaveText("done");
  const reg = JSON.parse(await page.locator("#results").textContent() ?? "{}");
  expect(reg.status).toBe("completed");

  // Now authenticate. Default handler config ignores client-supplied
  // userId, so this exercises the usernameless / discoverable-credential
  // flow — the virtual authenticator returns the registered passkey
  // because hasResidentKey: true and isUserVerified: true.
  await page.evaluate(() => (window as any).runAuthenticate());
  await expect(page.locator("#status")).toHaveText("done");
  const auth = JSON.parse(await page.locator("#results").textContent() ?? "{}");

  expect(auth.error).toBeUndefined();
  expect(auth.status).toBe("completed");
  expect(auth.statuses).toEqual(["challenging", "asserting", "verifying", "completed"]);
  expect(auth.credentialId).toBe(reg.credentialId);
  expect(auth.user).toEqual({ id: "alice", name: "alice@test", displayName: "alice" });
});

test("status events arrive in order and credentialId is the base64url wire form", async ({ page }) => {
  // Cross-cut sanity over the wire: the Shell must surface the exact
  // status sequence its consumers bind to (challenging → creating →
  // verifying → completed) AND the credentialId it exposes must be the
  // base64url string the server persisted, not the raw binary the
  // authenticator returned. A regression in either would silently break
  // any framework adapter that watches `status` or that round-trips
  // `credentialId` to a backend.
  await installVirtualAuthenticator(page);
  await page.goto(`http://localhost:${server.port}/client.html`);

  await page.evaluate(() => (window as any).runRegister({
    "user-id": "dave",
    "user-name": "dave@example.com",
    "user-display-name": "Dave",
  }));
  await expect(page.locator("#status")).toHaveText("done");
  const result = JSON.parse(await page.locator("#results").textContent() ?? "{}");

  expect(result.status).toBe("completed");
  expect(result.statuses).toEqual(["challenging", "creating", "verifying", "completed"]);
  // base64url alphabet only; no padding.
  expect(result.credentialId).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(result.credentialId).not.toContain("=");
});

// Edge cases (re-registration excludeCredentials, NotAllowedError /
// authenticator-cannot-UV) are intentionally NOT exercised here — the
// Chromium virtual authenticator's behavior in those scenarios shifts
// across Chromium versions and produces flaky e2e signal. Both code
// paths are pinned deterministically in the unit + integration suites
// (see __tests__/webAuthnCore.test.ts for the duplicate guard and
// __tests__/webAuthnShell.test.ts for NotAllowedError handling).
