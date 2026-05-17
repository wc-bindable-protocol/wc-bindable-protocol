import { describe, it, expect } from "vitest";
import {
  buildDeclarationFingerprint,
  declarationFingerprintsEqual,
} from "../src/declarationFingerprint.js";
import type { WcBindableDeclaration } from "@wc-bindable/core";

describe("declarationFingerprint", () => {
  it("produces deterministic sorted-deduplicated name lists", () => {
    const decl: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [
        { name: "value", event: "x:value" },
        { name: "loading", event: "x:loading" },
      ],
      inputs: [{ name: "url" }, { name: "method" }],
      commands: [{ name: "fetch" }, { name: "abort" }],
    };
    expect(buildDeclarationFingerprint(decl)).toEqual({
      protocol: "wc-bindable",
      version: 1,
      properties: ["loading", "value"],
      inputs: ["method", "url"],
      commands: ["abort", "fetch"],
    });
  });

  it("ignores source ordering — different orderings yield equal fingerprints", () => {
    const a: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [
        { name: "a", event: "x:a" },
        { name: "b", event: "x:b" },
      ],
    };
    const b: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [
        { name: "b", event: "x:b" },
        { name: "a", event: "x:a" },
      ],
    };
    expect(
      declarationFingerprintsEqual(
        buildDeclarationFingerprint(a),
        buildDeclarationFingerprint(b),
      ),
    ).toBe(true);
  });

  it("ignores event names (only structural names matter)", () => {
    const a: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "value", event: "core:value-changed" }],
    };
    const b: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "value", event: "@wc-bindable/remote:value" }],
    };
    expect(
      declarationFingerprintsEqual(
        buildDeclarationFingerprint(a),
        buildDeclarationFingerprint(b),
      ),
    ).toBe(true);
  });

  it("reports inequality when a name is added", () => {
    const a: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "value", event: "x:value" }],
      inputs: [{ name: "url" }],
    };
    const b: WcBindableDeclaration = {
      ...a,
      inputs: [{ name: "url" }, { name: "method" }],
    };
    expect(
      declarationFingerprintsEqual(
        buildDeclarationFingerprint(a),
        buildDeclarationFingerprint(b),
      ),
    ).toBe(false);
  });

  it("reports inequality on version change", () => {
    const a: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "value", event: "x:value" }],
    };
    const b: WcBindableDeclaration = { ...a, version: 2 };
    expect(
      declarationFingerprintsEqual(
        buildDeclarationFingerprint(a),
        buildDeclarationFingerprint(b),
      ),
    ).toBe(false);
  });

  it("handles missing inputs/commands as empty arrays", () => {
    const decl: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "value", event: "x:value" }],
    };
    const fp = buildDeclarationFingerprint(decl);
    expect(fp.inputs).toEqual([]);
    expect(fp.commands).toEqual([]);
  });
});
