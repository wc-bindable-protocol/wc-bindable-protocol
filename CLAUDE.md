# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

This is an npm workspaces monorepo. Run from the repository root unless noted.

```bash
npm install --legacy-peer-deps  # bootstrap all workspaces (see note below)
npm test                      # run vitest across the whole repo (excludes integration/)
npm run test:watch            # vitest watch mode
npm run test:coverage         # workspace-aggregated coverage
npm run build                 # tsc build for every workspace
npm run examples              # vite dev server for examples/ (http://localhost:5173)
```

Single test / single workspace:

```bash
npx vitest run path/to/file.test.ts            # one test file (root config, src aliases applied)
npx vitest run -t "name fragment"              # filter by test name
npm test --workspace @wc-bindable/remote       # only one package
```

Integration tests (Playwright, real browser — excluded from `npm test`). All three need `npm run build` first, because they load the packages' built `dist/` through an import map rather than the TypeScript source:

```bash
npm run build                                            # required first
npm run test:integration --workspace @wc-bindable/remote  # real WebSocket round-trip
npm run test:integration --workspace @wc-bindable/core    # real custom element upgrade
npm run test:integration --workspace @wc-bindable/alpine  # real upgrade, through Alpine's scope tree
```

The `core` and `alpine` suites exist for one reason: **happy-dom does not implement custom element upgrade**, which is the platform behavior `syncOn: "define"` is built on. Two divergences (verified against happy-dom 20.8.3) make the relevant cases untestable under vitest — an instance created before `customElements.define()` keeps `constructor === HTMLElement` forever even after `customElements.upgrade()`, and an element already in the document has its *node replaced* by `define()` rather than upgraded in place. The unit tests simulate the prototype swap, which pins our logic but not the platform's half of the contract; these suites cover the rest. Anything that depends on a real upgrade belongs here, not in `tests/*.test.ts`.

`npm install` requires `--legacy-peer-deps`: `@qwik.dev/core@2.0.0-beta.35` declares a peer of `vitest@">=2 <4"`, but the repo is on `vitest@^4`. The conflict is benign for our test suite, but plain `npm install` will ERESOLVE-fail.

## Architecture

### Workspace layout

`packages/*` are published to npm under the `@wc-bindable/*` scope. The root `package.json` is private and exists only to host devDeps and scripts. Two distinct package families live here:

- **Protocol + adapters** — `core` defines the protocol contract; `react`, `vue`, `svelte`, `angular`, `solid`, `preact`, `alpine` are thin framework adapters that consume `bind()` to bridge component state into each framework's reactivity model. Adapters do not import each other.
- **Remote** — `remote` re-implements the same Core/Shell boundary across a network (WebSocket or custom transport). It depends only on `@wc-bindable/core` and is itself transport-agnostic.

`SPEC.md` is authoritative for the core protocol contract; [SPEC-extensions.md](SPEC-extensions.md) is authoritative for the input/command invocation surface, the wire format, and the composition profile (Extensions 1, 2, and 4; Extension 3 is informational). [COMPOSITE.md](COMPOSITE.md) is the non-authoritative companion design doc for Extension 4. [CONFORMANCE.md](CONFORMANCE.md) hosts runnable test vectors for all of them. `README.md` is the user-facing intro. Treat `ls packages/` as the source of truth for the published-package set if the README and disk ever drift.

### The core contract (≈60 LOC)

The entire protocol is in [packages/core/src/index.ts](packages/core/src/index.ts):

- A class extends `EventTarget` and exposes `static wcBindable: { protocol: "wc-bindable", version: 1, properties, inputs?, commands? }`.
- `properties[]` are **outputs** — each entry binds an event name to a property name (with optional `getter` extracting the value from the event). `bind(target, onUpdate)` subscribes to those events and reads each property's current value once for initial sync.
- `inputs[]` and `commands[]` are **declarations only** — they describe the component's input surface for tooling, docs, and remote proxying. They do not create any implicit two-way binding; consumers explicitly assign properties or call methods.
- This explicit-input-side stance is a deliberate non-goal listed in README/SPEC. Do not introduce automatic two-way sync into adapters.

### Framework adapters

All adapters call `bind()` from core and translate updates into their reactivity primitive (`useState`, `ref`, `$state`, signals, etc.). The pattern is uniform across packages — when changing core's `bind()` signature or initial-sync behavior, expect every adapter to need a corresponding update and regression test.

### Remote package

`@wc-bindable/remote` lets the Core run on a server while the client gets a `RemoteCoreProxy` that is itself an `EventTarget`, so `bind()` and every framework adapter work transparently against it. Key invariants documented in [packages/remote/README.md](packages/remote/README.md):

- The client proxy rewrites each declared property to a synthetic per-property event name (`@wc-bindable/remote:<name>`) and the server applies `getter` server-side, so wire values are already-extracted per-property values. **Subscribing to original Core event names on the proxy will not fire** — `bind()` (or property access) is required.
- Wire format is JSON-only. Custom transports must serialize at the boundary even on transports whose native channel could carry richer values, so all transports present the same lossy view.
- `RemoteShellProxy`/`RemoteCoreProxy` are a **protocol layer, not a security boundary** — auth/authz/rate-limiting belong upstream. Do not add ad-hoc auth checks inside the proxy classes.
- `set()` is fire-and-forget (at-most-once); `setWithAck()` is acknowledged delivery. Do not silently change those semantics.

Sibling repos (e.g. `csbc-dev`) consume `@wc-bindable/remote` but are intentionally **not referenced** from this repo's docs. Keep wc-bindable neutral about its consumers — relationship docs belong on the consumer side.

### Test environment

- Root [vitest.config.ts](vitest.config.ts) aliases `@wc-bindable/core` and `@wc-bindable/remote` to their `src/index.ts`, so tests run against TypeScript source rather than built `dist/`. When adding a new published package whose tests import sibling packages, add the corresponding alias here or tests will resolve against possibly-stale `dist/`.
- Default test environment is `happy-dom`. Anything DOM-heavy that happy-dom mishandles (focus, layout, animation frames) should either be moved into the per-package Playwright integration suite or worked around explicitly in the test.
- `**/integration/**` is excluded from the root `npm test` pass — run those via `test:integration` per workspace.
