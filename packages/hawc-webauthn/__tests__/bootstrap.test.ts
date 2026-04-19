import { describe, it, expect, afterEach } from "vitest";
import { bootstrapWebAuthn } from "../src/bootstrapWebAuthn";
import { registerComponents } from "../src/registerComponents";
import { setConfig, getConfig, config } from "../src/config";

// CustomElements constraint: a given class can only be associated with
// ONE tag name. These tests run in a single vitest worker where the
// registry persists across tests, so we register once at the top and
// then exercise idempotency + config-side behaviors without attempting
// to re-register the same class under different names.
describe("bootstrap + registration", () => {
  afterEach(() => {
    // Keep the default tag name stable for downstream tests within the file.
    setConfig({ tagNames: { webauthn: "hawc-webauthn" } });
  });

  it("bootstrapWebAuthn registers the default tag when no config is supplied", () => {
    bootstrapWebAuthn();
    expect(customElements.get("hawc-webauthn")).toBeDefined();
    expect(config.tagNames.webauthn).toBe("hawc-webauthn");
  });

  it("bootstrapWebAuthn accepts user config before registering", () => {
    bootstrapWebAuthn({ tagNames: { webauthn: "hawc-webauthn" } });
    expect(config.tagNames.webauthn).toBe("hawc-webauthn");
  });

  it("bootstrapWebAuthn is idempotent — re-invocation does not throw", () => {
    bootstrapWebAuthn();
    bootstrapWebAuthn();
    expect(customElements.get("hawc-webauthn")).toBeDefined();
  });

  it("registerComponents short-circuits when the tag is already registered", () => {
    // Pre-registers during the first bootstrap above. Calling register
    // again must be a no-op (not throw "already defined").
    registerComponents();
    registerComponents();
    expect(customElements.get("hawc-webauthn")).toBeDefined();
  });

  it("setConfig updates the live config read by callers", () => {
    setConfig({ tagNames: { webauthn: "alt-tag-name" } });
    expect(config.tagNames.webauthn).toBe("alt-tag-name");
    // Re-calling registerComponents now checks alt-tag-name. It is NOT
    // registered yet, so the guard would try to define — but the WebAuthn
    // class is already bound to "hawc-webauthn" from an earlier test, so
    // the define would throw. We deliberately do NOT exercise that path
    // here; the purpose of this test is to confirm setConfig plumbs
    // through to the live `config` object.
  });

  it("getConfig returns a frozen snapshot that does not track mutations", () => {
    setConfig({ tagNames: { webauthn: "frozen-tag" } });
    const snapshot = getConfig();
    expect(snapshot.tagNames.webauthn).toBe("frozen-tag");
    // The snapshot is frozen — attempts to mutate throw in strict mode.
    expect(() => {
      (snapshot.tagNames as any).webauthn = "mutated";
    }).toThrow();
  });

  it("getConfig returns a fresh snapshot after setConfig", () => {
    setConfig({ tagNames: { webauthn: "first" } });
    const first = getConfig();
    setConfig({ tagNames: { webauthn: "second" } });
    const second = getConfig();
    expect(first.tagNames.webauthn).toBe("first");
    expect(second.tagNames.webauthn).toBe("second");
  });

  it("getConfig reuses the cached snapshot until config changes", () => {
    const first = getConfig();
    const second = getConfig();
    expect(second).toBe(first);
  });

  it("setConfig tolerates an empty partial config", () => {
    setConfig({});
    expect(config.tagNames.webauthn).toBe("hawc-webauthn");
  });
});
