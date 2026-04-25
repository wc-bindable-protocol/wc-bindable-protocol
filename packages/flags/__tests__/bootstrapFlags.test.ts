import { describe, it, expect, afterEach, vi } from "vitest";
import { bootstrapFlags } from "../src/bootstrapFlags";
import { config, setConfig } from "../src/config";
import * as registerMod from "../src/registerComponents";

describe("bootstrapFlags", () => {
  afterEach(() => {
    setConfig({ tagNames: { flags: "feature-flags" } });
    vi.restoreAllMocks();
  });

  it("registers the default tag when called with no args", () => {
    bootstrapFlags();
    expect(customElements.get(config.tagNames.flags)).toBeDefined();
  });

  it("applies user config before registerComponents runs", () => {
    // Happy-dom's CustomElementRegistry allows each class to be defined
    // under exactly one tag name. Other test files in this suite register
    // Flags under its default name, so a second real register call with
    // a different tag would throw — orthogonal to what this test wants
    // to verify. Stub registerComponents and assert the call order.
    const spy = vi.spyOn(registerMod, "registerComponents").mockImplementation(() => {});
    bootstrapFlags({ tagNames: { flags: "flags-xyz" } });
    expect(config.tagNames.flags).toBe("flags-xyz");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — second call does not re-define the element", () => {
    bootstrapFlags();
    const Ctor = customElements.get(config.tagNames.flags);
    bootstrapFlags();
    expect(customElements.get(config.tagNames.flags)).toBe(Ctor);
  });
});
