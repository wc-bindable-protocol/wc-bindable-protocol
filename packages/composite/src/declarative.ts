import type { WcBindableDeclaration } from "@wc-bindable/core";
import { CompositeEngine, planComposition, type CompositionPlan } from "./engine.js";
import { consoleLogger, type Logger } from "./logger.js";
import {
  COMPOSITE_PROFILE_VERSION,
  COMPOSITE_TIERS_SYMBOL,
  type CompositeTierClaim,
  type ExposeConfig,
  type ExposeMap,
  type SourceRef,
} from "./types.js";

/** An ordered source spec: a stable id paired with a source custom-element tag. */
export interface SourceSpec {
  id: string;
  /** The source custom-element tag name (e.g. `"s3-uploader"`). */
  tag: string;
}

/**
 * Options shared by {@link defineCompositeClass} and {@link defineComposite}.
 * Everything needed to synthesize the composed surface *except* the tag name —
 * {@link defineCompositeClass} returns an unregistered base class the caller
 * names itself, while {@link defineComposite} also takes a `tagName` and
 * registers the class.
 */
export interface DefineCompositeClassOptions {
  /** Ordered source specs: a stable id paired with a source custom-element tag. */
  sources: SourceSpec[];
  /**
   * What the shell exposes. Defaults to `"all-prefixed"` (every source member
   * under its `<sourceId>.<sourceName>` default name).
   */
  expose?: ExposeConfig;
  /** Materialize a T2 local facade. Defaults to true when inputs/commands exist. */
  localFacade?: boolean;
  /** Set the `remoteCompatible` tier-claim flag. */
  remoteCompatible?: boolean;
  logger?: Logger;
}

export interface DefineCompositeOptions extends DefineCompositeClassOptions {
  /** The custom-element tag name to register for the composed shell. */
  tagName: string;
}

/**
 * The generated composite custom-element constructor. Instances carry the
 * composed surface (property getters, optional T2 facade members, the tier
 * claim) and an idempotent `dispose()` terminal teardown. Returned by
 * {@link defineComposite} (already registered) and by {@link defineCompositeClass}
 * (an unregistered base class to subclass).
 */
export type CompositeElementConstructor = (new (
  ...args: unknown[]
) => HTMLElement & { dispose(): void }) & {
  wcBindable: WcBindableDeclaration;
};

const customElementsRef: CustomElementRegistry | undefined =
  typeof customElements !== "undefined" ? customElements : undefined;
const documentRef: Document | undefined = typeof document !== "undefined" ? document : undefined;

/**
 * Brand stamped on every generated composite element class. Lets a re-call
 * recognize a tag this package already defined even after {@link registrations}
 * is lost (e.g. an HMR module re-evaluation, where the `CustomElementRegistry`
 * persists but module state resets), so it returns the existing constructor
 * idempotently instead of mistaking it for a foreign collision.
 */
const COMPOSITE_ELEMENT_BRAND = Symbol.for("wc-bindable.composite.element");

/**
 * In-flight / settled registrations keyed by tag name. Populated synchronously
 * (before the first `await` in {@link defineComposite}) so concurrent same-tick
 * calls for one tag share a single registration instead of racing to
 * `customElements.define()` — only one `define()` ever runs per tag.
 */
const registrations = new Map<string, Promise<CompositeElementConstructor>>();

/**
 * Read a source custom element's static `wcBindable` declaration from its
 * registered constructor. The constructor MUST already be defined (the caller
 * awaits `customElements.whenDefined`).
 */
function readSourceDeclaration(tag: string): WcBindableDeclaration {
  const ctor = customElementsRef?.get(tag) as { wcBindable?: WcBindableDeclaration } | undefined;
  const decl = ctor?.wcBindable;
  if (!decl || decl.protocol !== "wc-bindable" || !Array.isArray(decl.properties)) {
    throw new Error(
      `@wc-bindable/composite: source tag <${tag}> does not expose a static wcBindable declaration`,
    );
  }
  return decl;
}

