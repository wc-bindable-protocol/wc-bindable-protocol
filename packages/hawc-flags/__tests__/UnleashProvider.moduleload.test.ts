import { describe, it, expect, vi, afterEach } from "vitest";
import type { FlagIdentity } from "../src/types";

// Isolated in its own test file because `vi.doMock` + `vi.resetModules`
// clears the shared module cache; if these tests lived alongside the
// main UnleashProvider suite, their resets would trickle into later
// tests and break the default `vi.mock("unleash-client", ...)` factory
// those tests depend on.

const ID_ALICE: FlagIdentity = { userId: "alice", attrs: { role: "admin" } };

describe("UnleashProvider (module-load failures)", () => {
  afterEach(() => {
    vi.doUnmock("unleash-client");
    vi.resetModules();
  });

  it("raises a clean error when unleash-client is not installed", async () => {
    vi.doMock("unleash-client", () => { throw new Error("MODULE_NOT_FOUND"); });
    vi.resetModules();
    const { UnleashProvider: P } = await import("../src/providers/UnleashProvider");
    const p = new P({ url: "http://u", appName: "app" });
    await expect(p.identify(ID_ALICE)).rejects.toThrow(/failed to load "unleash-client"/);
  });

  it("raises a clean error when the module exposes neither initialize nor Unleash", async () => {
    // Returning both keys explicitly set to undefined avoids vitest's
    // "export is not defined on the mock" guard while still making the
    // `in`-based probe in UnleashProvider see no usable constructor.
    vi.doMock("unleash-client", () => ({ initialize: undefined, Unleash: undefined }));
    vi.resetModules();
    const { UnleashProvider: P } = await import("../src/providers/UnleashProvider");
    const p = new P({ url: "http://u", appName: "app" });
    await expect(p.identify(ID_ALICE)).rejects.toThrow(/did not expose `initialize` or `Unleash`/);
  });

  it("supports modules that export a Unleash constructor class instead of initialize()", async () => {
    vi.doMock("unleash-client", () => {
      class Unleash {
        on(event: string, fn: (...a: unknown[]) => void): void {
          if (event === "ready") queueMicrotask(() => fn());
        }
        off(): void {}
        isEnabled(): boolean { return false; }
        getVariant(): { name: string; enabled: boolean } { return { name: "disabled", enabled: false }; }
        getFeatureToggleDefinitions(): Array<{ name: string }> { return [{ name: "a" }]; }
        destroy(): void {}
      }
      return { initialize: undefined, Unleash };
    });
    vi.resetModules();
    const { UnleashProvider: P } = await import("../src/providers/UnleashProvider");
    const p = new P({ url: "http://u", appName: "app" });
    const map = await p.identify(ID_ALICE);
    expect(map).toEqual({ a: { enabled: false, value: null } });
  });
});
