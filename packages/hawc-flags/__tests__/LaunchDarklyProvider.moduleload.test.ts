import { describe, it, expect, vi, afterEach } from "vitest";
import type { FlagIdentity } from "../src/types";

// Isolated in its own test file because `vi.doMock` + `vi.resetModules`
// clears the shared module cache; if these tests lived alongside the
// main LaunchDarklyProvider suite, their resets would trickle into
// later tests and break the default `vi.mock("@launchdarkly/node-server-sdk", ...)`
// factory those tests depend on. Mirrors UnleashProvider.moduleload.test.ts.

const ID_ALICE: FlagIdentity = { userId: "alice", attrs: { role: "admin" } };

describe("LaunchDarklyProvider (module-load failures)", () => {
  afterEach(() => {
    vi.doUnmock("@launchdarkly/node-server-sdk");
    vi.resetModules();
  });

  it("raises a clean error when @launchdarkly/node-server-sdk is not installed", async () => {
    vi.doMock("@launchdarkly/node-server-sdk", () => { throw new Error("MODULE_NOT_FOUND"); });
    vi.resetModules();
    const { LaunchDarklyProvider: P } = await import("../src/providers/LaunchDarklyProvider");
    const p = new P({ sdkKey: "sdk-1" });
    await expect(p.identify(ID_ALICE)).rejects.toThrow(/failed to load "@launchdarkly\/node-server-sdk"/);
  });

  it("raises a clean error when the module exposes no `init` function", async () => {
    vi.doMock("@launchdarkly/node-server-sdk", () => ({ init: undefined }));
    vi.resetModules();
    const { LaunchDarklyProvider: P } = await import("../src/providers/LaunchDarklyProvider");
    const p = new P({ sdkKey: "sdk-1" });
    await expect(p.identify(ID_ALICE)).rejects.toThrow(/did not expose `init`/);
  });

  it("supports modules that expose `init` on the default export (CJS interop)", async () => {
    // When consumed from a CJS bundler, `@launchdarkly/node-server-sdk`
    // surfaces its factory on `default.init` rather than the top-level
    // namespace. The probe must accept both shapes.
    vi.doMock("@launchdarkly/node-server-sdk", () => {
      const factory = (_sdkKey: string): unknown => ({
        on(): void {},
        off(): void {},
        waitForInitialization(): Promise<void> { return Promise.resolve(); },
        async allFlagsState(): Promise<{ allValues: () => Record<string, unknown> }> {
          return { allValues: () => ({ a: true }) };
        },
        close(): Promise<void> { return Promise.resolve(); },
      });
      return { default: { init: factory } };
    });
    vi.resetModules();
    const { LaunchDarklyProvider: P } = await import("../src/providers/LaunchDarklyProvider");
    const p = new P({ sdkKey: "sdk-1" });
    const map = await p.identify(ID_ALICE);
    // Default valueShape is "wrapped" — the boolean true flag becomes
    // { enabled: true, value: true }.
    expect(map).toEqual({ a: { enabled: true, value: true } });
  });
});