/**
 * Remove the source elements this package created in a shadow root (marked with
 * `data-wc-source`), leaving any other shadow content a subclass rendered
 * intact. Used to de-duplicate sources on a retry without wiping the whole tree.
 */
function removeOwnedSources(shadow: ShadowRoot): void {
  for (const stray of Array.from(shadow.querySelectorAll("[data-wc-source]"))) {
    stray.remove();
  }
}

/**
 * Install the per-instance composed surface (T1 property getters, and the T2
 * input setters / command members when the facade is enabled) plus the tier
 * claim, on a concrete shell element instance.
 *
 * Unlike the headless {@link createCompositeTarget} Proxy shell, a custom
 * element is handed to the DOM directly and cannot be Proxy-wrapped, so composed
 * members are materialized with `Object.defineProperty`. Consequently `N in
 * element` is `true` for every declared property (the § 5 "remote source reports
 * `in === false` until synced" nuance does not apply to synchronous DSD custom
 * element sources). `element[N]` still returns the engine's current value.
 */
function installInstanceSurface(
  element: HTMLElement,
  engine: CompositeEngine,
  plan: CompositionPlan,
  claim: CompositeTierClaim,
): void {
  for (const prop of plan.properties) {
    Object.defineProperty(element, prop.composedName, {
      get: () => engine.getValue(prop.composedName),
      configurable: true,
      enumerable: true,
    });
  }

  if (plan.localFacade) {
    for (const input of plan.inputs) {
      Object.defineProperty(element, input.composedName, {
        get: () => undefined,
        set: (value: unknown) => engine.setInput(input.composedName, value),
        configurable: true,
        enumerable: true,
      });
    }
    for (const command of plan.commands) {
      Object.defineProperty(element, command.composedName, {
        value: engine.getCommand(command.composedName),
        configurable: true,
        enumerable: true,
        writable: false,
      });
    }
  }

  // configurable so a connectedCallback retry (after a prior install() failure)
  // can re-apply the surface without an "already defined" TypeError. The claim
  // value itself is frozen, so read-only-ness is preserved.
  Object.defineProperty(element, COMPOSITE_TIERS_SYMBOL, {
    value: claim,
    enumerable: false,
    configurable: true,
    writable: false,
  });
}

/**
 * Define a composed custom element programmatically.
 *
 * Per the § Declarative custom element API precondition, this awaits
 * `customElements.whenDefined()` for **every** source tag before synthesizing
 * the declaration and registering the composite element — a shell instance is
 * never observable with a provisional declaration. Resolves with the generated
 * constructor once it is registered.
 *
 * Concurrency-safe and idempotent per tag: concurrent or repeated calls for the
 * same `tagName` share one registration (no `define()` race), and a re-call
 * returns the existing composite constructor without re-validating `options`. A
 * tag already occupied by a *non-composite* element is reported as an error.
 *
 * Each instance builds its own shadow root (`mode: "open"`) containing one
 * freshly-created instance of every source tag, binds an engine to those source
 * instances, and exposes the composed surface. Source listeners are installed on
 * first connect and kept for the element's lifetime (no detach-on-disconnect, so
 * there is no reconnect re-sync gap, § 10); call `element.dispose()` for terminal
 * teardown.
 */
