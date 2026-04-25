// Auto-bootstrap entrypoint for `@wc-bindable/s3/auto`.
//
// This file is intentionally hand-written JavaScript (not compiled from TS)
// and imports from `../../dist/index.js` directly. That pairing is a
// deliberate part of the package shape, not an oversight:
//   - `package.json`'s `exports["./auto"]` resolves to `./src/auto/auto.min.js`,
//     a prebuilt minified companion we ship in the published tarball. When a
//     consumer writes `import "@wc-bindable/s3/auto";` the min file
//     re-imports `../../dist/index.js`, so the consumer's bundler pulls in
//     the already-built tree-shaken ESM — no TS toolchain required on the
//     consumer side.
//   - This non-min copy exists so the package can be used pre-publish (and so
//     playwright / local demos can resolve it without rebuilding the min).
//     The relative `../../dist/index.js` path matches the relative layout
//     the published tarball has after `npm pack`.
// See README "Auto bootstrap" section for the consumer-facing contract.
import { bootstrapS3 } from "../../dist/index.js";

bootstrapS3();
