import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The `/auto` public entry is a side-effect bootstrap shim that npm
 * ships as-is from `src/auto/` (see package.json `"files"` and
 * `exports["./auto"]`). tsc does NOT touch these files, so a typo in
 * the relative import path breaks the entry at runtime with no signal
 * from the build or the rest of the test suite.
 *
 * This test locks down:
 *   1. the shims exist at the paths package.json advertises
 *   2. they import a real file that exports `bootstrapAuth`
 *
 * Regression guard: before this, `auto.js` / `auto.min.js` imported
 * `./index.esm.js` / `./index.esm.min.js` — files that have never
 * existed in this package. `import "@wc-bindable/hawc-auth0/auto"`
 * therefore failed at load time, silently missed by unit tests.
 */

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readShim(rel: string): string {
  const p = resolve(pkgRoot, rel);
  expect(existsSync(p), `${rel} is missing`).toBe(true);
  return readFileSync(p, "utf8");
}

function extractImportSpecifier(src: string): string {
  // Both the pretty and the minified shim use a single
  // `import { bootstrapAuth } from "<path>"` (or minified) statement.
  const m = src.match(/from\s*["']([^"']+)["']/);
  expect(m, "shim must contain an import statement").not.toBeNull();
  return m![1];
}

describe("@wc-bindable/hawc-auth0/auto public entry", () => {
  it("auto.js imports from a path that exists and exports bootstrapAuth", () => {
    const shim = readShim("src/auto/auto.js");
    const spec = extractImportSpecifier(shim);
    // Resolve relative to the shim's own directory.
    const target = resolve(pkgRoot, "src/auto", spec);
    expect(existsSync(target), `auto.js target ${spec} -> ${target} missing`).toBe(true);
    expect(readFileSync(target, "utf8")).toMatch(/bootstrapAuth/);
  });

  it("auto.min.js imports from a path that exists and exports bootstrapAuth", () => {
    const shim = readShim("src/auto/auto.min.js");
    const spec = extractImportSpecifier(shim);
    const target = resolve(pkgRoot, "src/auto", spec);
    expect(existsSync(target), `auto.min.js target ${spec} -> ${target} missing`).toBe(true);
    expect(readFileSync(target, "utf8")).toMatch(/bootstrapAuth/);
  });

  it("package.json exports['./auto'] points at an existing shim", async () => {
    const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8"));
    const entry = pkg.exports?.["./auto"]?.default as string | undefined;
    expect(entry, "exports['./auto'].default must be set").toBeTruthy();
    const target = resolve(pkgRoot, entry!);
    expect(existsSync(target), `exports['./auto'] -> ${target} missing`).toBe(true);
  });

  it("bootstrapAuth is actually exported from the package root", async () => {
    // Sanity: the shim ultimately reaches this module.
    const mod: any = await import("../src/index.ts");
    expect(typeof mod.bootstrapAuth).toBe("function");
  });
});