export function defineComposite(
  options: DefineCompositeOptions,
): Promise<CompositeElementConstructor> {
  // defineComposite always returns a Promise, so every error — including the
  // synchronous precondition failures below — surfaces as a rejection, letting
  // callers handle them uniformly with `await` / `.catch`.
  if (!customElementsRef || !documentRef) {
    return Promise.reject(
      new Error("@wc-bindable/composite: defineComposite requires a DOM (customElements/document)"),
    );
  }
  const { tagName } = options;

  // Direct self-reference guard. If a source tag equals this composite's own
  // tag, registerCompositeElement would `await customElements.whenDefined(tag)`
  // for a tag that is only `define()`d at the very end of that same call — a
  // promise that can never resolve, so the registration would hang silently.
  // The composition graph MUST be acyclic (SPEC-extensions.md § Composition /
  // COMPOSITE.md § 4: "a cyclic composition has no conformant construction
  // order"); fail fast with a clear synchronous rejection instead of
  // deadlocking. (Transitive tag cycles are undetectable at define() time and
  // are intentionally out of scope.)
  if (options.sources.some((spec) => spec.tag === tagName)) {
    return Promise.reject(
      new Error(
        `@wc-bindable/composite: composite <${tagName}> cannot list its own tag as a source ` +
          `— a cyclic composition has no conformant construction order`,
      ),
    );
  }

  // Fast path: an in-flight or settled registration for this tag is shared
  // verbatim, so concurrent same-tick calls never race to define() and a
  // re-call is idempotent. NOTE: re-registering an already-defined tag returns
  // the existing constructor WITHOUT re-validating that `options` still matches
  // — configuration drift across calls is the caller's responsibility (the
  // synthesized declaration is immutable per § 11).
  const cached = registrations.get(tagName);
  if (cached) return cached;

  const existing = customElementsRef.get(tagName) as
    | (CustomElementConstructor & { [COMPOSITE_ELEMENT_BRAND]?: boolean })
    | undefined;
  if (existing) {
    if (existing[COMPOSITE_ELEMENT_BRAND]) {
      // Already defined by this package (e.g. registrations was reset by HMR).
      const resolved = Promise.resolve(existing as CompositeElementConstructor);
      registrations.set(tagName, resolved);
      return resolved;
    }
    // The tag is occupied by a non-composite element; returning it typed as a
    // composite constructor would be a lie, so fail loudly instead.
    return Promise.reject(
      new Error(
        `@wc-bindable/composite: custom element <${tagName}> is already defined by another (non-composite) element`,
      ),
    );
  }

  // Populate the cache BEFORE the first await so a second same-tick call hits
  // the fast path above. A failed registration is evicted so it can be retried.
  const promise = registerCompositeElement(options);
  registrations.set(tagName, promise);
  promise.catch(() => {
    if (registrations.get(tagName) === promise) registrations.delete(tagName);
  });
  return promise;
}

/**
 * The resolved, immutable composition derived from a set of source tags:
 * everything needed to build a composite element class and to set up each
 * instance. Produced by {@link synthesizeComposite}.
 *
 * @internal Shared between the vanilla custom-element path and the Lit subpath
 * (`@wc-bindable/composite/lit`); not part of the public package surface.
 */
export interface SynthesizedComposite {
  plan: CompositionPlan;
  claimTemplate: CompositeTierClaim;
  sourceSpecs: SourceSpec[];
  logger: Logger;
}

/**
 * Await every source tag's `customElements.whenDefined`, read each source's
 * `static wcBindable`, and plan the composition — so the synthesized declaration
 * and tier claim are fully determined before any class is built or any instance
 * is observable (§ Declarative precondition / § 11 finalize-before-observe).
 *
 * @internal
 */
export async function synthesizeComposite(
  options: DefineCompositeClassOptions,
): Promise<SynthesizedComposite> {
  const logger = options.logger ?? consoleLogger;

  // § Declarative precondition: every source tag must be defined before the
  // declaration can be read. Adopt the async-registration model.
  await Promise.all(options.sources.map((spec) => customElementsRef!.whenDefined(spec.tag)));

  const sourceDecls = new Map<string, WcBindableDeclaration>();
  for (const spec of options.sources) sourceDecls.set(spec.id, readSourceDeclaration(spec.tag));

  let localFacade = options.localFacade;
  if (localFacade === undefined) {
    const probe = planComposition(sourceDecls, options.expose ?? "all-prefixed", { localFacade: false });
    localFacade = probe.inputs.length > 0 || probe.commands.length > 0;
  }
  const plan = planComposition(sourceDecls, options.expose ?? "all-prefixed", { localFacade });

  const claimTemplate: CompositeTierClaim = {
    protocol: "wc-bindable.composite",
    version: COMPOSITE_PROFILE_VERSION,
    localFacade: plan.localFacade,
    extension1: false,
  };
  if (options.remoteCompatible) claimTemplate.remoteCompatible = true;
  Object.freeze(claimTemplate);

  return { plan, claimTemplate, sourceSpecs: options.sources.slice(), logger };
}

