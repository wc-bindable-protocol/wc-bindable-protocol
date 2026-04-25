// @vitest-environment node
//
// Regression guard: the package root `@wc-bindable/stripe` must
// *evaluate* under plain Node. The component barrel transitively pulls
// `components/Stripe.ts` which extends `HTMLElement`, so without the
// `typeof HTMLElement` fallback introduced in that file the module crashes
// at import time with `ReferenceError: HTMLElement is not defined`. The
// rest of the suite runs in happy-dom and therefore cannot catch a Node
// evaluation regression — only this file forces the `node` environment.
//
// Coverage layers (each catches a distinct regression class):
//   1. src-level smoke  — fast dev-loop feedback that source evaluation
//                         stays Node-safe, runs on every `npm test`.
//   2. exports-map shape — catches package.json misconfiguration
//                          (e.g. `exports["."].default` accidentally
//                          pointed at `dist/server.js`). No build needed.
//   3. built-artifact    — opportunistic under `npm test`: runs only when
//                          `dist/` already exists (engaged automatically
//                          after `prepack` / `test:integration` /
//                          previous `npm run build`). To make this layer
//                          unconditional in CI, point the pipeline at
//                          `npm run test:ci`, which chains the build
//                          before the test run. Under `process.env.CI`
//                          a missing `dist/` is upgraded from a silent
//                          skip to a loud fail below — so a CI config
//                          that forgets to build gets a clear signal
//                          instead of a false-positive green run.
//
// Scope note: the Custom Element is deliberately non-functional on the
// server — `customElements` is undefined in plain Node and there is no DOM
// to mount Elements into. These tests assert only that import does not
// throw and that the surface is what the publish contract promises.
// Runtime server-side usage remains routed through
// `@wc-bindable/stripe/server`.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf-8")) as {
  main: string;
  types: string;
  exports: Record<string, { types: string; default: string }>;
};

describe("root barrel evaluates under plain Node (src-level)", () => {
  it("root import resolves without ReferenceError and exposes the browser surface", async () => {
    // Proves HTMLElement is NOT a global here (prerequisite for the
    // regression to exist at all — if some future jsdom-like shim leaks
    // into the `node` environment this assertion will flag it before
    // masking the real check below).
    expect((globalThis as Record<string, unknown>).HTMLElement).toBeUndefined();

    const mod = await import("../src/index");
    expect(mod.bootstrapStripe).toBeTypeOf("function");
    expect(mod.WcsStripe).toBeTypeOf("function");
    expect(mod.getConfig).toBeTypeOf("function");
    expect(mod.getRemoteCoreUrl).toBeTypeOf("function");
  });

  it("root barrel does NOT re-export server-only runtime — those belong to /server", async () => {
    const mod = (await import("../src/index")) as Record<string, unknown>;
    expect(mod.StripeCore).toBeUndefined();
    expect(mod.StripeSdkProvider).toBeUndefined();
  });

  it("/server entry also evaluates under plain Node and exposes the headless surface", async () => {
    const mod = await import("../src/server");
    expect(mod.StripeCore).toBeTypeOf("function");
    expect(mod.StripeSdkProvider).toBeTypeOf("function");
  });
});

describe("publish surface — package.json exports map", () => {
  it("exports['.'].default points to the browser barrel (not server)", () => {
    expect(pkg.exports["."].default).toBe("./dist/index.js");
    expect(pkg.exports["."].default).not.toMatch(/server/);
  });

  it("exports['./server'].default points to the server barrel", () => {
    expect(pkg.exports["./server"].default).toBe("./dist/server.js");
  });

  it("top-level `main` field aligns with exports['.'].default", () => {
    // A drift here means tools that consult `main` (older bundlers,
    // `require.resolve` in some codepaths) see a different root target
    // from tools that consult `exports` — exactly the split-brain
    // packaging regression this suite is meant to pin down.
    expect(`./${pkg.main}`).toBe(pkg.exports["."].default);
  });

  it("types entries align with their JS entries (same barrel shape)", () => {
    expect(pkg.exports["."].types).toBe("./dist/index.d.ts");
    expect(pkg.exports["./server"].types).toBe("./dist/server.d.ts");
    expect(`./${pkg.types}`).toBe(pkg.exports["."].types);
  });
});

// Built-artifact layer. Gated on `dist/` existing so the test file stays
// useful in the fast dev loop (where nothing is built yet) while still
// catching real publish regressions the moment a build has been produced
// (`prepack`, `test:ci`, `test:integration`, or manual `npm run build`).
const distRoot = resolve(pkgRoot, pkg.exports["."].default);
const distServer = resolve(pkgRoot, pkg.exports["./server"].default);
const hasBuild = existsSync(distRoot) && existsSync(distServer);
// Heuristic for "running in CI". GitHub Actions, GitLab CI, CircleCI,
// Buildkite, Jenkins CI plugin, Travis, etc. all set `CI=true` in job
// environments; locally `CI` is typically unset. Missing `dist/` under
// CI means the job is driving `npm test` without a prior build and the
// built-artifact layer would silently skip — upgrade that to a hard
// fail with a clear remediation message so the misconfiguration surfaces
// instead of producing a false-positive green run. Local dev keeps the
// silent skip (the src-level layer already covers fast iteration).
const isCI = !!process.env.CI;

describe.runIf(!hasBuild && isCI)("publish surface — CI requires a prior build", () => {
  it("dist/ must exist under CI: chain the build first (e.g. `npm run test:ci`)", () => {
    expect.fail(
      `[stripe-checkout] dist/ missing under CI (CI=${process.env.CI ?? ""}). ` +
      `The built-artifact layer silently skipped, so publish regressions (dist corruption, ` +
      `exports-map misroute) would not be caught. Point the CI pipeline at ` +
      `\`npm run test:ci\` (which chains \`npm run build\` before the test run), ` +
      `or add a pretest hook that builds. Expected on disk: ` +
      `${distRoot}, ${distServer}.`,
    );
  });
});

describe.skipIf(!hasBuild)("publish surface — built artifacts resolve via exports map", () => {
  it("exports['.'].default file evaluates under plain Node and matches browser barrel contract", async () => {
    const mod = await import(pathToFileURL(distRoot).href);
    expect(mod.bootstrapStripe).toBeTypeOf("function");
    expect(mod.WcsStripe).toBeTypeOf("function");
    expect(mod.getConfig).toBeTypeOf("function");
    expect(mod.getRemoteCoreUrl).toBeTypeOf("function");
    expect((mod as Record<string, unknown>).StripeCore).toBeUndefined();
    expect((mod as Record<string, unknown>).StripeSdkProvider).toBeUndefined();
  });

  it("exports['./server'].default file evaluates under plain Node and matches server barrel contract", async () => {
    const mod = await import(pathToFileURL(distServer).href);
    expect(mod.StripeCore).toBeTypeOf("function");
    expect(mod.StripeSdkProvider).toBeTypeOf("function");
  });
});
