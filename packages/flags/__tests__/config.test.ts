import { describe, it, expect, afterEach } from "vitest";
import { config, getConfig, setConfig } from "../src/config";

describe("config", () => {
  afterEach(() => {
    setConfig({ tagNames: { flags: "feature-flags" } });
  });

  it("exposes the default tag name", () => {
    expect(config.tagNames.flags).toBe("feature-flags");
  });

  it("getConfig returns a deep-frozen snapshot", () => {
    const snap = getConfig();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.tagNames)).toBe(true);
    expect(snap.tagNames.flags).toBe("feature-flags");
  });

  it("getConfig is memoized between calls with no writes", () => {
    const a = getConfig();
    const b = getConfig();
    expect(a).toBe(b);
  });

  it("setConfig updates the mutable view and invalidates the cached snapshot", () => {
    const before = getConfig();
    setConfig({ tagNames: { flags: "my-flags" } });
    const after = getConfig();
    expect(after).not.toBe(before);
    expect(after.tagNames.flags).toBe("my-flags");
    expect(config.tagNames.flags).toBe("my-flags");
  });

  it("setConfig without tagNames does not throw and leaves values intact", () => {
    const before = getConfig();
    setConfig({});
    const after = getConfig();
    // The cache is always invalidated on setConfig, so the reference
    // changes — but the values must be identical.
    expect(after).not.toBe(before);
    expect(after.tagNames.flags).toBe(before.tagNames.flags);
  });
});