/**
 * Set up one composite element instance: create a fresh source element per spec
 * inside `shadow`, install the composed surface (property getters, optional T2
 * facade, tier claim) on `host`, and bind the engine to the sources. Returns the
 * installed engine. On an `install()` failure it rolls the sources back and
 * rethrows, leaving `host` clean enough for a reconnect retry.
 *
 * Only the source elements this package owns (`[data-wc-source]`) are touched —
 * any other shadow content (e.g. a Lit-rendered UI) is left intact.
 *
 * @internal
 */
export function setupCompositeInstance(
  host: HTMLElement,
  shadow: ShadowRoot,
  synth: SynthesizedComposite,
): CompositeEngine {
  // Defensive backstop against a direct self-reference. `defineComposite()`
  // rejects a source tag equal to the composite's own tag at registration time;
  // the class-authoring paths (`defineCompositeClass` / `CompositeLitElement`)
  // do not know the tag the caller will register the class under, so the check
  // is repeated here where `host.localName` is known. In practice this never
  // fires through the public API — a caller cannot register a class under one of
  // its own source tags: that tag is either already defined (so
  // `customElements.define` throws "already defined") or not yet defined (so
  // `synthesizeComposite`'s `whenDefined()` never resolves and the class is
  // never produced). It is kept because the failure it prevents — recursively
  // creating a host-typed element inside its own shadow root on every connect,
  // i.e. unbounded re-entry / stack overflow — is catastrophic, and the guard
  // is free.
  const selfTag = host.localName;
  if (selfTag && synth.sourceSpecs.some((spec) => spec.tag === selfTag)) {
    throw new Error(
      `@wc-bindable/composite: composite <${selfTag}> cannot list its own tag as a source ` +
        `— a cyclic composition has no conformant construction order`,
    );
  }

  removeOwnedSources(shadow);

  const sources = new Map<string, EventTarget>();
  for (const spec of synth.sourceSpecs) {
    const sourceEl = documentRef!.createElement(spec.tag);
    sourceEl.setAttribute("data-wc-source", spec.id);
    shadow.appendChild(sourceEl);
    sources.set(spec.id, sourceEl);
  }

  const engine = new CompositeEngine(synth.plan, sources, host, synth.logger);
  // The instance surface (defined with configurable members) is safe to
  // (re)apply on a retry. install() is the only fallible step here; if it
  // throws, roll the sources back so a reconnect can retry cleanly rather than
  // stranding a half-initialized element.
  installInstanceSurface(host, engine, synth.plan, synth.claimTemplate);
  try {
    engine.install();
  } catch (err) {
    engine.dispose();
    removeOwnedSources(shadow);
    throw err;
  }
  return engine;
}

/**
 * Build (but do not register) the composite element class for `options`.
 *
 * Shared by {@link defineComposite} (which then calls `customElements.define`)
 * and {@link defineCompositeClass} (which returns the class for the caller to
 * subclass and register).
 */
