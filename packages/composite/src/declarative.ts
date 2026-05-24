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

/** An ordered source spec discovered in a definition's shadow content. */
interface SourceSpec {
  id: string;
  /** The source custom-element tag name (e.g. `"s3-uploader"`). */
  tag: string;
}

export interface DefineCompositeOptions {
  /** The custom-element tag name to register for the composed shell. */
  tagName: string;
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

/** The generated composite custom-element constructor. */
export type CompositeElementConstructor = CustomElementConstructor & {
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

async function registerCompositeElement(
  options: DefineCompositeOptions,
): Promise<CompositeElementConstructor> {
  const { tagName } = options;
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

  const sourceSpecs = options.sources.slice();

  const claimTemplate: CompositeTierClaim = {
    protocol: "wc-bindable.composite",
    version: COMPOSITE_PROFILE_VERSION,
    localFacade: plan.localFacade,
    extension1: false,
  };
  if (options.remoteCompatible) claimTemplate.remoteCompatible = true;
  Object.freeze(claimTemplate);

  class CompositeElement extends HTMLElement {
    static readonly wcBindable: WcBindableDeclaration = plan.declaration;
    static readonly [COMPOSITE_ELEMENT_BRAND] = true;

    #engine: CompositeEngine | undefined;
    #setup = false;

    connectedCallback(): void {
      if (this.#setup) return; // reconnect: listeners were kept, nothing to do

      const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
      // Clear any sources left by a prior FAILED attempt so a retry does not
      // duplicate them (success sets #setup and short-circuits future calls).
      shadow.replaceChildren();

      const sources = new Map<string, EventTarget>();
      for (const spec of sourceSpecs) {
        const sourceEl = documentRef!.createElement(spec.tag);
        sourceEl.setAttribute("data-wc-source", spec.id);
        shadow.appendChild(sourceEl);
        sources.set(spec.id, sourceEl);
      }

      const engine = new CompositeEngine(plan, sources, this, logger);
      // The instance surface (defined with configurable members) is safe to
      // (re)apply on a retry. install() is the only fallible step here; if it
      // throws, roll the shadow back and leave #setup false so a reconnect can
      // retry cleanly rather than stranding a half-initialized element.
      installInstanceSurface(this, engine, plan, claimTemplate);
      try {
        engine.install();
      } catch (err) {
        engine.dispose();
        shadow.replaceChildren();
        throw err;
      }
      this.#engine = engine;
      this.#setup = true;
    }

    /** Idempotent terminal teardown (§ 10). Does not dispose the source elements. */
    dispose(): void {
      this.#engine?.dispose();
    }
  }

  customElementsRef!.define(tagName, CompositeElement);
  return CompositeElement as unknown as CompositeElementConstructor;
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
