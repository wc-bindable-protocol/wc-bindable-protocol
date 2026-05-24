# wc-bindable Composite Profile (companion to Extension 4)

> **Status — promoted to a normative extension.** The composition profile defined
> in this document has been **promoted to [SPEC-extensions.md § Extension 4 —
> Composition](SPEC-extensions.md#extension-4--composition), which is now its
> authoritative, normative home.** This document is retained as the **companion
> design document** — extended rationale, worked examples, candidate package APIs,
> and open questions that the condensed Extension 4 text does not carry. Where this
> document and Extension 4 disagree on a requirement, **Extension 4 is
> authoritative.** The normative contract for the core protocol remains
> [SPEC.md](SPEC.md); the other behavioral extensions live alongside Extension 4 in
> [SPEC-extensions.md](SPEC-extensions.md); conformance vectors live in
> [CONFORMANCE.md § Extension 4 — Composition vectors](CONFORMANCE.md).
>
> **Scope of MUST / SHOULD in this document.** The RFC 2119 keywords below now
> correspond to the **normative requirements of Extension 4** — an implementation
> that claims the composition profile MUST satisfy them. They add no obligation to
> a plain `bind()` / `@wc-bindable/core` / `@wc-bindable/remote` user who does not
> use composition. Because Extension 4 is authoritative, the wording here is a
> **non-authoritative restatement** kept in sync with that section; cite Extension
> 4, not this document, in conformance discussions.

**Reading rule for callout blocks.** This draft uses blockquotes for callouts of
several kinds. A blockquote that contains RFC 2119 keywords is still normative
unless it is explicitly introduced as non-normative guidance such as
"Implementation guidance", "Reference-implementation choice", or "Security
note". The `>` formatting is editorial emphasis, not a downgrade of the
requirement level.

This draft explores a small composition profile plus a possible reference
implementation package, tentatively named `@wc-bindable/composite`.

**Language / runtime scope for v1.** Unlike core's Level 1 protocol contract,
this draft profile is a **JavaScript single-realm interoperability profile**.
The standard discovery and execution surfaces pinned here — `Symbol.for(...)`,
`EventTarget`, own properties/getters, `Object.is`, `Object.freeze`, and the
same-turn / microtask ordering notes — are JavaScript runtime mechanisms. A
non-JS implementation may mirror the model, but it cannot claim conformance to
this v1 profile unless it exposes an equivalent JS boundary for those pinned
surfaces.

The central idea is simple: multiple wc-bindable source targets can be exposed
as one ordinary wc-bindable shell target. Existing consumers then keep using the
same `bind()` / framework adapter / remote proxy surfaces they already know.

```text
@wc-bindable/core
  = observe one target

@wc-bindable/remote
  = proxy one target across a transport

@wc-bindable/composite
  = expose many targets as one target
```

## Recommendation

Do not standardize a large composition DSL first.

Instead:

1. Define a small **Composed Shell Profile** that states what a composed target
   must preserve to remain a valid wc-bindable target.
2. Build `@wc-bindable/composite` as an experimental implementation that proves
   the profile with both JavaScript and declarative custom-element APIs.
3. Promote only the stable invariants back into `SPEC-extensions.md` once the
   implementation has enough usage pressure.

In short:

```text
The composite implementation makes composition convenient.
The spec only defines the invariants required for interop.
```

## Interop Core At A Glance

| Slice | What v1 fixes | Where |
|---|---|---|
| **T1 core** | discovery, synthesized declaration, name mapping, initial sync, three-phase event fan-out, getter semantics, teardown, immutability | §§ 1-7, 10, 11, 12(T1 rules) |
| **T2 optional** | local facade assignment / method delegation | §§ 8-9, § 4 collision rules |
| **T3 optional** | Extension-1-capable `set` / `setWithAck` / `invoke` routing and pending-call lifecycle | §§ 8-10, 12(T3 rules) |
| **Remote interop** | when a composed shell may be handed directly to `RemoteShellProxy` | § Remote interop |

The minimum interoperability nucleus is **T1**. T2, T3, and remote-facing
projection rules layer on top of that nucleus; they do not redefine it.

## Goals

- Expose multiple wc-bindable targets as one wc-bindable target.
- Keep the core discovery path unchanged: `target.constructor.wcBindable`.
- Preserve `bind()` initial sync, event updates, teardown, and getter semantics.
- Preserve existing adapter compatibility without per-framework changes.
- Allow composition to be used by plain custom elements, `@wcstack/state`,
  remote proxies, and future tooling.
- Keep the first standard surface small enough that implementations can compete
  on ergonomics without fragmenting interop.

## Non-goals

- Do not add `target.wcBindable` or any per-instance discovery override.
- Do not change the core declaration schema.
- Do not require core consumers to understand composition metadata.
- Do not standardize a full HTML DSL before a reference implementation exists.
- Do not make composition a security boundary. Auth, authorization, rate
  limiting, and application payload validation remain upstream concerns, just
  as for remote proxying.

## Terminology

| Term | Meaning |
|---|---|
| **Source target** | A wc-bindable target included in a composition. |
| **Composed shell** | The target exposed to consumers after composition. |
| **Source id** | A stable local name for a source, such as `s3` or `ai`. |
| **Source name** | A property / input / command name inside one source declaration. |
| **Composed name** | The public name exposed by the shell, commonly `<sourceId>.<sourceName>`. |
| **Event rewriting** | Re-emitting source updates as shell-owned events. |

## Composed Shell Profile

This section is the candidate protocol-level profile. It deliberately avoids
specifying any particular JavaScript factory, custom-element tag name, HTML
attribute syntax, or TypeScript helper type.

> **Candidate normative language.** The RFC 2119 keywords below are *candidate*
> profile requirements — their exact scope is defined in the draft banner's
> "Scope of MUST / SHOULD" note at the top of this document.

### Profile tiers

The single biggest design risk in composition is conflating distinct capability
surfaces into one profile. Core's `inputs` and `commands` are **declarations
only** — core attaches no execution meaning to them (see [SPEC.md § Input
Descriptor](SPEC.md#input-descriptor) / [§ Command
Descriptor](SPEC.md#command-descriptor) and the project's explicit-input-side
non-goal). Two *different* execution surfaces can sit on top of those
declarations, and they are **independent**:

- a **local facade** — materializing `shell["ai.prompt"] = v` and
  `shell["ai.run"](...)` as real members of the shell object; and
- an **Extension-1 surface** — exposing the Extension 1 call *methods*
  (`set` / `setWithAck` / `setWithAckOptions` / `invoke` / `invokeWithOptions`;
  see the T3 row) that take the composed name as a string argument.

Neither requires the other. A shell can expose `invoke("ai.run", …)` without
ever making `shell["ai.run"]` a callable member, and vice versa. The profile
therefore defines a base tier plus **two optional, independently-claimable**
execution tiers. An implementation states which tiers it claims.

| Tier | Surface | Adds (on top of T1) |
|---|---|---|
| **T1 — Observation-only** | Property observation | Base. §§ 1–7, 10, 11 (discovery, declaration shape, name mapping, collision policy, initial sync, event rewriting, getter semantics, lifecycle, stability). |
| **T2 — Local facade** | `shell[N] = v` / `shell[N](...)` | § 8 (input assignment delegation), § 9 (command method delegation), and the cross-surface collision rule in § 4 (because T2 materializes names as members of one object). |
| **T3 — Extension-1-capable** | The full Extension 1 consumer-side call surface: `set` / `setWithAck` / `setWithAckOptions` / `invoke` / `invokeWithOptions` (plus the mandatory `dispose`) | The Extension-1 routing rules in §§ 8–9 (resolve the composed name argument to the same source member). Does **not** require T2 and is **not** subject to the § 4 cross-surface collision rule — its names are string arguments, not materialized members. |

A T3 claim is a claim of **Extension 1 conformance**, not a composite-only
convenience subset. A shell that exposes only some of those methods (e.g. `set`
and `invoke` but not `setWithAckOptions`) is **not** T3 — it is an
implementation-specific surface that this profile does not name. Implementations
wanting a smaller surface SHOULD expose it under their own name rather than
labeling it "Extension-1-capable", so consumers can rely on the full
options / `AbortSignal` / `timeoutMs` / error-envelope contract whenever they
see "T3". See [SPEC-extensions.md § Methods](SPEC-extensions.md#methods) for the
authoritative surface.

T2 and T3 are siblings, not a stack: an implementation MAY claim **T1 only**,
**T1 + T2**, **T1 + T3**, or **T1 + T2 + T3**.

A T1 shell MAY still *declare* `inputs` / `commands`, but for **tooling, docs,
and codegen only** — not for remote invocation. The metadata alone installs no
delegation, so:

- assigning a declared T1 input does nothing useful, and invoking a declared
  T1 command is not wired to any source; and
- **a T1 shell cannot satisfy the remote-producer *execution* capability** —
  i.e. it cannot serve *writable inputs / invokable commands* over the wire. (A
  T1 shell can still be exposed remotely for **observation**: properties sync
  and update normally; see § Remote interop.) `@wc-bindable/remote`'s
  `RemoteShellProxy` applies an inbound `set` by **property assignment**
  (`core[name] = value`) and an inbound `cmd` by **method call**
  (`core[name](...)`) — i.e. it drives the **local facade (T2)**. Exposing a
  composed shell through `@wc-bindable/remote` for writable inputs / invokable
  commands therefore requires **T2**, not merely a T1 declaration. (T3's own
  `set` / `invoke` methods are a *consumer-facing* surface and are not what
  `RemoteShellProxy` calls.)

The MUSTs in §§ 8–9 below apply **only** to the tier each rule names.

> **T3 is a consumer-facing surface, not a remote-producer capability.** These
> are two different roles that both involve "Extension 1" and are easy to
> conflate:
>
> - **T3** makes the composed shell a *consumer-facing* target whose own
>   `set` / `setWithAck` / `invoke` methods a local caller (or a downstream
>   adapter) invokes. It says nothing about whether the shell can sit behind
>   `RemoteShellProxy`.
> - **Remote-producer capability** is the shell's ability to be the `core`
>   that `RemoteShellProxy` drives. `RemoteShellProxy` reaches the target only
>   through the **local facade (T2)** — property assignment and method call —
>   so it requires **T2**, and a T3-only shell does **not** satisfy it (its
>   `set` / `invoke` methods are never called by `RemoteShellProxy`).
>
> So, by intent:
> - "I want **writable inputs / invokable commands** over `@wc-bindable/remote`"
>   ⇒ claim **T2** (the surface `RemoteShellProxy` actually drives).
> - "I want **observation-only** remote exposure" ⇒ no execution tier is needed;
>   expose an **observation-only remote-facing projection** (properties only — see
>   § Remote interop). A T1 shell qualifies for this.
> - "I want **local consumers** to call `shell.invoke(...)` /
>   `shell.setWithAck(...)`" ⇒ claim **T3**.
> - Wanting writable-remote *and* a local Extension-1 surface ⇒ claim **T2 + T3**.
>
> Note the second bullet: "expose over the network" does **not** imply T2 — only
> *writable / invokable* remote exposure does. Observation-only remote exposure is
> open to a plain T1 shell via its projection.

#### Tier claim must be discoverable out-of-band

A composed shell's tier claim is **not** derivable from
`constructor.wcBindable`. The core declaration deliberately carries no
composition metadata (§ 2), and — consistent with Extension 1's "declaration ≠
execution capability" model — a declared `inputs` / `commands` entry signals only
that a name exists, never that it is assignable / invokable. A T1 shell and a
T2/T3 shell can therefore present byte-identical declarations. A tool that infers
"this has `inputs`, so I'll render an editable field" from the declaration alone
will be wrong for every T1 shell.

To keep composite shells interoperable, the tier claim MUST be discoverable
through a channel **other than** the core declaration — and that channel cannot
be left fully implementation-defined, or a tool still has no implementation-
independent way to read it. The profile therefore pins **one standard discovery
surface** that every composed shell MUST support, so a tool can read the claim
from any conforming shell without per-implementation glue:

> **Standard tier-claim surface (MUST).** A composed shell MUST expose a
> property keyed by the well-known symbol
> `Symbol.for("wc-bindable.composite.tiers")` whose value is an object carrying
> **at least** these four required fields, describing **this instance's** claim:
>
> - `protocol: "wc-bindable.composite"` — identifies the discovery object so a
>   reader can tell it apart from an unrelated symbol value.
> - `version: number` — an **integer `>= 1`** naming the **composite profile**
>   version this object conforms to (this version of the profile is `1`). This
>   is deliberately separate from the core protocol version on
>   `constructor.wcBindable.version`: that field versions the binding contract,
>   this one versions the composition discovery surface and its tier semantics.
>   A consumer MUST read `version` before relying on the meaning of any other
>   field, so a future revision can tighten semantics without an old consumer
>   silently misreading a new object as v1. **Unlike core's protocol versioning
>   rule in [SPEC.md § Versioning](SPEC.md#versioning), this field is a
>   fail-closed compatibility gate**: consumers MUST NOT apply core's
>   "accept every integer `>= 1`" rule to the tier-claim object.
>
>   **Fail-closed on an unsupported `version` (MUST).** A consumer that does not
>   support the advertised `version` MUST treat the tier claim as **unavailable**:
>   it MUST NOT render execution affordances on the basis of `localFacade` /
>   `extension1` (it falls back to the same "treat as observation-only until
>   confirmed" posture it uses when no claim is present at all), and it MUST
>   ignore the optional fields (`remoteCompatible`, `reconnectResync`, …) except
>   for diagnostics. This is the whole point of the field: an old consumer facing
>   a newer object that may have tightened the meaning of `localFacade` /
>   `extension1` must err toward *not* offering an affordance, never toward
>   offering one it can no longer interpret safely. (`protocol !==
>   "wc-bindable.composite"` is treated the same way — not a recognized claim.)
> - `localFacade: boolean` — `true` ⇒ this instance claims T2.
> - `extension1: boolean` — `true` ⇒ this instance claims T3. (Both `false` ⇒
>   T1-only.)
>
> The value MUST reflect the instance actually in hand, not merely what the
> producing implementation is capable of. Reading this symbol MUST NOT throw and
> MUST be stable for the shell's lifetime (consistent with the § 11 immutability
> rule).
>
> **Ownership and mutability.** The symbol MUST resolve as an **own** property of
> the shell (a data property or an own getter) — not something reachable only via
> the prototype chain — so a consumer reads the same claim regardless of how the
> shell was wrapped. Every read MUST yield the same logical claim (an own getter
> MUST be idempotent and side-effect-free). The returned object SHOULD be frozen
> (`Object.freeze`), and consumers MUST treat it as **read-only** — a consumer
> MUST NOT mutate it, and an implementation MUST NOT hand out a shared mutable
> object whose later mutation would change what another consumer already observed.
> Together these keep two inspections of the same instance from disagreeing.
>
> **The object is an open shape: it MAY carry additional fields, and consumers
> MUST ignore fields they do not recognize.** This unknown-field-ignore rule is
> what lets the surface grow without breaking existing tools — the same
> forward-compatibility posture the core declaration uses for unknown descriptor
> fields (see [SPEC.md § Versioning](SPEC.md#versioning)). A validator MUST NOT
> reject the object solely for containing fields beyond the required ones. The
> field name space splits into two kinds to keep that growth collision-free:
>
> - **Profile-defined fields** are reserved by this profile. `protocol`,
>   `version`, `localFacade`, and `extension1` are the **required** profile-defined
>   fields. Two further profile-defined fields are reserved and **conditionally
>   required**: `remoteCompatible: boolean` (§ Remote interop) — a shell that
>   claims remote compatibility MUST set it `true`, and a shell that does not MAY
>   omit it (absent ≡ `false`); and `reconnectResync` (§ 10) — a shell that
>   detaches/reinstalls listeners across reconnect MUST set it to one of
>   `"unconditional" | "changed-only" | "silent"`, and a shell with no such gap
>   MAY omit it. Future profile revisions MAY reserve further plain (unprefixed)
>   names; an implementation MUST NOT repurpose a plain name for a different
>   meaning.
> - **Implementation-private fields** MAY be attached for vendor-specific
>   discovery metadata, but they MUST use an implementation namespace so they
>   cannot collide with a present or future profile-defined name — e.g.
>   `"myImpl:foo"` or a `vendor`-prefixed name like `vendorFoo`. Using a plain
>   (unprefixed) name for a private field is non-conformant precisely because a
>   future profile revision may reserve that plain name. A consumer that does not
>   recognize a (namespaced or plain) field ignores it per the rule above; the
>   namespace requirement protects *future* profile fields, not present consumers.

This handles the per-instance case directly: when a single factory can produce
different tiers per call (e.g. `createCompositeTarget({ ... })` yields a T1-only
shell for one config and a T1+T3 shell for another), the symbol on each instance
carries that instance's claim. A package-level / static conformance document is
**not** a substitute, because "this implementation *supports* T3" does not tell a
tool whether *this instance* claims it.

An implementation MAY *additionally* publish a machine-readable conformance claim
at the package / implementation level (the conformance document / API described
in § Draft conformance vectors) — e.g. to declare which optional, conditional
vectors it runs — but that is supplementary to, never a replacement for, the
per-instance symbol above.

Future revisions MAY define richer discovery surfaces; the symbol is the v1
interoperable minimum that MUST exist so independent tools converge today. Until a tool has confirmed a
T2 or T3 claim through such a channel, it **MUST NOT** present a declared input
as assignable or a declared command as invokable — it MUST treat
declaration-only `inputs` / `commands` as descriptive metadata (names, types,
docs) and render no execution affordance. This is the composite analogue of
Extension 1's rule that a name being declared does not imply it can be `set` /
`invoke`d.

> **Security note — the claim is a hint, not a permission.** Any object in the
> same JS realm can set `Symbol.for("wc-bindable.composite.tiers")` (and the
> Extension-1 marker, § 8) to arbitrary values; these symbols are forgeable and
> carry no authenticity guarantee. They exist to let cooperating tools render the
> *right affordance*, not to authorize anything. A devtool, automation runner, or
> adapter MUST NOT treat a `true` claim as permission to perform an action it
> would not otherwise be allowed to perform — composition is explicitly **not** a
> security boundary (see Non-goals), and auth / authz remain upstream concerns
> exactly as for remote proxying. Reading the claim to decide *whether to show a
> set/invoke control* is fine; reading it to decide *whether the caller is
> allowed to* is not.

### 1. Discovery

A composed shell MUST expose its synthesized declaration through
`target.constructor.wcBindable`.

A composed shell MUST NOT require consumers to read `target.wcBindable`.

If a composed shell needs per-instance declarations, it MUST use an isolated
constructor pattern, such as a generated subclass per composed target. This is
the same shape used by remote proxies for declaration isolation.

### 2. Declaration shape

The synthesized declaration MUST satisfy the core `WcBindableDeclaration`
schema:

```typescript
interface WcBindableDeclaration {
  protocol: "wc-bindable";
  version: number;
  properties: { name: string; event: string; getter?: (event: Event) => unknown }[];
  inputs?: { name: string; attribute?: string }[];
  commands?: { name: string; async?: boolean }[];
}
```

The composition profile SHOULD NOT add required composition-specific fields to
the declaration object itself. Core consumers must be able to ignore composition
entirely and still bind to the shell.

### 3. Name mapping

Each exposed property / input / command MUST map to exactly one source member.

The same underlying source object MAY appear behind more than one composed name
or more than one source id. Those are distinct exposed members for naming and
delegation, and the shell MAY keep separate lookup tables or even separate
listener registrations for them. But aliasing does not relax § 6's determinism
requirements: when two or more composed properties are backed by the same
underlying source-event occurrence, the shell's observable result MUST still be
equivalent to one shared extract → commit → dispatch cycle across that whole
set, even if the implementation internally reached them through multiple aliases
or duplicate listener registrations. The profile therefore does not require
listener deduplication across aliases or diamond-shaped composition graphs, but
it does require alias-transparent fan-out semantics.

Composition graphs MUST still be acyclic at construction time: a shell MUST NOT
depend on itself, directly or transitively, as one of its own sources. The
profile's declaration and tier claim are fixed before observation begins (§ 11),
so a cyclic composition has no conformant construction order.

The mapping SHOULD be modeled internally as structured data:

```typescript
type SourceRef = {
  source: string;
  name: string;
};
```

String forms such as `"s3.progress"` MAY be used as display names, but
implementations SHOULD NOT parse them as the only source of truth. Source names
are not forbidden from containing dots by the core protocol, so splitting a
string on `.` is ambiguous.

The recommended default composed name is:

```text
<sourceId>.<sourceName>
```

An implementation that uses the default `<sourceId>.<sourceName>` naming MUST
reject an empty source id and a source id containing `.` (the recommended-default
separator) at construction. This keeps the default composed name unambiguous even
though, per the note above, implementations resolve the mapping through the
structured `SourceRef` rather than by splitting the display string. Source ids
are local labels chosen by the composition author, not source-declaration
members, so the remote-reserved names in § 4 do not apply to them.

> **Implementation guidance — prototype-pollution-safe source maps (non-
> normative).** Because source ids are not wire names, the § 4 reserved-name rule
> does not cover them — but a JS reference implementation that stores
> `sources: { [id]: target }` or builds id-keyed lookup tables as plain objects
> can still trip over `__proto__` / `constructor` / `prototype` *as map keys*:
> `map["__proto__"] = target` mutates the prototype chain rather than storing an
> entry, corrupting later source lookups. This is an implementation hazard, not a
> protocol one. Implementations SHOULD key source maps with a `Map` or a
> `null`-prototype record (`Object.create(null)`), and MAY reject
> prototype-pollution-prone source ids (`__proto__`, `constructor`, `prototype`)
> at construction by default.

An implementation that does not use the dotted default naming (it requires every
composed name to be given explicitly) MAY relax the `.` restriction, but still
SHOULD reject an empty source id.

Implementations MAY support aliases, but aliases must still resolve to one
source member unambiguously.

### 4. Collision policy

The synthesized declaration MUST NOT contain duplicate names within
`properties`, within `inputs`, or within `commands`.

An implementation that claims remote compatibility MUST reject **the entire
remote wire profile's reserved-name set**, not just a subset. Concretely, the
implementation MUST apply the **same reserved-name decision** that
[SPEC-extensions.md § Reserved names](SPEC-extensions.md#reserved-names) defines
normatively — i.e. a name is rejected here if and only if that section would
reject it. Where the implementation can share the wire profile's validator (e.g.
a JS implementation importing `@wc-bindable/remote`'s reserved-name check) it
SHOULD do so rather than re-implementing the predicate; a separate-package
implementation (or one mirroring the model in another runtime per § scope) MUST
instead track the SPEC-extensions.md definition itself. Either way the COMPOSITE
profile does **not** re-list the set
as its own normative copy — that is what keeps it from drifting as the wire
profile evolves. As of the current SPEC-extensions.md the minimum is:

- any name whose first 13 characters, compared **case-insensitively**, equal
  the wire-namespace prefix `@wc-bindable/` (so `@wc-bindable/foo`,
  `@WC-BINDABLE/foo`, etc. are all rejected); and
- the exact prototype-pollution-prone strings `__proto__`, `constructor`, and
  `prototype`.

Note the prefix rule in particular: the recommended default *event* naming in
§ 6 uses the `@wc-bindable/composite:` namespace, but that is an **event name**,
not a declared property / input / command `name`. A composed **name** beginning
with `@wc-bindable/` MUST be rejected under remote compatibility.

The `@wc-bindable/composite` reference implementation SHOULD reject this whole
set **by default**, even when remote compatibility is not explicitly claimed.
Allowing a name that can never be remoted has little upside and silently makes a
shell impossible to expose through `@wc-bindable/remote` later; failing fast at
construction is friendlier than a name that works locally but is dropped on the
wire (these names are exactly the ones `@wc-bindable/remote`'s wire validator
discards — see [packages/remote/src/transport/messageValidation.ts](packages/remote/src/transport/messageValidation.ts)).

**Fixed-API collisions (MUST).** A composed name that, once materialized, would
shadow a member the shell requires as fixed public API MUST be rejected at
construction — leaving it implementation-defined ("source member wins" vs
"lifecycle method wins" vs "throws") makes the shell non-interoperable. The
reserved fixed-member set is the union of an **all-tiers base set** and the
**per-tier sets** for whatever tiers the shell claims:

- **All tiers (the discovery + bind-target operational surface).** Every composed
  shell is a discoverable, consumer-side `bind()` target, so the following are
  reserved in **every** tier including T1:
  - **`constructor`** — core discovery reads `target.constructor.wcBindable`
    ([SPEC.md § Discovery Contract](SPEC.md), and the § 1 non-goal against
    per-instance `target.wcBindable`). Materializing a composed property named
    `constructor` breaks discovery both ways: if `shell.constructor` returned a
    composed value, `getWcBindableDeclaration()` could no longer find the
    declaration; if it returned the real constructor, the composed property's read
    / initial sync (§ 5) would be wrong. So a composed name equal to `constructor`
    MUST be rejected (or aliased) on every shell.
  - **`addEventListener` / `removeEventListener`** — the minimum consumer-side
    EventTarget capability core requires (per [SPEC.md § Overview](SPEC.md)) — and
    **`dispatchEvent`** when the shell is also exposed as an event source
    consumers may dispatch on. Materializing `shell["addEventListener"]` as a
    property getter would break the listener-install surface `bind()` depends on
    and corrupt initial sync, so a composed name equal to one of these MUST be
    rejected (or aliased).

  The other prototype-pollution-prone names `__proto__` and `prototype`: a
  composed shell **MUST** reject them when it is remote-compatible (they are in
  the wire reserved-name set, § 4 above) and **SHOULD** reject them even for a
  local-only shell, because a JS object / `Proxy` implementation that
  materializes members can otherwise corrupt its own prototype chain. (The
  tier-claim symbol is symbol-keyed and cannot collide with a string composed
  name, so it needs no string reservation.)
- **T3** additionally reserves `set`, `setWithAck`, `setWithAckOptions`, `invoke`,
  `invokeWithOptions`, and `dispose` (the Extension 1 surface, § Profile tiers).
  A T3 shell MUST reject a composed name equal to any of these — e.g. a source
  command mapped to the composed name `dispose` collides with the T3 lifecycle
  `dispose()` and MUST be rejected (or aliased to a non-colliding composed name).
- **T2** additionally reserves whatever own members it materializes for the local
  facade; a T2 shell MUST reject a composed name that would overwrite a member it
  needs for routing (and the cross-surface rule below).
- A **T2 + T3** shell applies the base set plus **both** per-tier sets.

This is a MUST (the earlier "SHOULD reject names that would shadow required
members" is subsumed by it for fixed public API); an implementation MAY reserve
*additional* internal members beyond these, documented per § 4's
implementation-defined-extensions allowance.

**Cross-surface collisions (T2 only).** Core's name-uniqueness rule is
per-array — a name MAY appear once in `properties`, once in `inputs`, and once
in `commands` simultaneously, because core never materializes those names as
members of one object. A **local facade** (tier T2) does materialize them: a
property becomes a readable member, an input becomes an assignable member, and a
command becomes a callable member of the *same* shell object. A shell that
claims T2 MUST therefore reject any name that collides **across** `properties`,
`inputs`, and `commands`, because `shell["ai.run"]` cannot be both a value
getter and a method at once.

This rule does **not** apply to a T3 (Extension-1-only) shell: its `set` /
`invoke` route a composed name passed as a *string argument*, so a name that
appears in both `inputs` and `commands` is unambiguous (`set("x", v)` vs
`invoke("x", …)`) and need not be rejected. A shell that exposes commands only
through such an explicit dispatch method (e.g. `shell.invoke("ai.run")`) rather
than as a generated `shell["ai.run"](...)` member therefore avoids the
property-vs-command collision entirely. A shell that claims **both** T2 and T3
is bound by the T2 rule for whichever names it materializes as members.

### 5. Initial synchronization

For every exposed property name `N`, the shell MUST surface the current composed
value through ordinary property access, gated by the same `in` check core uses:

```javascript
// When the mapped source member's value is currently known/present:
N in shell === true;
shell[N]; // current composed value
```

`N in shell` MUST reflect whether the mapped source member is currently
known/present — it MUST NOT unconditionally return `true`:

- For a **synchronous local source**, the value is readable immediately, so
  `N in shell` is `true` and `shell[N]` returns the source's current value once
  the source itself reports the property as present (`N_source in source`).
- For a **remote-proxy source** (or any source whose value arrives
  asynchronously), `N in shell` MUST be `false` until the source's value is
  known, then `true` once a value (or an explicit `undefined`) has been
  observed. Returning `true` before the source has synced would make core's
  initial sync read and deliver an unsynced value prematurely.

This mirrors core's normative initial-sync rule (read `target[prop.name]` only
when `prop.name in target` is `true`; see [SPEC.md § Initial Value
Synchronization](SPEC.md#initial-value-synchronization)) and the consumer-side
proxy `has`-trap contract that `@wc-bindable/remote` already implements (a
declared property reports `in === false` until a value is cached). A composed
shell that wraps a remote source MUST preserve that source's `has` behavior
rather than masking it with a blanket `true`.

This requirement exists because re-emitting events alone is not sufficient: core
initial sync reads `target[prop.name]` after checking `prop.name in target`, so
the shell must answer both the `in` probe and the value read consistently.

The correctness of that initial sync still depends on each source honoring
core's getter/property parity requirement: when a source declaration uses a
custom event `getter`, the source property the shell reads for initial sync MUST
represent the same logical value that the getter would later extract from the
event. If a source violates that core invariant, the mismatch is inherited by
the shell rather than repaired by composition.

If the shell's own initial-sync read for an exposed property throws — e.g. a
source accessor throws while the shell is answering `shell[N]` after `N in shell
=== true` — the shell is in the same position as core's install-time initial
sync throw: it MUST tear down any listeners already installed for that shell
before propagating the error. This is an initial-sync/setup failure, not a per-
event fan-out failure, so the § 12 getter-failure isolation rule does not apply
to it.

The shell MAY implement this with generated getters, a JavaScript `Proxy`, or
any equivalent mechanism. The observable behavior is what matters.

### 6. Event rewriting

A composed shell MUST expose shell-owned event names in its synthesized
`properties` descriptors.

The shell SHOULD NOT expose source event names directly. Reusing source event
names leaks implementation details, makes collisions likely, and becomes
especially ambiguous when multiple sources use the same event name.

Recommended default event naming:

```text
@wc-bindable/composite:<composedName>
```

or another implementation-owned namespace that cannot collide with source
events by accident.

Each exposed property MUST map to a **distinct** shell-owned event name. The
default `@wc-bindable/composite:<composedName>` naming satisfies this
automatically because composed names are unique per § 4; an implementation that
chooses a different naming scheme MUST preserve the same one-property / one-
event-name uniqueness.

**Fan-out dispatch algorithm (shared source events).** A single source event MAY
back more than one exposed property — core permits multiple property descriptors
to share one `event` name, discriminated by their `getter` (the `value` / `status`
on one `my-fetch:response` event is the canonical case; see conformance vector 5
and the rationale `@wc-bindable/remote` uses synthetic per-property events for).
This fan-out set is defined by the **underlying source-event occurrence**, not
by source-id boundaries: if the same source object is reachable through aliases
or a diamond-shaped composition graph, every composed property backed by that
one occurrence belongs to the same three-phase cycle.
Here, an **occurrence** means one source-side `dispatchEvent(...)` call on one
`EventTarget` — the unit that delivers the same `Event` instance to every
listener for that dispatch.
When a source event fires, the shell MUST process it in **three ordered phases**,
so that both getter evaluation *and* the dispatched listeners observe one coherent
state:

1. **Extract phase.** Evaluate **every** exposed source property mapped to that
   source event (not only the first), applying each property's getter per § 7,
   and collect the successfully-extracted values into a **temporary buffer**. A
   getter that throws is caught per § 12 (reported, and that property is omitted
   from the buffer); its siblings are still evaluated. The shell MUST NOT write
   any extracted value to its readable cache / `in` presence during this phase.
2. **Commit phase.** After all getters have run, commit the buffered values to
   the readable cache and `in` presence (§ 5) for every successfully-extracted
   property — still **before any shell event for this source event is
   dispatched**.
3. **Dispatch phase.** Then dispatch **one** shell event per buffered (committed)
   property, in declaration order, on each property's own shell-owned event name.

Separating **extract** from **commit** matters because a `getter` is executable
metadata that MAY read shell state: if cache writes were interleaved with getter
evaluation, property `B`'s getter reading `shell["A"]` would see new-or-old `A`
depending on evaluation order, an implementation-defined result. Buffering all
getter results before committing any means **no getter ever observes a
partially-updated cache** — every getter in one fan-out sees the pre-event state,
and every dispatched listener sees the fully-committed post-event state.

Separating **commit** from **dispatch** fixes the **sibling-read snapshot**: a
listener on `A`'s shell event that synchronously reads `shell["B"]` MUST observe
`B`'s **new** value, because phase 2 committed all siblings before phase 3
dispatched anything. (This is the multi-property generalization of the
single-property value-update-before-dispatch rule below.)

So the two interleavings that would otherwise diverge across implementations are
both ruled out: getter-vs-cache ordering (phase 1 never writes cache) and
dispatch-vs-cache ordering ("update A → dispatch A → update B → dispatch B").
A property whose getter throws is neither committed nor dispatched while its
successful siblings are — continuing the fan-out across a sibling failure is only
possible because each getter is evaluated in its own try/catch in phase 1 (a
single shared listener that let the first throw escape could not reach its
siblings; see § 12 for the exact catch-report-continue rule). This makes the
per-property fan-out deterministic instead of implementation-defined ("first match
only" vs "all" vs "successful only", "interleaved" vs "snapshot", and
"getter sees partial cache" vs "getter sees pre-event state").

> **Implementation guidance — fan-out multiplies synchronous work.** One source
> event can fan out to many composed properties, and nested shells / reentrant
> listeners multiply that cost further. Composition is not a security boundary,
> but implementers and operators SHOULD treat deep or wide graphs as a
> synchronous-cost amplifier when reasoning about performance.

**Re-dispatch timing — synchronous, no batching.** When a source event fires, the
shell MUST perform the value-cache update (below) and the shell-event dispatch
**synchronously, within the same call stack** as the source event listener — the
shell MUST NOT defer them to a microtask, a later task, or a batched flush, and
MUST NOT deduplicate or coalesce repeated source events. This mirrors core's
"every event produces a callback, no batching/dedup" rule (see [SPEC.md §
Repeated Events for the Same Property](SPEC.md#repeated-events-for-the-same-property)):
a `bind()` consumer of the shell therefore observes shell updates with the same
synchronous timing it would get binding the source directly. Within a single
source event the per-property fan-out dispatches in declaration order. **Across
*different* sources the profile guarantees no total order** beyond each source's
own synchronous propagation — the shell does not reorder, interleave, or
serialize events from independent sources; they arrive in whatever order the
sources fire, exactly as if the consumer had bound each source separately.

**Value-update-before-dispatch ordering (MUST).** For each composed property the
shell dispatches, it MUST update the property's readable value and its `in`
presence (§ 5) **before** dispatching the corresponding shell event — never
after. A consumer that reads `shell[N]` from inside a shell-event listener (using
the shell as an ordinary `EventTarget`, not via `bind()`) MUST observe the **new**
value, not the previous one. Without this fixed order, two implementations would
diverge — one showing the post-event value, one the pre-event value — on a read
that is fully observable even though `bind()` itself happens to read from the
event payload / getter and would hide the difference.

**Reentrant source events dispatch immediately (nested), not queued.** A shell
event listener MAY synchronously cause **another** source event to fire — e.g.
listener code that writes back to a source. Consistent with the
"synchronous, no batching" rule, the shell MUST process that reentrant source
event **immediately and nested**, running its own full extract → commit →
dispatch cycle to completion before the outer cycle's dispatch phase resumes. The
shell MUST NOT queue the reentrant event until the outer event's dispatch
finishes (queuing would re-introduce the batching this section forbids and make
ordering implementation-defined). Two consequences the shell MUST honor:

- The reentrant cycle's **commit phase runs against the already-committed state
  of the outer cycle** (the outer cycle commits before it dispatches, § fan-out
  above), so the nested getters and listeners observe the outer event's values
  already in cache — there is no half-committed outer state visible.
- After the nested cycle completes, the outer cycle continues dispatching its
  **remaining** listeners; those listeners now observe whatever the reentrant
  cycle committed (the cache is monotonic forward, never rolled back). This is the
  same nesting model the DOM uses for synchronous `dispatchEvent` re-entry, and
  the same hazard core flags for re-entrant producers — component / consumer
  authors SHOULD avoid deep synchronous write-back loops, but the ordering is
  defined rather than left to the implementation.

If the shell exposes `dispose()` and a shell-event listener calls it
synchronously during phase 3, `dispose()` MUST NOT retroactively cancel the
already-buffered dispatch list for that same source-event cycle. The shell MUST
finish dispatching the current cycle's already-committed properties in
declaration order, then apply the disposed state to future source observation and
pending-call handling per § 10 / § 12.

### 7. Getter semantics

The shell MUST preserve the observable getter semantics of each exposed source
property.

When a source property descriptor includes a custom `getter`, the shell MUST
apply that getter to the source event and re-emit the already-extracted value on
the shell event:

```javascript
const value = sourceProp.getter
  ? sourceProp.getter(sourceEvent)
  : sourceEvent.detail;
// NOTE: a bare CustomEvent detail does NOT round-trip top-level `undefined`
// (it surfaces as `null`); see the undefined-preservation MUST below.
shell.reEmit(shellEvent, value);
```

Use a presence check on `getter`, **not** `getter?.(...) ?? sourceEvent.detail`.
The `??` form falls back to `sourceEvent.detail` whenever the getter returns
`null` or `undefined`, which silently discards a getter that *intentionally*
extracts an `undefined` (or `null`) value. This matches core, which applies the
declared getter and uses its result as-is — `const getter = prop.getter ??
DEFAULT_GETTER; getter(event)` — only falling back to the default getter when no
getter is declared, never based on the extracted value (see
[packages/core/src/index.ts](packages/core/src/index.ts) and [SPEC.md § Default
Getter](SPEC.md#default-getter)).

Getter execution is part of phase-1 extraction only. A getter MAY read shell
state, but it MUST NOT synchronously cause a source event to fire or otherwise
re-enter the shell's source-event pipeline. Reentrant source events are defined
only for work triggered from phase-3 listener dispatch (§ 6); allowing phase-1
re-entry would break the "nested work sees the outer cycle's already-committed
state" guarantee.

The synthesized shell property descriptor SHOULD omit `getter` so the default
`event => event.detail` getter reads the already-extracted value.

**Undefined / null preservation is a MUST, the mechanism is implementation-
defined.** When a source getter (or the default extraction) yields a top-level
`undefined` or `null`, the shell MUST deliver that exact value to a consumer
binding the shell — observably identical to what a local consumer binding the
source directly would have seen. A plain `new CustomEvent(shellEvent, { detail:
undefined })` does **not** satisfy this: the structured-clone / `detail` boundary
surfaces top-level `undefined` as `null`, so two implementations would diverge
(one delivering `undefined`, one `null`) — which draft conformance vector 12
forbids. The shell MUST therefore use a mechanism that round-trips the value
faithfully. The mechanism is implementation-defined and MAY be any of:

- a synthesized shell property `getter` that returns the preserved value (the
  shell carries the real value out-of-band and the getter reads it), or
- a sentinel-envelope `detail` the shell's own getter unwraps, or
- a non-`CustomEvent` internal event type that carries arbitrary JS values.

Only the observable result is normative: `undefined` stays `undefined`, `null`
stays `null`. (This is the same representation-gap concern Extension 2 addresses
on the wire with `undefinedProperties`; locally the shell has no JSON boundary to
cross, so it MUST simply preserve the JS value.)

### 8. Inputs

> **Execution-tier rule.** A T1 (observation-only) shell MAY declare `inputs` as
> pure metadata (tooling / docs / codegen) and install no assignment delegation
> at all, exactly as core treats `inputs` as a declaration. The delegation MUSTs
> below bind a shell only once it claims an execution tier — the
> property-assignment rule applies to **T2**, the `set` / `setWithAck` rule
> applies to **T3**.

**T2 (local facade).** If a T2 shell exposes an input, assignment to the
composed input member MUST delegate to the mapped source input. The default
delegation is property assignment:

```javascript
shell["ai.prompt"] = value;
// delegates to
aiSource.prompt = value;
```

**T3 (Extension-1).** If a T3 shell exposes an input, its `set()`,
`setWithAck()`, and `setWithAckOptions()` MUST resolve the composed input name to
the mapped source input. When a shell claims both T2 and T3, both surfaces MUST
resolve the same composed name to the same source input.

> **T3 inherits the full Extension 1 contract; this section defines only source
> routing.** Beyond name resolution, a T3 surface MUST behave exactly as a
> consumer-side Extension 1 surface: the method signatures and the mandatory
> `setWithAckOptions` / `invokeWithOptions` variants, the lifecycle controls
> (`AbortSignal`, `timeoutMs` and its default), the at-most-once vs acknowledged
> delivery semantics, and the error-envelope / `error.code` rules
> (`WC_BINDABLE_*` codes for undeclared name, invalid options, timeout, abort,
> disposed proxy, application throw, etc.) all follow
> [SPEC-extensions.md](SPEC-extensions.md) unchanged. The rules below add only
> the composite-specific concern: which source member a resolved name maps to,
> and what the shell calls on that source.
>
> **Caller-order preservation is scoped to a single source / logical channel.**
> Extension 1's order guarantee is about one proxy's *single logical channel*; a
> composite shell fans calls out to many sources, possibly over distinct
> transports, so it cannot inherit that guarantee globally. The T3 contract is
> therefore narrowed:
>
> - The shell MUST **begin delegation in the order calls were received** — it MUST
>   NOT reorder calls before handing each to its mapped source.
> - For calls delegated to the **same source's** Extension 1 surface, that
>   source's own ordering contract applies (the source preserves caller order on
>   its single logical channel).
> - For calls delegated to **different sources / different logical channels**, the
>   profile guarantees **no** producer-side relative observation order. Code that
>   needs `shell.setWithAck("a.x", …)` to be observed by producer A before
>   `shell.invoke("b.y", …)` is observed by producer B MUST sequence those calls
>   itself (e.g. `await` the first); the shell does not serialize across sources,
>   exactly as if the caller had talked to each source directly.
>
> **Default-timeout ownership (uniform shell contract).** Extension 1 requires a
> consumer-side surface to document its default `timeoutMs`. A T3 shell delegating
> a *no-options call* to an Extension-1-capable source would otherwise inherit
> **that source's** default — so within one shell, `shell.invoke("a.x")` (source
> A, 30 s) and `shell.invoke("b.y")` (source B, some other default) and a
> plain-local-source call (the shell's default) could each time out differently,
> leaving the shell with no single documentable default.
>
> **"No-default-timeout call" defined.** This policy is about the **`timeoutMs`
> axis only**. A call counts as *no-default-timeout* when the caller supplied no
> effective `timeoutMs` — i.e. `setWithAck(N, v)` / `invoke(N, …)`, **and also**
> `setWithAckOptions(N, v, opts)` / `invokeWithOptions(N, args, opts)` where `opts`
> is omitted, `undefined`, or carries `timeoutMs: undefined`. (A caller that
> passes an explicit numeric `timeoutMs`, or the `timeoutMs: 0` "disable"
> sentinel, has supplied a timeout and is **not** in this set.) **Such a call MAY
> still carry other `AckOptions` — most importantly a `signal`** — and those MUST
> be preserved: this policy fills in a missing timeout, it never strips the rest
> of `AckOptions`.
>
> To close the per-source divergence, a T3 shell MUST pick one of two policies and
> **document which**:
>
> - **Normalize (recommended):** the shell defines its own default `timeoutMs` and
>   normalizes every no-default-timeout call to it before delegating — the shell
>   forwards `source.setWithAckOptions(M, v, { ...opts, timeoutMs: shellDefault })`
>   / `source.invokeWithOptions(M, args, { ...opts, timeoutMs: shellDefault })`
>   (i.e. **merge**: keep the caller's `signal` and any other `AckOptions`
>   verbatim, and only fill `timeoutMs`; when `opts` was omitted/`undefined`, this
>   reduces to `{ timeoutMs: shellDefault }`). It MUST NOT forward only
>   `{ timeoutMs: shellDefault }` when the caller passed a `signal`, because that
>   would drop the caller's abort capability and break Extension 1's abort
>   contract through the composite. A pre-aborted `signal` is rejected before
>   delegating (§ 12). The bare `source.setWithAck` / `source.invoke` form is
>   never used under Normalize (it would re-introduce the source's default).
>   Ownership stays source-side (the source still *enforces* timeout/abort), but
>   the *timeout value* is the shell's, so the shell's consumer-facing default is
>   uniform across every source.
> - **Inherit-and-document:** the shell does not normalize the timeout; a
>   no-default-timeout call is delegated bare (`source.setWithAck(M, v)` /
>   `source.invoke(M, args)`) when it also carries no other `AckOptions`, or as
>   `source.setWithAckOptions(M, v, opts)` (caller's `opts` forwarded verbatim)
>   when it carries a `signal` but no `timeoutMs`. Either way the timeout inherits
>   each source's own default; the shell MUST document that its effective default
>   is per-source, not a single value. (The caller's `signal` is still forwarded —
>   the timeout axis is the only thing this policy leaves to the source.)
>
> Either way the choice is part of the shell's documented Extension 1 contract; an
> *explicit* `timeoutMs` (including `0`) passed by the caller is always forwarded
> unchanged, and the caller's `signal` is **always** forwarded under both
> policies. The capability-routing bullets below show the bare-method delegation
> for readability; **under the Normalize policy the no-default-timeout forms are
> replaced by their `…WithOptions(M, …, { ...opts, timeoutMs: shellDefault })`
> equivalents** (signal-preserving) as specified here.

Resolving the name is not enough — the profile MUST also fix **what the shell
calls on the source**, because the answer depends on the source's own
capability (this is what makes composing a remote-proxy source well-defined):

- **Extension-1-capable source** (the source exposes the full input-kind
  Extension 1 subset — `set`, `setWithAck`, **and** `setWithAckOptions` — e.g. a
  `RemoteCoreProxy`): the shell MUST delegate to the source's
  matching method — `shell.set(N, v)` → `source.set(M, v)`,
  `shell.setWithAck(N, v)` → `source.setWithAck(M, v)`,
  `shell.setWithAckOptions(N, v, opts)` → `source.setWithAckOptions(M, v, opts)`
  (forwarding the same `AckOptions`) — so the source's at-most-once vs
  acknowledged semantics, timeout/abort handling, and error codes propagate
  end-to-end. **Subject to the default-timeout policy above:** under the
  Normalize policy a no-default-timeout acknowledged call is delegated as
  `source.setWithAckOptions(M, v, { ...opts, timeoutMs: shellDefault })` (caller's
  `signal` preserved) instead of the bare `source.setWithAck(M, v)` shown here. A
  `shell.setWithAck()` against such a
  source resolves only when the **source's** ack arrives (e.g. the remote ack),
  not when a local assignment returns. Because the `AckOptions` are forwarded,
  `abort` / `timeout` for this source kind are owned by the **source**, not
  separately re-implemented by the shell; the shell adds only `dispose()` as its
  own terminal. See § 12 (T3 pending-call lifecycle) for the exact ownership
  split — this avoids the shell
  and source both acting on the same abort/timeout.
- **Plain local source** (no Extension-1 surface): the shell wraps local
  assignment in Extension-1 semantics — `set()` performs the property
  assignment fire-and-forget; `setWithAck()` / `setWithAckOptions()` perform the
  assignment and resolve once it returns without throwing, or reject with the
  thrown error. `AckOptions` are honored only to the extent they are meaningful
  for a synchronous operation: a **pre-aborted** signal and **invalid options**
  MUST be checked *before* the assignment and reject without assigning, but
  `timeoutMs` **cannot preempt a synchronous setter** — a property assignment
  runs to completion on the current turn, and a setter that blocks the event
  loop also blocks the timer that would fire the timeout. The profile therefore
  does NOT require `WC_BINDABLE_TIMEOUT` for synchronous local assignment; an
  implementation MAY ignore `timeoutMs` for that path, or apply it only to any
  genuinely asynchronous waiting the shell itself performs. (For `invoke()` on a
  local source, the shell awaits a returned thenable, so `timeoutMs` *is*
  meaningful there and applies normally — see § 9.)

A shell detects source capability by feature-testing the source for the methods
it will actually call, and MUST classify each source into one of **three** states
per delegation kind — not two. A two-way "capable vs fall back to local" split is
unsafe, because a source that carries a *partial* Extension 1 surface (e.g. a
legacy / partial proxy that exposes `setWithAck` but not `setWithAckOptions`) is
**not** an ordinary local target: writing `source[M] = value` on a remote proxy
hits its local cache / proxy facade instead of crossing the wire. Silently
degrading such a source to the local path is a correctness hazard. The required
classification (this is the default **auto** behavior; an explicit override,
expressible per delegation kind, can change it — see the override note below):

- **Fully Extension-1-capable** — the source exposes the *entire* required
  subset for that delegation kind:
  - inputs: `set`, `setWithAck`, **and** `setWithAckOptions`;
  - commands: `invoke` **and** `invokeWithOptions`.

  The shell delegates to the source's Extension 1 methods.
- **No Extension 1 surface at all** — the source exposes *none* of those methods
  for that delegation kind, i.e. it is a genuine ordinary local target whose
  member is a plain assignable property / callable method. Only then MAY the
  shell use the plain-local-source wrapping path.
- **Partial Extension 1 surface** — the source exposes *some but not all* of the
  required methods for that delegation kind. The shell MUST reject at
  construction. It MUST NOT silently fall back to the local-assignment path
  (which could corrupt a proxy's internal state) and MUST NOT call the missing
  method. A partial/legacy source must be upgraded or adapted, not degraded.

Test the specific methods (`typeof source.setWithAckOptions === "function"`,
`typeof source.invokeWithOptions === "function"`, etc.) rather than source kind
or a single representative method. A source MAY be fully Extension-1-capable for
inputs but a plain local target for commands, or vice versa; the two delegation
kinds are classified independently.

> **Method-name auto-detection can misfire in *both* directions — a positive
> capability signal is required, and an explicit override MUST be available.** The
> method-name classification above is necessary but **not sufficient**, because
> core does NOT reserve `set` / `setWithAck` / `invoke` / … as input/command names
> (see [SPEC.md § Command Descriptor](SPEC.md#command-descriptor)). Two distinct
> misfires follow from names alone:
>
> - **Partial false positive:** a legal local source with an application command
>   literally named `invoke` (but no `invokeWithOptions`) looks like a *partial*
>   Extension 1 surface → would be rejected.
> - **Full false positive (more dangerous):** a legal local source that happens to
>   expose application methods named exactly `set` + `setWithAck` +
>   `setWithAckOptions` (or `invoke` + `invokeWithOptions`) looks like a *full*
>   Extension 1 surface → would be **silently misrouted**: the shell would call
>   them as Extension 1 dispatchers instead of as the plain application methods
>   they are. Unlike the partial case this is not a construction error, so it is
>   the worse failure.
>
> To close the full false positive, **`auto` classification MUST require a
> positive Extension-1 capability signal, not method names alone.** A source
> counts as Extension-1-capable under `auto` only if it both exposes the full
> required method subset **and** advertises the standard marker at
> `source[Symbol.for("wc-bindable.extension1")]`. If the full method set is
> present but the marker is **absent**, the source is **ambiguous**: the shell
> MUST NOT silently route it as Extension 1, and MUST instead reject at
> construction unless an explicit override (below) disambiguates it. Method-name
> presence without the marker is therefore never sufficient on its own.
>
> **The marker is a versioned discovery object, not a bare boolean** — for the
> same fail-closed reason the tier-claim object is versioned. A bare `true` cannot
> tell a future Composite implementation whether the source speaks the Extension 1
> surface *that implementation* expects, so a stale source returning `true`
> forever would be the exact version-ambiguity the tier claim avoids. The marker
> value MUST therefore be an open-shape object:
>
> ```typescript
> { protocol: "wc-bindable.extension1", version: 1, inputs: boolean, commands: boolean }
> ```
>
> where `inputs` / `commands` state which delegation kinds the source supports
> (so an input-only or command-only Extension 1 source is expressible). A
> consumer MUST read `protocol` / `version` first and **fail closed on an
> unsupported `version` or an unrecognized `protocol`** — treating the source as
> *not* marker-capable (hence ambiguous under `auto`, resolvable only by an
> explicit override), exactly as § Tier claim does for its own object. Unknown
> fields are ignored (open shape). `version` here too MUST be an **integer `>=
> 1`**.
>
> **Read rules (same discipline as the tier claim).** To keep capability
> detection from diverging across wrapped / proxied / prototype-inheriting
> sources, the marker MUST obey the same access rules as the tier-claim object
> (§ Tier claim → Ownership and mutability): it MUST resolve as an **own**
> property or own getter of the source (not inherited only via the prototype
> chain); reading it MUST be stable for the source's lifetime and the consumer
> MUST treat the returned object as **read-only**; and if the read **throws**, the
> marker is treated as **unavailable** → the source is not marker-capable (hence
> ambiguous under `auto`, resolvable only by an explicit override), never routed
> as Extension 1 on a throwing read.
>
> **Composite-to-composite interop.** A composed shell that claims **T3** and is
> intended to be usable as a source for another composite SHOULD also expose the
> standard Extension-1 marker at `Symbol.for("wc-bindable.extension1")`, with
> `inputs` / `commands` reflecting the delegation kinds it actually routes on its
> own Extension-1 surface. If a shell exposes both the composite tier claim and
> the Extension-1 marker, they MUST agree: a shell with `extension1: true` on the
> tier claim MUST NOT advertise a contradictory marker, and a shell with
> `extension1: false` MUST NOT present itself as Extension-1-capable via the
> marker.
>
> **Legacy shorthand:** a bare boolean `source[Symbol.for("wc-bindable.extension1")]
> === true` MAY be accepted as a v1 shorthand for
> `{ protocol: "wc-bindable.extension1", version: 1, inputs: true, commands: true }`.
> Implementations SHOULD emit the object form; the boolean is only for sources
> written against an early draft.
>
> **Standardization status — auto is a convenience, override is the interop
> guarantee.** This marker is introduced by *this* draft; the authoritative
> `SPEC-extensions.md` does not define it today, so a third-party source that
> implements only `SPEC-extensions.md` (including current / legacy
> `@wc-bindable/remote` proxies) does **not** advertise it and is *intentionally
> ambiguous under `auto`*. Two consequences the profile makes explicit:
>
> - **`auto`-mode Extension-1 detection is an implementation convenience, not the
>   interop contract.** The guaranteed-interoperable way to delegate to an
>   Extension-1 source in COMPOSITE v1 is the explicit `extension1` override
>   (below); `auto` only *upgrades* that to zero-config when a source opts in via
>   the marker. A composite implementation MUST require the explicit override for
>   a markerless source and MUST NOT special-case "looks like a `RemoteCoreProxy`"
>   by shape (no silent misrouting).
> - **The marker is proposed for promotion into a future `SPEC-extensions.md`
>   revision** so that auto-detection becomes a cross-spec property rather than a
>   COMPOSITE-only one. Until then it lives here. Its `Symbol.for(...)` value is
>   **forgeable** by any object in the realm and carries no authenticity
>   guarantee — the same trust caveat as the tier claim (§ Tier claim → Security
>   note): a shell MAY read it to *route*, but MUST NOT treat it as authorization.
>
> **Profile requirement (interop):** independently of detection, an implementation
> MUST provide a way for the application to override classification and pin how a
> source is treated, so a legal local source is never permanently locked out by a
> name collision (partial or full) and an unmarked-but-genuine Extension 1 source
> can still be opted in. The three override modes are:
>
> - **auto** (default) — apply the marker-gated full / none / partial / ambiguous
>   classification above.
> - **local** — treat the source as an ordinary local target; Extension-1-looking
>   method names (and any marker) are ignored, members are delegated via the
>   plain-local path (assignment / method call). No partial-surface or
>   ambiguous-surface rejection.
> - **extension1** — assert the source is Extension-1-capable; the shell delegates
>   to its Extension 1 methods and MUST reject at construction if the full required
>   method subset is absent. (This is also how a genuine Extension 1 source that
>   does not advertise the marker is opted in.)
>
> **The override MUST be expressible per delegation kind**, because input-kind and
> command-kind capability are classified independently (above): the same source
> may need `extension1` for its inputs but `local` for its commands (e.g. its
> only `invoke`-named member is an application command). An override that could
> only be set for the whole source would be unable to express that case and would
> contradict the independent-classification rule. A whole-source value is a
> permitted **shorthand** for "apply this mode to both kinds", and a per-kind
> value MUST take precedence over the shorthand.
>
> **Candidate API (reference implementation, non-normative):** the
> `@wc-bindable/composite` reference implementation may surface this as a
> `sourceMode` option shaped like
> `"auto" | "local" | "extension1" | { inputs?: Mode; commands?: Mode }`. The
> *name* and *shape* are implementation choices; only the override capability and
> its per-delegation-kind granularity are profile requirements.
>
> Auto-detection is a convenience; the explicit modes are the disambiguator when
> a local source's member names collide with the Extension 1 method names.

The profile does not require a shell to expose every source input. It may expose
an allowlist.

### 9. Commands

> **Execution-tier rule.** As with inputs, a T1 shell MAY declare `commands` as
> pure metadata with no invocation delegation. The delegation MUSTs below bind a
> shell only once it claims an execution tier — the method-call rule applies to
> **T2**, the `invoke` rule applies to **T3**.

**T2 (local facade).** If a T2 shell exposes a command as a callable member,
invoking it MUST delegate to the mapped source command. The default delegation
is method call:

```javascript
await shell["ai.run"](...args);
// delegates to
await aiSource.run(...args);
```

**T3 (Extension-1).** If a T3 shell exposes a command, its `invoke()` and
`invokeWithOptions()` MUST resolve the composed command name to the mapped source
command. When a shell claims both T2 and T3, both surfaces MUST resolve the same
composed name to the same source command. The full-Extension-1-contract note in
§ 8 applies identically here (signatures, `AckOptions` lifecycle, error codes —
only source routing is defined below).

As with inputs, the delegation target depends on the source's capability,
classified by the **command-kind** three-way rule in § 8 (full →
`invoke` + `invokeWithOptions`; none → plain local; partial → reject in **auto**
mode), tested independently from the source's input-kind capability and subject
to the same override, which is settable per delegation kind (§ 8):

- **Extension-1-capable source** (the source exposes the full command-kind
  Extension 1 subset — `invoke` **and** `invokeWithOptions` — e.g. a
  `RemoteCoreProxy`): the shell MUST delegate to it — `shell.invoke(N, ...args)`
  → `source.invoke(M, ...args)`, and `shell.invokeWithOptions(N, args, opts)` →
  `source.invokeWithOptions(M, args, opts)` (forwarding the same `AckOptions`) —
  so the source's remote return / rejection, timeout/abort handling, and `args`
  wire serialization propagate end-to-end. **Subject to the default-timeout
  policy in § 8:** under the Normalize policy a no-default-timeout
  `shell.invoke(N, …)` is delegated as
  `source.invokeWithOptions(M, args, { ...opts, timeoutMs: shellDefault })`
  (caller's `signal` preserved) rather than the bare `source.invoke(M, …)` shown
  here.
- **Plain local source** (no `invoke`): the shell wraps the method call —
  `invoke()` calls `source[M](...args)`, resolves with the return value
  (awaiting it if thenable), or rejects with the thrown error / rejection, while
  honoring the inherited `AckOptions`. A pre-aborted signal and invalid options
  are checked before the call. Unlike the synchronous-setter case in § 8,
  `timeoutMs` **is** meaningful here when the method returns a thenable: the
  shell races the awaited thenable against the timeout and rejects with
  `WC_BINDABLE_TIMEOUT` if it elapses first (the source method keeps running —
  the timeout is local, no cancellation is sent, exactly as in Extension 1). For
  a method that returns synchronously (no thenable) there is nothing to await, so
  `timeoutMs` does not apply.

If the source declaration marks the command with `async: true`, the shell MUST
preserve that hint in the synthesized command descriptor (the hint is read
straight from the source descriptor; the shell never infers asynchrony — see the
synthesized-declaration example below).

In the first profile version a composed command MUST map to exactly one source
command — command fan-out is out of scope. Fan-out and aggregation can be added
later as implementation-specific behavior or a separate profile.

### 10. Lifecycle and teardown

On final teardown (dispose, or whatever terminal lifecycle event the
implementation defines), a composed shell MUST remove every source event
listener it installed — leaking source listeners is the failure this section
exists to prevent. Whether the shell *also* detaches listeners on a non-terminal
disconnect (e.g. a DOM `disconnectedCallback` that may be followed by
reconnection) is an implementation choice governed by its lifecycle model: a
shell with a DOM disconnect/reconnect lifecycle MAY detach on disconnect and
reinstall on reconnect, while a headless shell with no such lifecycle simply
keeps its listeners for its whole life. Both are conformant; the MUST is about
not leaking listeners past the shell's end of life, not about forcing a
disconnect-time detach.

The shell's **source-subscription lifecycle is owned by the shell itself, not by
downstream consumers binding to the shell**. A consumer's `bind(shell, …)` /
unbind cycle adds or removes listeners on the shell only; it MUST NOT be the
event that decides whether the shell installs or removes its own source
listeners, except insofar as the shell instance itself is created, connected,
disconnected, or disposed as part of that broader application lifecycle.

**`dispose()` obligation by tier.** A **T3** shell MUST expose `dispose()` —
it is part of the mandatory Extension 1 consumer-side surface (see
[SPEC-extensions.md § Methods](SPEC-extensions.md#methods)), so a T3 shell's
`dispose()` MUST follow the Extension 1 contract: idempotent, and after it,
`set()` throws while `setWithAck` / `setWithAckOptions` / `invoke` /
`invokeWithOptions` reject. A **T1 or T2** shell is not required to expose
`dispose()` at all; if it chooses to, that API SHOULD be idempotent and SHOULD
make subsequent input / command delegation fail predictably. Either way, the
final-teardown listener-removal MUST above holds regardless of whether
`dispose()` is the terminal trigger or a DOM/lifecycle event is.

**Source ownership — composition does not own its sources by default.** A shell's
teardown affects only what the shell itself created. On `dispose()` (or final
teardown) a composed shell MUST:

- remove every source event listener it installed (the rule above); and
- reject every **shell-owned** pending call — a T3 shell's in-flight
  `setWithAck` / `setWithAckOptions` / `invoke` / `invokeWithOptions` promises
  reject with `WC_BINDABLE_DISPOSED` per the Extension 1 disposed contract.

**Late source settlements after dispose are dropped.** When a T3 shell delegated
a call to an Extension-1-capable source (`source.setWithAck()` /
`source.invoke()`), that call is *also* source-owned: the source has its own
pending entry. After the shell's `dispose()` has already rejected the shell-side
promise with `WC_BINDABLE_DISPOSED`, a later `return` / `throw` settlement
arriving from the source (e.g. a remote ack landing after teardown) MUST NOT
re-settle the shell-side promise — a JS promise is single-settlement anyway, but
the shell MUST also not surface the late result through any other channel. It
SHOULD drop the late settlement, optionally logging it at debug/warn level. This
is the same late-envelope-drop posture `@wc-bindable/remote` uses for results
that arrive for an already-removed pending id. The shell does not, and cannot,
cancel the source-side call (no wire cancellation is sent); the source continues
to completion and its result is simply discarded by the shell.

A composed shell MUST NOT dispose its source targets — it MUST NOT call
`source.dispose()` (or any source-terminal API) — unless the application
**explicitly** configures cascading ownership. Sources frequently outlive a
single shell, are shared between shells, or are nested inside another composite;
disposing them implicitly would tear down state another consumer still depends
on. The safe default is "the shell borrows its sources." An implementation MAY
offer an opt-in (e.g. an `ownsSources` / `disposeSources` flag) that cascades
`dispose()` to sources, but it MUST be off by default and MUST be documented.
When such cascading is enabled, the shell SHOULD dispose sources after detaching
its own listeners, and SHOULD tolerate a source `dispose()` that throws (best-
effort, continue disposing the rest) — the same teardown-resilience posture core
uses.

For DOM custom elements, `disconnectedCallback()` MAY detach source listeners
that were installed by `connectedCallback()` (consistent with the
implementation-choice framing above), and reconnection MAY reinstall them. A
shell that takes this option is then subject to the "updates missed while
disconnected" rule below.

**Updates missed while disconnected.** If a shell detaches its source listeners
on disconnect, a source value MAY change before reconnect, leaving the shell's
last-dispatched value stale. The shell MUST make its choice observable rather
than leaving it implementation-defined; it MUST do one of:

- **Re-sync on reconnect (recommended).** When source listeners are reinstalled,
  re-read each exposed source property's current value (gated by the § 5 `in`
  check) and dispatch a shell event for every known/present exposed property.
  Two equally-conformant dispatch policies are allowed; the shell MUST pick one
  and not leave it implementation-defined:
  - **Unconditional** — dispatch a shell event for every known/present exposed
    property. Core permits repeated events with no batching or dedup (see
    [SPEC.md § Repeated Events for the Same
    Property](SPEC.md#repeated-events-for-the-same-property)), and consumers
    that need dedup do it themselves. This is the simplest correct policy.
  - **Changed-only** — suppress a property whose re-read value has not changed
    since the shell's last-dispatched value. If the shell does this, the
    comparison MUST be `Object.is` (NOT `===`, which conflates `+0`/`-0` and
    mishandles `NaN`, and NOT deep equality, which is undefined over the Layer-1
    "any JS value" model and would suppress mutated-in-place objects). `Object.is`
    is the only comparison that is total over arbitrary JS values and cheap to
    implement.

  Either way a consumer that stayed bound across a disconnect/reconnect cycle
  converges to the source's current state — the least surprising behavior, and
  one both DOM and headless targets can honor. A source whose value arrives
  asynchronously (a remote-proxy source) re-syncs through its own mechanism; the
  shell forwards those values as they arrive.
- **Document silence explicitly.** If the shell instead chooses not to re-sync,
  it MUST document that "updates that occur while the shell is disconnected are
  not observed, and the next observed value is whatever the next source event
  carries after reconnect." A consumer can then opt into re-binding on reconnect
  itself.

A shell that never detaches its listeners (e.g. a headless target with no DOM
lifecycle) has no gap and is unaffected by this rule.

**Declaring the chosen policy (machine-readable).** Because the three policies
are observably different — and `silent` in particular expects "nothing happens",
which is hard to verify from runtime behavior alone — a conformance runner or
devtools needs to know which one a shell implements without reading prose. This
is a **conditional MUST**: a shell that **detaches and reinstalls listeners
across a disconnect/reconnect cycle** (i.e. one to which this section's gap
applies) MUST expose its policy as a `reconnectResync: "unconditional" |
"changed-only" | "silent"` field on the standard tier-claim object
(`Symbol.for("wc-bindable.composite.tiers")`, § Tier claim must be discoverable
out-of-band). A shell that **never detaches** its listeners (e.g. a headless
target with no DOM lifecycle, which has no gap) MAY omit the field — there is no
reconnect re-sync to describe. The package-level conformance document MAY restate
the policy but does not substitute for the per-instance field on a shell that has
the gap.

Adding a new `reconnectResync` enum value is a **profile-version** change, not a
same-version extension point. A consumer that somehow encounters an unknown
value on an otherwise-supported claim MUST treat the field as unavailable for
behavioral purposes (effectively as if it were omitted) and MAY surface it only
as a diagnostic.

### 11. Dynamic reconfiguration

The synthesized declaration MUST be immutable for the lifetime of a given shell
target: once any consumer can observe it via `getWcBindableDeclaration()` or
`bind()`, neither the declaration object nor the set of exposed property / input
/ command names may change on that same target.

This is a MUST rather than a SHOULD because core's `bind()` reads the
declaration **once** at bind time and there is no declaration-change
notification channel: an existing consumer that already subscribed would never
learn that the observed surface changed, so different consumers of the same
target would diverge on what they observe. Immutability is the only way to keep
the single-read discovery model sound.

If the source set or expose map changes, the implementation MUST create a new
shell target (or a new isolated constructor) and let consumers re-bind to it,
rather than mutating the declaration of an existing target in place.

This keeps discovery simple: consumers that already called
`getWcBindableDeclaration()` or `bind()` do not need a second protocol for
declaration-change notifications.

### 12. Delegation and error propagation

Composition introduces failure modes that core's single-target model does not
have, and a profile that leaves them undefined will fragment across
implementations. The profile MUST specify the following boundaries. Where a
behavior is tier-specific it is marked.

- **Source getter throws (T1+).** A composed shell differs from core here, and
  the difference is forced by fan-out: one shell listener may drive several
  composed properties off a single shared source event (§ 6). Core's adapter
  binds one getter per listener and can let the throw escape the listener; a
  composed shell cannot, because an escaping throw would abort the listener and
  suppress the **sibling** properties mapped to the same source event. The shell
  therefore MUST **isolate getter failures per composed property**:

  1. catch each property's getter throw individually;
  2. **report** it — never silently swallow it (this preserves core's guarantee;
     see [SPEC.md § Getter Errors](SPEC.md#getter-errors)). The report mechanism
     is resolved in this priority order so the rule is honorable in every
     runtime:
     1. if a global `reportError` is available (browsers, workers, recent
        Node), call `reportError(error)`;
     2. otherwise re-throw the error from a deferred job (e.g.
        `queueMicrotask(() => { throw error; })` or
        `setTimeout(() => { throw error; }, 0)`) so it surfaces as an
        uncaught error without aborting the current fan-out loop;
     3. if the implementation has its own structured logger, it MUST **also**
        (or, in a runtime where neither of the above can surface an uncaught
        error, at minimum) log the error at error level.

     **Normative requirement vs. timing.** The hard requirement is "no silent
     catch": at least one of these paths MUST make the error observable, and the
     report MUST NOT abort the synchronous fan-out loop (siblings still dispatch).
     The *exact* deferral — microtask vs. macrotask — is **non-normative**: a
     conformance test asserts only that the error becomes observable *after* the
     synchronous fan-out for that source event completes, not which queue carried
     it. A bare `catch {}` is non-conformant. If the
     chosen report mechanism *itself* throws (e.g. a hostile or misconfigured
     `reportError`), the shell MUST treat that secondary error as best-effort: it
     SHOULD fall through to the next mechanism in the list, and MUST NOT let the
     secondary throw abort the fan-out loop or suppress the sibling properties
     (swallowing only the *secondary* error is acceptable — the primary getter
     error has already been routed, or will be by the fallback);
  3. dispatch **no** shell event for the failed property on that occurrence; and
  4. **continue** evaluating the remaining mapped properties and dispatch their
     shell events normally.

  The shell MUST NOT swallow the error (catch it with no report) and MUST NOT let
  one property's getter failure suppress its siblings. The observable outcome —
  "the error reaches host error reporting, not the `dispatchEvent()` caller" —
  matches core; only the mechanism differs (an explicit `reportError()` instead
  of an uncaught throw from the listener), which is what makes the per-property
  isolation in § 6 implementable.

  > **Reference-implementation choice.** The re-throw fallback (step 2) surfaces
  > an *uncaught* error, which in Node can terminate the process under the
  > default `uncaughtException` policy — too aggressive for a single getter bug
  > in one composed property. The `@wc-bindable/composite` reference
  > implementation therefore prefers `reportError` where present and otherwise
  > routes to its **injected logger at error level** (the same logger surface
  > `@wc-bindable/remote` uses), reserving the throw-on-a-task path for runtimes
  > that expose neither. Implementations SHOULD document which path they take so
  > operators know where these errors land.

- **Source listener install failure / source missing at shell setup (T1+).** If a
  declared source is absent, or installing a source listener throws, the shell
  is in the same position as core's install-time throw: it MUST tear down every
  source listener it already installed for that shell before propagating the
  error, so no partial listener set leaks. A composed shell MUST NOT expose a
  property whose source cannot be resolved at construction time — resolve the
  full source set up front (see § 5 and § 11).

- **Input assignment throws (T2).** When local property-assignment delegation
  (`shell[N] = v` → `source[M] = v`) triggers a throwing source setter, the
  throw MUST propagate synchronously to the assigning caller, unaltered. The
  shell MUST NOT swallow it or defer it.

- **Command invocation throws / rejects (T2).** A local method-call delegation
  (`shell[N](...args)` → `source[M](...args)`) MUST preserve the source
  method's completion shape: a synchronous throw propagates synchronously; a
  returned promise's rejection propagates as a rejection. The shell MUST NOT
  flatten one into the other.

- **Extension-1 surfaces (T3).** When the shell exposes the Extension 1 surface
  (`set` / `setWithAck` / `setWithAckOptions` / `invoke` / `invokeWithOptions`),
  the failure mapping follows Extension 1, not the local-facade rules above:
  `set()` is fire-and-forget, and the acknowledged calls' failures surface as
  promise rejections carrying the Extension-1 error envelope with the
  appropriate `error.code` (`WC_BINDABLE_TIMEOUT` on `timeoutMs` elapse,
  `WC_BINDABLE_ABORTED` on signal abort, `WC_BINDABLE_DISPOSED` after
  `dispose()`, the producer's serialized error on an application throw, etc. —
  on abort the rejection value still carries the caller's `signal.reason` when
  present, else an `AbortError`, per § 8 / § 9 and SPEC-extensions.md).
  A T3 shell MUST NOT mix the synchronous-throw semantics of the local facade
  into its Extension-1 surface for the same underlying source failure.

  **This holds even when the underlying source is a plain local target.** The T3
  surface is consumer-facing Extension 1, so its error contract MUST NOT leak
  whether the source happened to be local or Extension-1-capable. Concretely, for
  a T3 call wrapping a plain local source:

  - a **non-`Error` throw** (`throw "oops"`, `throw 42`) MUST be canonicalized to
    an `Error` instance before rejecting, **using the same mapping Extension 1
    pins** — see [SPEC-extensions.md § Canonical mapping for non-Error
    throws](SPEC-extensions.md#canonical-mapping-for-non-error-throws): the
    resulting `Error` has `name === "NonErrorThrow"` (the literal is normative so
    consumers can pattern-match it) and a safely-stringified `message`. Reusing
    that mapping rather than an ad-hoc `new Error(String(thrown))` is what keeps
    two implementations from diverging on the surfaced shape (one `Error("oops")`,
    one `NonErrorThrow`);
  - an **application error** raised by the source carries no protocol `error.code`
    by default; the shell SHOULD surface it under the same code Extension 1 uses
    for a producer-thrown application error (`WC_BINDABLE_REMOTE_THROW`) or leave
    `code` unset, but MUST NOT invent a fake protocol code for it;
  - a **shell-synthesized protocol error** (pre-aborted signal, invalid options,
    disposed, timeout on an awaited thenable) MUST carry its registered
    `WC_BINDABLE_*` code, exactly as the Extension-1-capable-source path does.

  In short: T3 normalizes local-source failures up to the Extension 1 contract.
  By contrast, **T2** (the local facade) deliberately does NOT normalize — its
  `shell[N] = v` / `shell[N](...)` surface re-raises the source's raw synchronous
  throw unaltered (the two bullets above), because a local-facade caller is
  talking to a plain JS member and expects plain JS throw semantics.

  > **T3 pending-call lifecycle.** A T3 acknowledged call MUST be backed by a
  > **shell-owned pending entry** so the shell can apply `dispose()` as its own
  > terminal. **Which component owns `abort` / `timeout` depends on the source
  > kind, and the two MUST NOT both act on the same call** — that double-handling
  > is the contradiction this rule exists to resolve. The split is:
  >
  > - **Extension-1-capable source.** The shell forwards the caller's `AckOptions`
  >   (the same `signal` / `timeoutMs`) to `source.setWithAckOptions(M, …)` /
  >   `source.invokeWithOptions(M, …)` (per § 8 / § 9), so **`abort` and `timeout`
  >   are owned by the source's** Extension 1 layer: the source rejects its own
  >   pending with `AbortError` / `WC_BINDABLE_TIMEOUT` and sends no wire
  >   cancellation (Extension 1's local-abort semantics), and the shell-owned entry
  >   simply **mirrors** that settlement. The shell MUST NOT *also* install its own
  >   abort/timeout for the same call (no double handling), and MUST NOT forward a
  >   pre-aborted signal as a call it then has to unwind — a pre-aborted signal
  >   rejects before delegating. The shell adds exactly one terminal of its own:
  >   `dispose()`.
  > - **Plain local source.** There is no source-side lifecycle to forward to, so
  >   the **shell owns `abort` / `timeout` locally** per § 8 / § 9 (pre-aborted
  >   signal and invalid options checked before the call; `timeoutMs` applies only
  >   to an awaited thenable, never to a synchronous setter). The source call, once
  >   started, runs to completion; the shell drops its late settlement if the
  >   shell-owned entry already settled.
  >
  > State machine (each terminal single-settlement, first-wins):
  > `Pending → Settled` (the owning side's `return`/`throw` arrives first)
  > `| Disposed` (shell `dispose()`) `| Aborted` `| TimedOut`.
  >
  > - On `dispose()`, the shell MUST reject all shell-owned pending entries **in
  >   caller order** with `WC_BINDABLE_DISPOSED` (mirroring Extension 1's
  >   caller-order pending drain), MUST drop any later source settlement for those
  >   entries (§ 10 late-settlement rule), and MUST NOT dispose or cancel the
  >   source. `dispose()` wins even over a source settlement that is already in
  >   flight.
  > - For an Extension-1-capable source, `Aborted` / `TimedOut` are reached by
  >   mirroring the source's rejection (the source owns them); for a plain local
  >   source they are reached by the shell's own local abort/timeout. Either way
  >   the entry is single-settlement and the losers are no-ops.
  > - **Same-turn race — the observable trigger is defined, not left to microtask
  >   ordering.** "First wins" is made deterministic by pinning *when* a
  >   shell-owned entry becomes settled:
  >   - `dispose()` settles entries **synchronously at the call site**: invoking
  >     `dispose()` MUST, before it returns, mark every not-yet-settled shell-owned
  >     entry as `Disposed` and reject it with `WC_BINDABLE_DISPOSED`. After that
  >     synchronous mark, **any source-settlement (or abort/timeout) callback that
  >     later runs for one of those entries MUST be a no-op** (the § 10
  >     late-settlement drop). This holds even when the source promise had already
  >     *resolved* and the shell's `.then` continuation was still queued on the
  >     microtask queue when `dispose()` was called: the queued continuation finds
  >     the entry already `Disposed` and drops. So a resolved-but-not-yet-delivered
  >     source result never overtakes a `dispose()` that has already been called.
  >   - Conversely, an entry whose mirroring/local settlement callback has
  >     **already run** (the entry is `Settled` / `Aborted` / `TimedOut`) before
  >     `dispose()` is called is terminal; `dispose()` does not re-settle it.
  >   - The rule reduces to: compare *which executed first* — the synchronous
  >     `dispose()` mark, or the settlement callback. Microtask vs. macrotask
  >     ordering between source layers never changes the outcome because
  >     `dispose()`'s mark is synchronous and one-shot.

The first profile version does not aggregate errors across sources, because it
does not support fan-out (see § 9). Each delegation resolves to exactly one
source member, so each failure has exactly one origin.

## Candidate package: `@wc-bindable/composite`

The reference implementation can experiment with concrete APIs while keeping
the protocol profile above small.

### JavaScript API

```typescript
import { createCompositeTarget } from "@wc-bindable/composite";

const shell = createCompositeTarget({
  sources: {
    s3: s3Uploader,
    ai: aiAgent,
  },
  expose: {
    properties: {
      "s3.progress": { source: "s3", name: "progress" },
      "s3.url": { source: "s3", name: "url" },
      "ai.loading": { source: "ai", name: "loading" },
      "ai.answer": { source: "ai", name: "answer" },
    },
    inputs: {
      "s3.file": { source: "s3", name: "file" },
      "ai.prompt": { source: "ai", name: "prompt" },
    },
    commands: {
      "s3.upload": { source: "s3", name: "upload" },
      "ai.run": { source: "ai", name: "run" },
    },
  },
});
```

Default auto-expose can be layered on top:

```typescript
const shell = createCompositeTarget({
  sources: { s3: s3Uploader, ai: aiAgent },
  expose: "all-prefixed",
});
```

### Declarative custom element API

A declarative API is useful for HTML-first systems such as `@wcstack/state`, but
it should live in the composite package rather than inside a state library.

```html
<my-ai-workbench data-wc-composite-definition>
  <template shadowrootmode="open">
    <s3-uploader data-wc-source="s3"></s3-uploader>
    <ai-agent data-wc-source="ai"></ai-agent>
  </template>
</my-ai-workbench>

<my-ai-workbench></my-ai-workbench>
```

The definition element generates a custom element class whose instances expose a
composed `static wcBindable` declaration.

**Source declaration availability is a precondition, not a best-effort step.**
The synthesized declaration is derived by reading each source element's
`constructor.wcBindable`. That read is only meaningful once each source custom
element has been **defined** (registered with `customElements.define`) and its
constructor carries the static `wcBindable`. Because custom-element registration
can happen lazily or asynchronously (a source tag may be undefined or
not-yet-upgraded when the definition element is processed), a declarative
implementation MUST resolve this before exposing a declaration. It MUST do one
of the following:

- **Require sources to be defined first** — treat an undefined source tag at
  definition time as a construction error, so the generated class is produced
  only when every `constructor.wcBindable` is already readable; or
- **Adopt an async registration model** — await `customElements.whenDefined()`
  for every source tag, and only then generate the class and expose its
  `static wcBindable`.

Either way, the synthesized declaration MUST be fully determined **before** any
consumer can call `getWcBindableDeclaration()` or `bind()` on a shell instance
(this is the same finalize-before-observe requirement as § 11). A shell instance
MUST NOT be observable with an incomplete or provisional declaration that later
gains source members once their definitions arrive.

An explicit expose list can reduce the public surface:

```html
<my-ai-workbench data-wc-composite-definition>
  <template shadowrootmode="open">
    <s3-uploader
      data-wc-source="s3"
      data-wc-expose="properties: progress, url; inputs: file; commands: upload">
    </s3-uploader>

    <ai-agent
      data-wc-source="ai"
      data-wc-expose="properties: loading, answer; inputs: prompt; commands: run">
    </ai-agent>
  </template>
</my-ai-workbench>
```

This would synthesize a declaration shaped like:

```typescript
{
  protocol: "wc-bindable",
  version: 1,
  properties: [
    { name: "s3.progress", event: "@wc-bindable/composite:s3.progress" },
    { name: "s3.url", event: "@wc-bindable/composite:s3.url" },
    { name: "ai.loading", event: "@wc-bindable/composite:ai.loading" },
    { name: "ai.answer", event: "@wc-bindable/composite:ai.answer" },
  ],
  inputs: [
    { name: "s3.file" },
    { name: "ai.prompt" },
  ],
  commands: [
    { name: "s3.upload", async: true },
    { name: "ai.run", async: true },
  ],
}
```

The `async: true` hints here are **preserved from each source command
descriptor**, not inferred by the composition implementation. Per § 9, the shell
copies the source's `async` flag through to the synthesized descriptor; if a
source command does not declare `async`, the composed descriptor omits it too.
The shell never guesses asynchrony.

### Use from `@wcstack/state`

`@wcstack/state` does not need special composition support if the composed shell
is an ordinary wc-bindable target.

```html
<my-ai-workbench
  data-wcs="
    s3.file: upload.file;
    ai.prompt: prompt;
    command.s3.upload: $command.upload;
    command.ai.run: $command.run
  ">
</my-ai-workbench>
```

The state library sees one custom element. The composition package owns the
source discovery, event rewriting, and delegation.

## Remote interop

Two remote patterns should work:

1. A composite shell can include remote proxies as sources.
2. A composite shell can itself be exposed through `@wc-bindable/remote`.

The first pattern requires the shell to treat each remote proxy like any other
source target: bind to its synthetic local property events and read its cached
properties for initial sync. Note the marker-migration caveat from § 8: a
current/legacy `RemoteCoreProxy` source does not yet advertise
`Symbol.for("wc-bindable.extension1")`, so to delegate **inputs / commands** to
it under a T3 shell the composite must pin that source's mode to `extension1`
explicitly — under `auto` a markerless remote proxy is ambiguous and rejected.
(Pure observation of a remote-proxy source needs no override; only Extension-1
delegation does.)

The second pattern requires the synthesized declaration to satisfy the same
rules as any remote producer declaration. In particular, remote-compatible
composite implementations must reject reserved names and must ensure every
ordinary wire payload is serializable by the remote profile when crossing the
wire.

**The wire declaration MUST only advertise an execution surface the remote layer
can actually drive.** This is a hard rule, not a caveat, because Extension 1
gives `inputs` / `commands` in a *remote producer's* declaration a definite
meaning: the consumer-side proxy exposes `set` / `invoke` for exactly those
names and a tool renders them as writable / invokable. `@wc-bindable/remote`'s
`RemoteShellProxy` drives the producer only through the **local facade (T2)** —
an inbound `set` becomes a property assignment (`core[name] = value`) and an
inbound `cmd` becomes a method call (`core[name](...)`). A composed shell that
does **not** implement T2 has no such assignable property / callable method, so
an inbound `set` would write a dead property and an inbound `cmd` would fail with
"method not found". Advertising `inputs` / `commands` that silently misbehave is
the exact interop break this rule forbids.

Therefore, when a composed shell is exposed through `@wc-bindable/remote`:

- A shell that **implements T2** MAY include in its wire declaration the
  `inputs` / `commands` it actually delegates; those are remote-writable /
  invokable as usual.
- A shell that does **not** implement T2 (e.g. a T1 observation-only shell, or a
  T3-only shell whose Extension-1 methods `RemoteShellProxy` never calls) MUST be
  exposed with an **observation-only wire declaration** — a
  `constructor.wcBindable` that keeps `properties` only and omits `inputs` /
  `commands`. The shell remains fully remote-observable — properties sync and
  update normally — and the consumer never renders a set / invoke affordance that
  cannot work.

**Responsibility boundary — the composite implementation owns the projection,
not `@wc-bindable/remote`.** This is a hard constraint because of *where* the
remote layer reads the declaration: `RemoteShellProxy` reads
`producerTarget.constructor.wcBindable` **verbatim** and derives its allowed
`set` / `cmd` names from that object (see
[packages/remote/src/RemoteShellProxy.ts](packages/remote/src/RemoteShellProxy.ts));
it has **no declaration-override / projection parameter**. Consequently:

- Passing a T1 shell that declares `inputs` / `commands` for local tooling
  *directly* to `new RemoteShellProxy(shell, transport)` does **NOT** produce an
  observation-only exposure — the remote layer would advertise those names and
  hit the dead-write / method-not-found failure above. This is explicitly
  non-conformant.
- A composite implementation that exposes a non-T2 shell remotely MUST therefore
  hand `RemoteShellProxy` a **distinct remote-facing target whose
  `constructor.wcBindable` omits `inputs` / `commands`** — a generated isolated
  constructor / wrapper, the same isolation shape § 1 already mandates for
  per-instance declarations and that `createRemoteCoreProxy` uses on the consumer
  side. The original T1 shell keeps its full `constructor.wcBindable` (inputs /
  commands intact) for **local** tooling / docs / codegen; only the
  remote-facing projection drops them. The two are different objects, so the T1
  local-metadata goal and the observation-only wire goal do not conflict.
- Mutating the original shell's `constructor.wcBindable` to delete `inputs` /
  `commands` is NOT an acceptable way to achieve this — it would destroy the
  local tooling metadata that is T1's entire reason for declaring them, and would
  violate the § 11 declaration-immutability rule for any consumer already bound
  to the shell.

(If a future `@wc-bindable/remote` revision adds a declaration-projection API or
an "observation-only capability" advertisement, an implementation MAY use that
instead of a wrapper; until then, the remote-facing isolated constructor is the
interoperable mechanism.)

**A *reachable* remote-facing projection is itself a composed shell and MUST
carry its own tier claim.** "Reachable" means a consumer can inspect or `bind()`
the projection target directly (the common case, since it is what the transport
exposes); a projection kept purely as an internal transport artifact that is
never handed to tooling is the sole exception (spelled out at the end of this
list). A reachable projection MUST expose the standard
`Symbol.for("wc-bindable.composite.tiers")` surface (§ Tier claim must be
discoverable out-of-band) describing **the projection's own** surface, not the
original shell's:

- `localFacade` / `extension1` MUST reflect what is actually drivable **on the
  projection**. An observation-only projection (the non-T2 case above) reports
  `localFacade: false` and `extension1: false` — it exposes no `inputs` /
  `commands`, so a tool inspecting it renders no set/invoke affordance, matching
  the wire declaration it carries. A projection that *does* keep a drivable T2
  facade reports `localFacade: true`.
- `remoteCompatible` MUST be `true` on the projection (it exists precisely to be
  exposed through `@wc-bindable/remote`).

The original shell keeps its own, possibly different, tier claim (e.g. a T1 shell
with declaration-only `inputs` for local tooling). The two objects describe two
different surfaces — the local shell vs. the remote-facing projection — and a
tool MUST read the claim from whichever object it actually holds. (An
implementation that treats the projection purely as an internal transport
artifact never exposed to tooling MAY omit the claim on it, but if the projection
is reachable as a target a consumer can inspect or `bind()`, the claim is
required.)

In other words, "T1 can be exposed remotely for observation" means its
*observation* surface (properties) crosses the wire; its declaration-only
`inputs` / `commands` metadata does **not** cross as a remote execution surface.
(A future remote-profile "observation-only capability" advertisement could let a
producer keep the names on the wire while signaling consumers not to offer
set / invoke; until such a capability exists, omission is the interoperable
behavior.)

### Discovering remote compatibility

Remote compatibility is a **conditional** requirement: a shell that claims it
must reject the full reserved-name set (§ 4) and keep every wire payload
`JsonValue`-serializable, but a local-only shell need not. A tool therefore needs
to know *whether to apply those checks* without implementation-specific
knowledge — and unlike the tier claim, that bit was previously only readable from
prose. The profile closes this by reserving the optional `remoteCompatible:
boolean` field on the standard tier-claim object (§ Tier claim must be
discoverable out-of-band).

> **One-line meaning.** `remoteCompatible: true` is a **responsibility claim, not
> a static payload guarantee**: it asserts that this object's current declaration
> may be handed directly to `RemoteShellProxy` and will then behave correctly
> under the remote profile's reserved-name validation and `JsonValue` failure
> semantics (reject / drop / report at the wire boundary, § below) — it does
> **not** assert that every value the shell will ever emit is statically known to
> be `JsonValue`. A tool MUST NOT read it as "payloads are pre-guaranteed
> serializable". (A stronger static guarantee, if ever wanted, belongs in a
> separate future field such as `payloadsStaticallyJsonValueSafe`, not in this
> bit.)

**Exact meaning: `remoteCompatible: true` ≡ "this instance's *current
declaration* can be handed directly to `RemoteShellProxy`."** It is a property of
the object it sits on, not of the implementation. So:

- It is the green light for `new RemoteShellProxy(thatObject, transport)`: a tool
  MAY pass an object whose tier claim has `remoteCompatible: true` straight to the
  remote producer. It MUST NOT do so for an object lacking the flag.
- A **non-T2 shell's original object MUST NOT set `remoteCompatible: true`** —
  passing it directly to `RemoteShellProxy` is exactly the dead-write /
  method-not-found break this section forbids. The flag belongs on the
  **remote-facing projection** (the wrapper whose declaration omits the
  un-drivable `inputs` / `commands`), which is the object actually safe to hand to
  `RemoteShellProxy`. A T2 shell that *is* itself directly exposable MAY set it on
  its own object.
- "This implementation can *produce* a remote-facing projection" is a **different,
  weaker** statement and MUST NOT be conflated with `remoteCompatible`. If an
  implementation wants to advertise that capability, it does so out-of-band
  (package-level conformance doc or a separate field), never by setting
  `remoteCompatible: true` on an object that is not itself directly exposable.

Mechanically, a shell that sets `remoteCompatible: true` MUST satisfy the
reserved-name set (§ 4) and keep every wire payload `JsonValue`-serializable; a
conformance runner treats an absent/`false` value as "no claim" and **skips** the
remote-only vectors, so a genuinely-exposable object that omitted the field would
be silently under-tested (hence MUST, not SHOULD). This keeps the remote claim
discoverable through the same standard channel as the T2/T3 claim — and pins it to
*the object a tool would actually pass to the wire*, so reading the flag and
acting on it can never route a tool into the forbidden direct-exposure path.

#### What `remoteCompatible: true` means for non-`JsonValue` values

`JsonValue`-serializability cannot be fully checked at construction — a source
property may later *update* to a function / symbol / cyclic object, and a command
may *return* one. So `remoteCompatible: true` is **not** a guarantee that the
composite layer re-validates every value itself; it is a claim that **the shell
is intended to carry `JsonValue` payloads and defers enforcement to the existing
remote wire profile's validation gates** rather than inventing its own. The
profile does not add a second validation layer — it pins *which* failure modes
apply so they do not diverge across implementations:

- **`set.value` / `cmd.args[i]`** (inbound, T2 producer path): validated by the
  remote producer exactly as today; a non-`JsonValue` is rejected with
  `WC_BINDABLE_INVALID_JSON_VALUE` (see [SPEC-extensions.md § Error
  envelope](SPEC-extensions.md)). The composite layer adds nothing.
- **Command return value** (T2 producer path): a non-`JsonValue` return is
  rejected with `WC_BINDABLE_INVALID_RETURN_VALUE`, again by the existing
  producer-side gate.
- **Property update / initial-sync value** (the observation path the composite
  *does* drive, by emitting shell events the remote producer forwards): a value
  that cannot cross the JSON boundary MUST NOT be silently delivered as a
  corrupted value. The remote-facing target MUST let the wire layer's existing
  send-time serialization handle it — the non-serializable update is **dropped at
  the wire boundary** (never mutated into `null`/`{}` and forwarded). This drop
  is the normative wire-interop requirement.

  The drop MUST also be **reported, not silent**: a bare swallow is
  non-conformant. **The responsibility sits with whichever layer performs the
  drop, and is not duplicated.** If the remote layer's send path already performs
  the `SPEC-extensions.md` producer-side non-`JsonValue` warning/drop (as
  `@wc-bindable/remote`'s `_safeSend` does for an unsendable frame), **that
  satisfies this report requirement** — the composite wrapper MUST NOT be
  required to log it a second time. The composite layer owns the report only when
  it drops the value *itself* before handing it to the wire layer (e.g. an
  implementation that adds its own emit-time `JsonValue` check). In that case the
  minimum report follows the same priority order as getter-failure reporting
  (§ 12) — `reportError` if available, else a deferred re-throw, else the
  implementation's structured logger at error/warn level — with the exact
  mechanism / timing non-normative, but at least one observable report MUST
  occur. The single hard rule across both layers: the non-serializable update is
  never silently swallowed *and* never forwarded as a corrupted value. Local
  `bind()` consumers of the same shell are unaffected — they observe the real JS
  value; only the wire view is bound by `JsonValue`.

So `remoteCompatible: true` is a **responsibility claim backed by the wire
profile's gates**, not a promise of an extra composite-side validator. An
implementation that wants to fail earlier MAY add its own construction-time or
emit-time `JsonValue` check, but MUST NOT produce a wire-visible failure shape
other than the ones above.

## TypeScript guidance

Type helpers are useful, but they should be implementation guidance rather than
normative protocol surface.

For static literal composition, an implementation can infer precise public
names:

```typescript
const shell = createCompositeTarget({
  sources: { s3, ai },
  expose: {
    properties: {
      "s3.progress": { source: "s3", name: "progress" },
      "ai.answer": { source: "ai", name: "answer" },
    },
  },
} as const);
```

For runtime-loaded composition, implementations should fall back to broad maps:

```typescript
type DynamicCompositeValues = Record<string, unknown>;
type DynamicCompositeInputs = Record<string, unknown>;
type DynamicCompositeCommands = Record<string, (...args: unknown[]) => unknown>;
```

This is a TypeScript boundary, not a protocol failure: literal configuration can
be inferred; runtime configuration cannot be fully statically known.

## Open questions

These are **future-profile exploration items, not part of COMPOSITE v1
conformance** — an implementation claiming v1 neither needs to resolve them nor is
tested on them (the Draft conformance vectors below are the v1 surface). Several
(dynamic source add/remove, fan-out commands) are *explicitly out of scope for
v1* in the body above and appear here only as forward-looking design questions.
They should remain implementation experiments until experience narrows the space:

- Should declarative composition auto-expose all source members by default, or
  require an explicit expose list?
- Should aliases be first-class, and if so should they preserve source prefixes
  in metadata outside the core declaration?
- Should source discovery be limited to the generated shadow root, or can it
  include light DOM children?
- Should dynamic source addition/removal ever be supported, and what would be
  the declaration-change notification model?
- Should fan-out commands be supported, and how should return values and errors
  aggregate?
- For a **T1 / T2** composed shell (a T3 shell already MUST expose `dispose()`
  per § 10), should the custom-element API rely on DOM lifecycle alone, or also
  offer an explicit `dispose()` for headless / non-DOM usage?
- Should a future conformance document include composition vectors, or should
  composition remain an implementation package with its own tests?
- The v1 standard tier-claim surface is now pinned to
  `Symbol.for("wc-bindable.composite.tiers")` (§ Tier claim must be discoverable
  out-of-band). What remains open is whether *richer* discovery is worth adding
  later (e.g. per-name execution flags, capability negotiation for the future
  remote "observation-only" advertisement) — to be settled under real tooling
  pressure without disturbing the v1 minimum.

## Draft conformance vectors

The first implementation should include tests for at least these cases. Each
vector is tagged with the tier claim it applies to, mirroring the
`Applies to:` convention in [CONFORMANCE.md](CONFORMANCE.md) so these can be
lifted into a future conformance document. **[T1]** = applies to every composed
shell (base observation surface); **[T2]** = required only when the shell claims
the local-facade tier; **[T3]** = required only when the shell claims the
Extension-1-capable tier. A shell claiming "T1 + T3 only" runs the [T1] and [T3]
vectors and MAY skip the [T2]-only ones.

1. **[T1]** Synthesized declaration is accepted by `getWcBindableDeclaration()`.
2. **[T1]** `bind(shell, onUpdate)` delivers initial values for exposed properties.
3. **[T1]** A source event re-emits exactly one shell event for the mapped composed
   property.
4. **[T1]** A source custom getter is applied once, not copied and re-applied by the
   shell declaration.
5. **[T1]** Two source properties that share one source event still become distinct
   shell property events, and **both** are dispatched on that occurrence — not
   only the first mapped property. Fan-out is **three-phase** (extract → commit →
   dispatch, § 6): (a) no getter observes a partially-updated cache — `B`'s getter
   reading `shell["A"]` during evaluation sees the **pre-event** `A`; (b) a
   listener on `A`'s shell event reading `shell["B"]` sees `B`'s **new** committed
   value (consistent snapshot); (c) a property whose getter threw is neither
   committed nor dispatched while its siblings still are.
6. **[T2]** Input assignment on the shell delegates to the correct source property.
7. **[T2]** Command invocation on the shell delegates to the correct source method
   and preserves async return behavior.
8. **[T1]** Duplicate composed property names are rejected at construction.
9. **[T1, conditional — when remote compatibility is enabled]** The full
   remote-reserved-name set is rejected — the `@wc-bindable/` case-insensitive
   prefix **and** `__proto__` / `constructor` / `prototype`, referenced from the
   wire profile rather than re-listed. A T1-only shell that does not claim remote
   compatibility is conformant and skips this vector (§ 4).
10. **[T1]** Final teardown (dispose, or the implementation's terminal lifecycle
    event) removes every installed source listener; a shell that detaches on a
    non-terminal disconnect does so only per its declared lifecycle policy, and a
    shell that keeps listeners across disconnect does not leak them at end of
    life either (§ 10).
11. **[T1]** A remote-proxy source reports `N in shell === false` before its first
    sync and `true` afterward; `bind()` delivers no premature initial value for it
    (§ 5).
12. **[T1]** A source getter that yields top-level `undefined` (or `null`) delivers
    that exact value to a shell consumer — not replaced by `sourceEvent.detail`
    and not coerced to `null` by a `CustomEvent.detail` boundary (§ 7
    undefined/null preservation MUST).
13. **[T2]** A name that collides across `properties` / `inputs` / `commands` is
    rejected at construction when the shell claims the local-facade tier (§ 4).
14. **[T1]** The synthesized declaration is immutable for the target's lifetime; a
    source or expose-map change produces a new shell target rather than mutating
    the existing one (§ 11).
15. **[T1]** The declarative API does not expose a shell instance until every source
    custom element is defined — an undefined source tag is either a construction
    error or awaited via `customElements.whenDefined()` (§ Declarative API).
16. Source failures propagate per surface (§ 12):
    - **[T2]** a throwing source **input setter** propagates synchronously
      (`shell[N] = v` re-raises the source setter's throw);
    - **[T2]** a throwing source **command** preserves its completion shape — a
      synchronous throw stays a synchronous throw, and a returned promise's
      rejection stays a rejection (the shell does not flatten one into the other);
    - **[T3]** the Extension-1 surface surfaces both kinds of failure as promise
      rejections carrying the Extension-1 error envelope.
17. **[T3]** A T3 (Extension-1-only) shell routes `set` / `invoke` to the correct
    source member **without** materializing `shell[name]` as an assignable /
    callable member, and a name shared between `inputs` and `commands` is accepted
    (the § 4 cross-surface rule does not apply to T3).
18. **[T2]** A composed shell exposed through `@wc-bindable/remote` for writable
    inputs / invokable commands requires the local facade (T2):
    `RemoteShellProxy`-driven `set` / `cmd` reach the mapped source; a
    T1-metadata-only shell does not wire them (§ Profile tiers).
19. **[T1]** Reconnect re-sync, tested per the policy the shell declares (§ 10) —
    these are distinct allowed behaviors, not one expected behavior:
    - **Unconditional re-sync:** after reconnect, every known/present exposed
      property dispatches a shell event regardless of whether its value changed.
    - **Changed-only re-sync:** only properties whose re-read value differs by
      `Object.is` dispatch (a value unchanged since last dispatch is suppressed;
      `NaN` counts as unchanged, `+0`/`-0` as changed).
    - **Documented silence:** no re-sync events fire on reconnect; the next
      observed value is whatever the next post-reconnect source event carries.
20. **[T1]** When two properties share one source event and the **first** property's
    getter throws, the second property is still dispatched, and the failure is
    reported through host error reporting — not swallowed and not allowed to
    suppress the sibling (§ 6 / § 12 getter-failure isolation).
21. **[T3]** A T3 shell whose source is itself Extension-1-capable (e.g. a
    `RemoteCoreProxy`) delegates `shell.setWithAck(N, v)` / `shell.invoke(N, …)`
    to `source.setWithAck(M, v)` / `source.invoke(M, …)` so the source's ack /
    rejection propagates end-to-end; a T3 shell over a plain local source wraps
    assignment / method call in Extension-1 semantics (§ 8 / § 9 routing).
22. **[T3]** A T3 shell exposes the **full** Extension 1 surface including
    `setWithAckOptions` / `invokeWithOptions` and `dispose`; after `dispose()`,
    `set` throws synchronously while `setWithAck` / `setWithAckOptions` /
    `invoke` / `invokeWithOptions` each reject (§ Profile tiers / § 10).
23. **[T3]** Source capability is classified per delegation kind in the default
    **auto** mode (§ 8) using a **positive marker**, not method names alone: a
    source is Extension-1-capable only when it exposes the full required subset
    **and** advertises a supported Extension-1 marker (the marker's shape and
    version handling are tested by vector 36); a source exposing none of those
    methods uses the plain-local path; a source exposing **some but not all**
    required methods is **rejected at construction**; and a source exposing the
    **full method set but NO supported marker** is **ambiguous** and rejected
    (never silently routed as Extension 1) — including the full-collision case
    where a legal local target happens to have methods named
    `set`/`setWithAck`/`setWithAckOptions` or `invoke`/`invokeWithOptions`. Input-
    and command-capability are classified independently.
24. **[T3]** The explicit override changes classification per delegation kind: a
    local source whose application method is literally named `invoke` /
    `setWithAck` is **not** rejected when its kind is pinned to **local** (the
    method is treated as an application member, delegated via the plain-local
    path — this is also the escape for the full-collision case), while another
    kind can independently stay **extension1**; and **extension1** both opts in a
    genuine-but-unmarked Extension 1 source and rejects a source missing the full
    required subset (§ 8). A whole-source mode is a shorthand for both kinds; a
    per-kind value takes precedence.
25. **[T3]** `setWithAck` / `setWithAckOptions` against a plain local (synchronous)
    source reject on a pre-aborted signal and on invalid options before assigning,
    but a pending `timeoutMs` does NOT produce `WC_BINDABLE_TIMEOUT` for the
    synchronous assignment; `invoke()` awaiting a local thenable DOES honor
    `timeoutMs` (§ 8 / § 9).
26. **[T1]** Source ownership — shared source not disposed by default. On final
    teardown, a source shared between two shells (or referenced after one shell's
    `dispose()`) is NOT torn down by that shell: the shell removes only its own
    listeners; the source remains usable by the other shell (§ 10). (This vector
    tests only the no-cascade default and listener removal — both apply to every
    tier. The shell-owned-pending rejection is covered separately by vector 30,
    which is [T3].)
27. **[T3]** Late source settlement after dispose is dropped. A T3 shell that
    delegated to an Extension-1-capable source and is then disposed does not
    re-settle or otherwise surface a `return` / `throw` that arrives from the
    source afterward; it drops (optionally logs) the late result (§ 10).
28. **[T1, conditional — only if cascading ownership is offered]** Cascading
    dispose is resilient. An implementation that does NOT offer `ownsSources` is
    conformant and skips this vector. When the opt-in IS offered and enabled, a
    source whose `dispose()` throws does not prevent the shell from disposing the
    remaining sources (best-effort teardown) (§ 10).
29. **[T1]** The tier claim is readable from the standard surface:
    `shell[Symbol.for("wc-bindable.composite.tiers")]` returns an object carrying
    at least the required `{ protocol: "wc-bindable.composite", version: 1,
    localFacade, extension1 }` for the instance in hand (not merely what the
    implementation supports), reading it does not throw, and a tool MUST NOT
    render a declared input/command as assignable/invokable until that surface
    confirms the matching tier — `constructor.wcBindable` alone never reveals it.
    A consumer reads `version` before relying on other fields, ignores unknown
    fields, and a validator does not reject the object for carrying fields beyond
    the required ones; an implementation-private field MUST use a namespaced /
    vendor-prefixed key (a plain-named private field is non-conformant)
    (§ Tier claim must be discoverable out-of-band).
30. **[T3]** A T3 acknowledged call is backed by a shell-owned pending entry, and
    `abort` / `timeout` ownership follows the source kind (§ 12): for an
    Extension-1-capable source the shell forwards `AckOptions` and **mirrors** the
    source's abort/timeout (it does NOT also install its own — no double
    handling); for a plain local source the shell owns abort/timeout locally.
    `dispose()` is always the shell's own terminal: it rejects shell-owned pending
    in caller order with `WC_BINDABLE_DISPOSED`, drops any later source
    settlement, never disposes/cancels the source, and wins a same-turn race
    against a source settlement. Each terminal is single-settlement, first-wins.
31. **[T3]** A plain-local-source T3 call normalizes failures to the Extension 1
    contract: a non-`Error` throw is canonicalized to an `Error` per
    [SPEC-extensions.md § Canonical mapping for non-Error throws](SPEC-extensions.md#canonical-mapping-for-non-error-throws)
    (`name === "NonErrorThrow"`, safely-stringified `message`), an application
    throw carries no invented protocol code (`WC_BINDABLE_REMOTE_THROW` or unset),
    and shell-synthesized protocol errors carry their registered `WC_BINDABLE_*`
    code — whereas the **[T2]** local facade re-raises the raw synchronous throw
    unaltered (§ 12).
32. **[T1]** A source event re-dispatches synchronously within the same call
    stack — not deferred to a microtask/task and not batched or de-duplicated; a
    `bind()` consumer sees the update on the same turn it would binding the
    source directly (§ 6).
33. **[T1]** For each dispatched composed property, `shell[N]` and `N in shell`
    reflect the **new** value before the shell event fires: a listener that reads
    `shell[N]` synchronously inside the shell-event handler observes the new
    value, never the previous one (§ 6 value-update-before-dispatch).
34. **[T1]** A non-T2 shell (e.g. T1 observation-only) exposed through
    `@wc-bindable/remote` is given a **remote-facing target whose
    `constructor.wcBindable` omits `inputs` / `commands`** (a generated isolated
    constructor / wrapper), so the remote consumer renders no set/invoke
    affordance while properties still sync and update normally. The original
    shell's own `constructor.wcBindable` keeps its inputs/commands for local
    tooling; passing the original T1 shell directly to `RemoteShellProxy` (which
    reads `constructor.wcBindable` verbatim) is non-conformant (§ Remote interop).
35. **[T1]** `remoteCompatible: true` means "**this object's current declaration
    can be handed directly to `RemoteShellProxy`**" and MUST sit only on a
    directly-exposable object: a T2 shell that is itself exposable, or a
    remote-facing **projection** — never a non-T2 original shell (passing that
    directly is the forbidden dead-write / method-not-found path). An object
    advertising it MUST satisfy the reserved-name set and `JsonValue`
    serializability; an absent/`false` value means "do not pass me directly", and
    a runner skips the remote-only vectors for it. "The implementation can produce
    a projection" is a separate, out-of-band claim and MUST NOT be encoded as
    `remoteCompatible` on a non-exposable object (§ Discovering remote
    compatibility).
36. **[T3]** The Extension-1 marker is treated as a versioned object, not a bare
    flag (the classification rule itself is vector 23): a source advertising
    `{ protocol: "wc-bindable.extension1", version: 1, inputs, commands }` is
    honored per its `inputs`/`commands` kinds; a source whose marker has an
    **unsupported `version`** or unrecognized `protocol` is **failed closed**
    (treated as not marker-capable → ambiguous under `auto`, resolvable only by
    an explicit override). Accepting the bare-boolean (`=== true`) shorthand is
    **optional** (§ 8): an implementation that accepts it MUST interpret it only
    as the v1 shorthand, and an implementation that does NOT accept it (object
    form only) is equally conformant — so this vector checks the bare-boolean
    branch only against implementations that opt into it. This is distinct from
    vector 23 (which tests the full/none/partial/ambiguous classification) in
    that it tests the marker's own version fail-closed. The marker also follows
    the tier-claim access rules: own property/getter, stable, read-only, and a
    **throwing read ⇒ marker unavailable** (source treated as not
    marker-capable, never routed as Extension 1 on a throw) (§ 8).
37. **[T1, conditional — only if the shell detaches/reinstalls listeners across
    reconnect]** Such a shell exposes its `reconnectResync` policy
    (`"unconditional" | "changed-only" | "silent"`) on the tier-claim object; a
    shell that never detaches listeners (no gap) MAY omit it (§ 10).
38. **[T1]** Fail-closed on an unsupported claim: a consumer facing an
    unrecognized `protocol` or an unsupported `version` on the tier-claim object
    treats the claim as **unavailable** — it renders no execution affordance from
    `localFacade` / `extension1` and ignores optional fields except for
    diagnostics, exactly as if no claim were present (§ Tier claim must be
    discoverable out-of-band).
39. A markerless current/legacy `RemoteCoreProxy` source, split by what the shell
    does with it (§ 8 migration note / § Remote interop):
    - **[T1]** It can still be **observed** without any override — properties sync
      and update through the shell normally.
    - **[T3]** Delegating **inputs / commands** to it is ambiguous under `auto`
      (markerless) and MUST require an explicit `extension1` override; it is never
      auto-delegated via Extension 1.
40. **[T1, conditional — when remote compatibility is enabled]** A property whose
    value becomes non-`JsonValue` (e.g. a function / symbol / cyclic object) is
    **dropped at the wire boundary** — never forwarded as a `null`/`{}`-corrupted
    value — and the drop is **reported, not silently swallowed** by whichever
    layer performs it (the remote layer's existing producer-side warning/drop
    satisfies this; the composite reports only when it drops the value itself,
    and the two are not double-reported). Local `bind()` consumers of the same
    shell still observe the real JS value. Inbound `set.value` / `cmd.args` and
    command return values instead surface the existing
    `WC_BINDABLE_INVALID_JSON_VALUE` / `WC_BINDABLE_INVALID_RETURN_VALUE` from the
    producer gate (§ Discovering remote compatibility).
41. **[T3]** Same-turn dispose race: `dispose()` synchronously marks every
    not-yet-settled shell-owned pending entry as `Disposed`/`WC_BINDABLE_DISPOSED`
    at the call site, so a source promise that had already resolved but whose
    mirroring continuation was still queued on the microtask queue is dropped (the
    continuation finds the entry already disposed) — `dispose()` wins; conversely
    an entry whose settlement callback already ran before `dispose()` stays
    terminal (§ 12 same-turn race).
42. **[T3]** Default-timeout policy is uniform and documented, and **never drops
    the caller's `signal`**. A *no-default-timeout call* (bare
    `setWithAck`/`invoke`, **or** `*WithOptions` with omitted/`undefined` options
    or `timeoutMs: undefined`) under the **Normalize** policy is delegated as
    `source.setWithAckOptions(M, v, { ...opts, timeoutMs: shellDefault })` /
    `source.invokeWithOptions(M, args, { ...opts, timeoutMs: shellDefault })` —
    merging so the caller's `signal` (and any other `AckOptions`) is preserved,
    never the bare source method; a call carrying a `signal` but no `timeoutMs`
    remains abortable through the composite (the abort-contract test). Under
    **Inherit-and-document** the timeout inherits the source default but the
    caller's `signal` is still forwarded. An explicit caller `timeoutMs`
    (including `0`) is always forwarded unchanged (§ 8 / § 9 default-timeout
    ownership).
43. **[T1]** The tier-claim symbol resolves as an **own** property/getter (not
    prototype-chain only), every read yields the same logical claim, and the
    returned object is read-only (SHOULD be frozen) so two inspections of the same
    instance never disagree (§ Tier claim must be discoverable out-of-band).
44. **[T3]** Caller-order is scoped to a single source / logical channel: the
    shell begins delegation in call order, calls to the **same** source inherit
    that source's ordering contract, but calls to **different** sources / channels
    get **no** guaranteed producer-side relative order — cross-source sequencing
    is the caller's responsibility (§ 8 caller-order preservation).
45. **[T1]** A source event that fires **reentrantly** from inside a shell-event
    listener is processed immediately and nested (its full
    extract→commit→dispatch cycle runs to completion before the outer cycle's
    remaining listeners resume), not queued; the nested cycle sees the outer
    cycle's already-committed values, and the cache is never rolled back (§ 6
    reentrant source events).
46. **Fixed-API collision rejected at construction (§ 4):** a composed name equal
    to a fixed member the shell exposes is rejected. The reserved set is the union
    of: **[T1, all tiers]** the discovery + bind-target operational surface —
    `constructor` (core discovery reads `target.constructor.wcBindable`),
    `addEventListener` / `removeEventListener` (and `dispatchEvent` when exposed as
    a dispatchable event source) — e.g. a source property mapped to the composed
    name `constructor` or `addEventListener` is rejected even on a T1 shell, and
    `__proto__` / `prototype` are rejected (MUST when remote-compatible, SHOULD
    otherwise); **[T3]** `set` / `setWithAck` / `setWithAckOptions` / `invoke` /
    `invokeWithOptions` / `dispose` (e.g. a source command mapped to `dispose` is
    rejected); **[T2]** an own facade member it would overwrite; a **T2+T3** shell
    applies the base set plus both per-tier sets.
47. **[T1]** `remoteCompatible: true` is a responsibility claim, not a static
    payload guarantee: a tool MUST NOT read it as "all emitted values are
    pre-guaranteed `JsonValue`", only as "directly `RemoteShellProxy`-able and
    bound by the wire profile's reserved-name + `JsonValue` failure semantics"
    (§ Discovering remote compatibility).
48. **[T1]** Alias-transparent fan-out: if the same underlying source-event
  occurrence is exposed through multiple aliases / source ids, the affected
  composed properties still behave as one § 6 three-phase cycle — a listener on
  `a.x` that synchronously reads `shell["b.y"]` after the shared commit point
  observes `b.y`'s committed value, not an implementation-defined pre/post
  interleaving.
49. **[T1]** Source subscription ownership belongs to the shell, not downstream
  `bind(shell, …)` consumers: a shell with no current consumers continues to
  honor whatever source-listener lifecycle § 10 gives it, and a later consumer
  observes state derived from that shell-owned source tracking rather than from
  a fresh consumer-triggered source subscription.
50. **[T3]** A composed shell that claims T3 and is then used as a source for a
  parent composite SHOULD advertise a matching
  `Symbol.for("wc-bindable.extension1")` marker so the parent's `auto`
  classification accepts it without an explicit override; if both the marker
  and the tier claim are present, they agree on whether the child is
  Extension-1-capable (§ 8 composite-to-composite interop).