async function buildCompositeClass(
  options: DefineCompositeClassOptions,
): Promise<CompositeElementConstructor> {
  const synth = await synthesizeComposite(options);

  class CompositeElement extends HTMLElement {
    static readonly wcBindable: WcBindableDeclaration = synth.plan.declaration;
    static readonly [COMPOSITE_ELEMENT_BRAND] = true;

    #engine: CompositeEngine | undefined;
    #setup = false;

    connectedCallback(): void {
      if (this.#setup) return; // reconnect: listeners were kept, nothing to do
      const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
      this.#engine = setupCompositeInstance(this, shadow, synth);
      this.#setup = true;
    }

    /** Idempotent terminal teardown (§ 10). Does not dispose the source elements. */
    dispose(): void {
      this.#engine?.dispose();
    }
  }

  return CompositeElement as unknown as CompositeElementConstructor;
}

async function registerCompositeElement(
  options: DefineCompositeOptions,
): Promise<CompositeElementConstructor> {
  const CompositeElement = await buildCompositeClass(options);
  customElementsRef!.define(options.tagName, CompositeElement);
  return CompositeElement;
}

/**
 * Build a composite custom-element **base class** without registering it, so a
 * caller can subclass it to add their own behavior (methods, light-DOM
 * rendering, extra lifecycle work) and then register it themselves with
 * `customElements.define`. This is the class-authoring counterpart to
 * {@link defineComposite}, which returns an opaque, already-registered class.
 *
 * ```ts
 * const Base = await defineCompositeClass({
 *   sources: [{ id: "s3", tag: "s3-uploader" }, { id: "ai", tag: "ai-agent" }],
 * });
 * class MyWorkbench extends Base {
 *   reset() { this["ai.prompt"] = ""; } // your own behavior on top of the composite
 * }
 * customElements.define("my-ai-workbench", MyWorkbench);
 * ```
 *
 * Like {@link defineComposite}, this awaits `customElements.whenDefined()` for
 * every source tag before resolving, so the synthesized `static wcBindable` is
 * fully determined on the returned class (and statically inherited by any
 * subclass, keeping `target.constructor.wcBindable` discovery intact).
 *
 * The base class owns its shadow root for the source instances and sets them up
 * in `connectedCallback`. A subclass that overrides `connectedCallback` MUST call
 * `super.connectedCallback()` (and SHOULD do so before adding its own shadow
 * content, which the base only initializes — never wipes — once). Unlike
 * {@link defineComposite}, no tag-level caching or self-reference guard applies
 * here — the caller owns the `customElements.define` call.
 */
export function defineCompositeClass(
  options: DefineCompositeClassOptions,
): Promise<CompositeElementConstructor> {
  if (!customElementsRef || !documentRef) {
    return Promise.reject(
      new Error(
        "@wc-bindable/composite: defineCompositeClass requires a DOM (customElements/document)",
      ),
    );
  }
  return buildCompositeClass(options);
}

/**
 * Parse a `data-wc-expose` attribute into per-source expose entries.
 *
 * Grammar (whitespace-insensitive):
 *   `properties: a, b; inputs: c; commands: d`
 * Singular kind keywords (`property` / `input` / `command`) are also accepted.
 */
function parseExposeAttribute(value: string, sourceId: string): {
  properties: [string, SourceRef][];
  inputs: [string, SourceRef][];
  commands: [string, SourceRef][];
} {
  const result = {
    properties: [] as [string, SourceRef][],
    inputs: [] as [string, SourceRef][],
    commands: [] as [string, SourceRef][],
  };
  for (const segment of value.split(";")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      throw new Error(`@wc-bindable/composite: malformed data-wc-expose segment ${JSON.stringify(trimmed)}`);
    }
    const kind = trimmed.slice(0, colon).trim().toLowerCase();
    const names = trimmed
      .slice(colon + 1)
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
    const bucket =
      kind === "properties" || kind === "property"
        ? result.properties
        : kind === "inputs" || kind === "input"
          ? result.inputs
          : kind === "commands" || kind === "command"
            ? result.commands
            : undefined;
    if (!bucket) {
      throw new Error(`@wc-bindable/composite: unknown data-wc-expose kind ${JSON.stringify(kind)}`);
    }
    for (const name of names) {
      bucket.push([`${sourceId}.${name}`, { source: sourceId, name }]);
    }
  }
  return result;
}

/**
 * Resolve the shadow content of a definition element. Handles both a parsed
 * Declarative Shadow DOM (`element.shadowRoot` populated by the HTML parser) and
 * the unparsed-template fallback (a `<template shadowrootmode="open">` /
 * legacy `shadowroot="open"` child whose `.content` carries the sources) so the
 * API works in browsers without DSD parsing and in test environments.
 */
function getDefinitionContent(def: Element): ParentNode | null {
  if (def.shadowRoot) return def.shadowRoot;
  for (const child of Array.from(def.children)) {
    if (
      child.tagName === "TEMPLATE" &&
      (child.hasAttribute("shadowrootmode") || child.hasAttribute("shadowroot"))
    ) {
      return (child as HTMLTemplateElement).content;
    }
  }
  return null;
}

