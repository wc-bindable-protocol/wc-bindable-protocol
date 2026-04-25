// Setup file for Vitest (happy-dom environment).
//
// --- Optional peer deps in tests -----------------------------------
//
// Both `flagsmith-nodejs` and `unleash-client` are declared as
// OPTIONAL peer deps in `package.json`. Their `devDependencies`
// status differs, but that difference is NOT what makes the tests
// work — both paths rely on Vitest's `vi.mock(specifier, factory)`
// virtual-module support, which serves the factory's return value
// when no physical module is resolved on disk.
//
//   * `unleash-client`  — not listed in devDependencies. Tests
//     succeed via the vi.mock virtual module alone.
//   * `flagsmith-nodejs` — listed in devDependencies (historical),
//     but tests do NOT depend on that declaration: the suite still
//     passes when the package is absent from `node_modules/`, which
//     is the de-facto state of this workspace. Treat the devDep line
//     as vestigial — removing it would not break tests, and the
//     invariant the tests enforce is "virtual mock only".
//
// No physical SDK needs to be installed to execute this suite. Do
// NOT introduce a hand-placed stub under `node_modules/<peer>/` to
// "make it work" — an earlier revision did that and ended up
// silently masking a vi.hoisted regression in UnleashProvider.test.ts
// (the `vi.mock` factory referenced closure state that vitest could
// not hoist above imports, so the real on-disk stub beat the mock to
// module resolution). The `vi.hoisted(...)` pattern in that test
// file is what keeps the virtual-module path viable; if you add a
// new provider test that depends on a peer SDK, mirror it:
// top-level `vi.mock(specifier, hoistedFactory)` with no physical
// fallback in `node_modules/`.
