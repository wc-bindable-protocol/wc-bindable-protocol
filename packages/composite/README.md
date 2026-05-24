# @wc-bindable/composite

Reference implementation of the wc-bindable **Composition profile**
([SPEC-extensions.md § Extension 4](../../SPEC-extensions.md) /
[COMPOSITE.md](../../COMPOSITE.md)).

Expose **many** wc-bindable source targets as **one** wc-bindable shell target.
The composed shell is an ordinary wc-bindable target, so every existing consumer
— `bind()`, the framework adapters, and `@wc-bindable/remote` — works against it
unchanged.

```text
@wc-bindable/core      = observe one target
@wc-bindable/remote    = proxy one target across a transport
@wc-bindable/composite = expose many targets as one target
```

## Profile tiers

This package implements:

- **T1 — Observation** (always): discovery, a synthesized `static wcBindable`
  declaration, name mapping, the three-phase event fan-out, getter / undefined
  preservation, initial-sync `in` semantics, and lifecycle teardown.
- **T2 — Local facade** (default when inputs/commands are exposed): composed
  inputs become assignable members (`shell["ai.prompt"] = v`) and composed
  commands become callable members (`shell["ai.run"](...)`), delegating to the
  mapped source.

Tier **T3** (the Extension-1 `set` / `setWithAck` / `invoke` consumer surface)
is **not** implemented here; the per-instance tier claim reports
`extension1: false`.

### Do you need T3?

T3 is the **consumer-facing Extension 1 method surface** — `shell.set(name, v)`,
`shell.setWithAck(...)`, `shell.invoke(name, ...)`, plus their `*WithOptions`
variants and `dispose()`. You only need it when application code (or a downstream
adapter) calls those **methods by name** and relies on acknowledged delivery,
`AbortSignal` / `timeoutMs`, or the `WC_BINDABLE_*` error envelope.

You very likely do **not** need T3 if you only want to:

| Goal | Use |
|---|---|
| Read composed properties | **T1** (default) |
| Write inputs / call commands **locally** | **T2** facade: `shell["ai.prompt"] = v`, `shell["ai.run"](...)` |
| Expose writable inputs / invokable commands over `@wc-bindable/remote` | **T2** — `RemoteShellProxy` drives the producer through the local facade, not through T3 methods |

So `set` / `setWithAck` / `invoke` as **methods** are the only thing missing.
Until a future version of this package (or a separate package) adds T3, the
options are:

1. **Prefer T2** for local writes and for remote-writable producers — it covers
   the large majority of "I want to set/invoke" cases.
2. If you specifically need the Extension-1 *method* surface on the composed
   shell, wrap this shell in your own thin Extension-1 layer that resolves the
   composed name and delegates to the source (the routing rules are specified in
   [COMPOSITE.md § 8 / § 9](../../COMPOSITE.md)). Do not advertise it as "T3"
   unless it implements the **full** surface (see COMPOSITE.md § Profile tiers).

A T3 implementation will set `extension1: true` on the tier claim; tools should
gate the set/invoke affordance on that flag, not assume it.

## JavaScript API

```ts
import { createCompositeTarget } from "@wc-bindable/composite";
import { bind } from "@wc-bindable/core";

const shell = createCompositeTarget({
  sources: { s3: s3Uploader, ai: aiAgent },
  expose: {
    properties: {
      "s3.progress": { source: "s3", name: "progress" },
      "ai.answer": { source: "ai", name: "answer" },
    },
    inputs: { "ai.prompt": { source: "ai", name: "prompt" } },
    commands: { "ai.run": { source: "ai", name: "run" } },
  },
});

// Observe like any wc-bindable target.
const unbind = bind(shell, (name, value) => console.log(name, value));

// T2 local facade.
shell["ai.prompt"] = "summarize this";
await shell["ai.run"]();

shell.dispose(); // detaches every source listener (does NOT dispose sources)
```

Omit `expose` (or pass `"all-prefixed"`) to auto-expose every source member
under its default `<sourceId>.<sourceName>` name:

```ts
const shell = createCompositeTarget({
  sources: { s3: s3Uploader, ai: aiAgent },
  expose: "all-prefixed",
});
```

> **Production tip — pin the public surface with an explicit `expose` map.**
> `"all-prefixed"` derives the shell's public API from whatever the sources
> currently declare, so **adding a source, or a source changing its own
> `wcBindable` declaration, silently changes the composed shell's surface** —
> potentially adding/removing properties, inputs, or commands that downstream
> consumers depend on. It is great for prototyping; for a stable contract, list
> the members you intend to expose explicitly (an unknown member name in the map
> then fails fast at construction). `"all-prefixed"` is a documented convenience,
> not a normative requirement (see COMPOSITE.md § Open questions).

## Declarative custom-element API (Declarative Shadow DOM)

For HTML-first systems (e.g. `@wcstack/state`), declare a composite as a custom
element. A **definition element** carries `data-wc-composite-definition`; its tag
name becomes the composed custom element, and its **Declarative Shadow DOM**
(`<template shadowrootmode="open">`, legacy `shadowroot="open"` also accepted)
wraps the composed source elements. Each source is tagged with
`data-wc-source="<id>"` and may carry an optional `data-wc-expose`.