/**
 * Read source specs and an optional expose map from a definition element's
 * shadow content (the `<template shadowroot[mode]>` that wraps the composed
 * source elements). Returns `null` if no shadow content / source elements are
 * found.
 */
function parseDefinition(def: Element): {
  sources: SourceSpec[];
  expose: ExposeConfig | undefined;
} | null {
  const content = getDefinitionContent(def);
  if (!content) return null;

  const sourceEls = Array.from(content.querySelectorAll("[data-wc-source]"));
  if (sourceEls.length === 0) return null;

  const sources: SourceSpec[] = [];
  const exposeMap: ExposeMap = {};
  let sawExpose = false;

  for (const el of sourceEls) {
    const id = el.getAttribute("data-wc-source");
    // An element matched `[data-wc-source]` but carries an empty value — a
    // markup typo. Fail loudly rather than silently dropping the source (the
    // JavaScript API rejects invalid source ids too; this keeps the declarative
    // path from quietly accepting a malformed definition).
    if (!id) {
      throw new Error(
        `@wc-bindable/composite: <${el.localName}> has an empty data-wc-source (a non-empty source id is required)`,
      );
    }
    sources.push({ id, tag: el.localName });

    const exposeAttr = el.getAttribute("data-wc-expose");
    if (exposeAttr !== null) {
      sawExpose = true;
      const parsed = parseExposeAttribute(exposeAttr, id);
      for (const [name, ref] of parsed.properties) (exposeMap.properties ??= {})[name] = ref;
      for (const [name, ref] of parsed.inputs) (exposeMap.inputs ??= {})[name] = ref;
      for (const [name, ref] of parsed.commands) (exposeMap.commands ??= {})[name] = ref;
    }
  }

  return { sources, expose: sawExpose ? exposeMap : undefined };
}

/**
 * Scan `root` for declarative composite definitions and register each.
 *
 * A definition element carries `data-wc-composite-definition`; its tag name
 * becomes the composed custom element, and its Declarative Shadow DOM
 * (`<template shadowrootmode="open">`) wraps the source elements, each marked
 * with `data-wc-source="<id>"` and optionally `data-wc-expose="..."`:
 *
 * ```html
 * <my-ai-workbench data-wc-composite-definition>
 *   <template shadowrootmode="open">
 *     <s3-uploader data-wc-source="s3"></s3-uploader>
 *     <ai-agent data-wc-source="ai"></ai-agent>
 *   </template>
 * </my-ai-workbench>
 * ```
 *
 * Resolves once every discovered definition has been registered (awaiting each
 * definition's source tags via `customElements.whenDefined`). Returns the
 * generated constructors in document order.
 */
export async function registerCompositeDefinitions(
  root: ParentNode = documentRef as unknown as ParentNode,
  options?: { localFacade?: boolean; remoteCompatible?: boolean; logger?: Logger },
): Promise<CompositeElementConstructor[]> {
  if (!customElementsRef || !documentRef) {
    throw new Error(
      "@wc-bindable/composite: registerCompositeDefinitions requires a DOM (customElements/document)",
    );
  }
  if (!root) {
    throw new Error("@wc-bindable/composite: no root provided and no global document available");
  }

  // Include `root` itself when it is a matching definition element, not only its
  // descendants (`querySelectorAll` searches descendants only), so passing a
  // definition element directly works as a caller would expect.
  const definitions = Array.from(root.querySelectorAll("[data-wc-composite-definition]"));
  if (
    root instanceof Element &&
    root.matches("[data-wc-composite-definition]") &&
    !definitions.includes(root)
  ) {
    definitions.unshift(root);
  }
  const results: Promise<CompositeElementConstructor>[] = [];

  for (const def of definitions) {
    const parsed = parseDefinition(def);
    if (!parsed) continue;
    results.push(
      defineComposite({
        tagName: def.localName,
        sources: parsed.sources,
        expose: parsed.expose,
        localFacade: options?.localFacade,
        remoteCompatible: options?.remoteCompatible,
        logger: options?.logger,
      }),
    );
  }

  return Promise.all(results);
}