```html
<my-ai-workbench data-wc-composite-definition>
  <template shadowrootmode="open">
    <s3-uploader data-wc-source="s3"
      data-wc-expose="properties: progress, url; inputs: file; commands: upload"></s3-uploader>
    <ai-agent data-wc-source="ai"
      data-wc-expose="properties: loading, answer; inputs: prompt; commands: run"></ai-agent>
  </template>
</my-ai-workbench>

<!-- After registration, plain instances compose their sources: -->
<my-ai-workbench></my-ai-workbench>
```

```ts
import { registerCompositeDefinitions } from "@wc-bindable/composite";

// Scans for [data-wc-composite-definition], awaits each source tag's
// customElements.whenDefined(), then registers each composed custom element.
await registerCompositeDefinitions(document);
```

The first argument is the **scan root** and defaults to `document`; pass any
`ParentNode` (or a definition element itself) to scope the scan — important in
large apps or when multiple frameworks share a page:

```ts
// Only register definitions inside #app (the root element is itself included
// if it carries data-wc-composite-definition).
await registerCompositeDefinitions(document.querySelector("#app")!);
```

Each instance builds its **own** shadow root containing one fresh instance of
every source tag, binds an engine to them, and exposes the composed surface
(property getters, and the T2 input setters / command members). Omitting
`data-wc-expose` auto-exposes every source member (subject to the same
"pin the surface explicitly in production" caveat as the `"all-prefixed"` JS
default above).

#### `data-wc-expose` syntax

`data-wc-expose` is a **package-specific** convenience attribute (not part of the
normative profile; COMPOSITE.md shows it under the non-normative declarative
candidate API). Per-source grammar, whitespace-insensitive:

```text
properties: <name>, <name>; inputs: <name>; commands: <name>, <name>
```

- Segments are separated by `;`; each segment is `<kind>: <comma-separated names>`.
- `<kind>` is `properties` / `inputs` / `commands` (singular `property` /
  `input` / `command` also accepted). Segments may appear in any order, and any
  kind may be omitted.
- Names are the **source-local** member names; the composed public name becomes
  `<sourceId>.<name>`.

**Errors fail loudly at registration** — a segment with no `:` (`"progress"`),
an unknown kind (`"propertis: x"`), a name that does not exist on the source, a
duplicate composed name, or a reserved name all throw (the
`registerCompositeDefinitions` / `defineComposite` promise rejects). There is no
silent "best-effort" partial parse. Build the expose map in JS instead (pass
`expose` to `defineComposite`) if you prefer not to use the string DSL.

You can also register programmatically:

```ts
import { defineComposite } from "@wc-bindable/composite";

const Workbench = await defineComposite({
  tagName: "my-ai-workbench",
  sources: [
    { id: "s3", tag: "s3-uploader" },
    { id: "ai", tag: "ai-agent" },
  ],
  // expose?: ExposeConfig — defaults to "all-prefixed"
});
```

> **Source-definition precondition.** Per § Declarative custom element API, the
> composed element is registered only **after** every source tag is defined
> (`customElements.whenDefined`), so a shell instance is never observable with a
> provisional declaration.

## Tier claim discovery

Every shell exposes a frozen, per-instance tier claim under the well-known
symbol `Symbol.for("wc-bindable.composite.tiers")`:

```ts
import { COMPOSITE_TIERS_SYMBOL } from "@wc-bindable/composite";

shell[COMPOSITE_TIERS_SYMBOL];
// { protocol: "wc-bindable.composite", version: 1,
//   localFacade: true, extension1: false }
```

A tool MUST read this (not the core declaration) to decide whether to render
set / invoke affordances — a declared input/command is metadata, not a guarantee
of delegation. The claim is a **hint, not a permission**: composition is not a
security boundary.

## Notable invariants implemented

- **Three-phase fan-out** (extract → commit → dispatch) so siblings sharing one
  source event see a coherent committed snapshot, and a getter never observes a
  partially-updated cache (COMPOSITE.md § 6).
- **Getter-failure isolation**: a throwing source getter is reported (via
  `reportError`, else the injected logger) and its siblings still dispatch
  (§ 12).
- **undefined / null preservation**: values are carried out-of-band on the shell
  event, not through `CustomEvent.detail` (which would coerce `undefined` →
  `null`) (§ 7).
- **Reserved-name rejection** mirroring the remote wire profile (the
  `@wc-bindable/` prefix plus `__proto__` / `constructor` / `prototype`), the
  fixed-API members, and the T2 cross-surface collision rule (§ 4).
- **Immutable synthesized declaration** (frozen for the shell's lifetime, § 11).
- **Borrow semantics**: `dispose()` detaches the shell's own source listeners
  and never disposes the source targets (§ 10).

## Remote interop

A composed shell can include `RemoteCoreProxy` sources, and a **T2** shell may be
exposed through `@wc-bindable/remote` for writable inputs / invokable commands.
A non-T2 (observation-only) shell exposed remotely must use an observation-only
wire projection — see COMPOSITE.md § Remote interop. Set `remoteCompatible: true`
on the config to advertise the claim; reserved names are rejected regardless.

## License

MIT
