export interface WcBindableProperty {
  name: string;
  event: string;
  getter?: (event: Event) => unknown;
}

export interface WcBindableInput {
  name: string;
  // `attribute` is a declarative hint consumed by extension specs (tooling,
  // attribute reflection, remote proxying). The core protocol ignores it.
  // See SPEC-extensions.md.
  attribute?: string;
}

export interface WcBindableCommand {
  name: string;
  // `async` is a declarative hint consumed by extension specs (remote
  // proxying, docs). The core protocol ignores it. See SPEC-extensions.md.
  async?: boolean;
}

export interface WcBindableDeclaration {
  protocol: "wc-bindable";
  /**
   * Integer protocol version. Future versions MUST remain backward-compatible
   * at the `properties` binding contract level — i.e. an adapter built for
   * version N MUST accept declarations whose `version` is >= N, ignoring any
   * fields it does not recognize. Breaking changes to the `properties`
   * contract require a new `protocol` identifier rather than a version bump.
   */
  version: number;
  properties: WcBindableProperty[];
  inputs?: WcBindableInput[];
  commands?: WcBindableCommand[];
}

export type WcBindableConstructor = (new (...args: unknown[]) => EventTarget) & {
  wcBindable: WcBindableDeclaration;
};

/**
 * Structural type narrowed by `isWcBindable()`. Requires only the
 * consumer-side EventTarget surface (`addEventListener` /
 * `removeEventListener`) plus a `constructor.wcBindable` declaration —
 * `dispatchEvent` is intentionally NOT required so a relay-only proxy that
 * re-emits events through its own internal channel can still be a valid
 * bind target. See SPEC.md § Overview for the consumer-vs-producer split.
 */
export interface WcBindableElement {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void;
  readonly constructor: WcBindableConstructor;
}

/**
 * Lowest protocol version any declaration may carry. Fixed at `1` for the
 * `"wc-bindable"` protocol identifier and **NOT** adapter-specific —
 * within a given `protocol` identifier, breaking changes require a new
 * identifier rather than a version bump, so any version `>= 1` must be
 * accepted by every adapter regardless of when the adapter was built.
 * See SPEC.md § Versioning for the forward-compatibility policy.
 */
export const MIN_COMPATIBLE_VERSION = 1;

/**
 * @deprecated v0.7.0 alias kept for source compatibility. Use
 * {@link MIN_COMPATIBLE_VERSION}. Scheduled for removal in v1.0.
 *
 * Historical note: this constant was originally intended to gate "the
 * highest protocol version this adapter understands", which the
 * forward-compatibility policy explicitly disallows. The check has always
 * been `decl.version >= MIN_COMPATIBLE_VERSION`, and `MIN_COMPATIBLE_VERSION`
 * is now pinned to the protocol-wide minimum (`1`).
 */
export const SUPPORTED_PROTOCOL_VERSION = MIN_COMPATIBLE_VERSION;

const DEFAULT_GETTER = (e: Event): unknown => (e as CustomEvent).detail;

/**
 * Read the wc-bindable declaration off `target` via the protocol's sole
 * discovery path (`target.constructor.wcBindable`). Returns the declaration
 * if it is a fully valid wc-bindable contract, or `undefined` otherwise.
 *
 * Validation performed:
 *   - `protocol === "wc-bindable"`
 *   - `version` is an integer `>= MIN_COMPATIBLE_VERSION`
 *   - `properties` is an array; every entry has a string `name` and string
 *     `event`; `getter` (if present) is a function
 *   - `inputs` / `commands` (if present) are arrays of objects with string `name`s
 *   - `name`s are unique within `properties`, within `inputs`, and within `commands`
 *
 * Because the validation is *complete*, the helper doubles as the single
 * source of truth for "is this target safe to bind to" — `isWcBindable()`
 * is exactly `getWcBindableDeclaration(target) !== undefined`, and no
 * declaration that survives this filter will silently no-op inside `bind()`.
 *
 * Prefer this helper over reading `target.constructor.wcBindable`
 * directly. The helper centralizes the discovery rule so future protocol
 * extensions (e.g. tooling that inspects a Symbol-keyed declaration or a
 * registry) can be added without rewriting every consumer. Inside this
 * package, `isWcBindable()` and `bind()` both go through this helper.
 */
export function getWcBindableDeclaration(
  target: unknown,
): WcBindableDeclaration | undefined {
  // SPEC.md § Discovery API contract: the parameter is `unknown` precisely
  // so callers can probe arbitrary inputs (a stray null, a plain object,
  // a Map, …) without first having to coerce to EventTarget. This helper
  // MUST NOT throw on any input shape.
  if (target === null || (typeof target !== "object" && typeof target !== "function")) {
    return undefined;
  }
  // SPEC.md § Overview pins EventTarget as the minimum target capability.
  // Reject targets that satisfy the declaration schema but cannot actually
  // be bound to — without this, `bind()` would throw on `addEventListener`
  // later, defeating the "discovery == bindability" contract.
  const t = target as { addEventListener?: unknown; removeEventListener?: unknown };
  if (typeof t?.addEventListener !== "function" || typeof t?.removeEventListener !== "function") {
    return undefined;
  }
  // Guard against pathological targets (e.g. `Object.create(null)` — no
  // constructor at all; a constructor that throws on `wcBindable` access).
  // The contract is "MUST NOT throw", so any error path returns undefined.
  let decl: WcBindableDeclaration | undefined;
  try {
    const ctor = (target as { constructor?: { wcBindable?: WcBindableDeclaration } }).constructor;
    decl = ctor?.wcBindable;
  } catch {
    return undefined;
  }
  if (decl?.protocol !== "wc-bindable") return undefined;
  if (typeof decl.version !== "number" || !Number.isInteger(decl.version)) return undefined;
  if (decl.version < MIN_COMPATIBLE_VERSION) return undefined;
  if (!Array.isArray(decl.properties)) return undefined;

  if (!isValidNamedList(decl.properties, isValidPropertyDescriptor)) return undefined;
  if (decl.inputs !== undefined && !isValidNamedList(decl.inputs, isValidInputDescriptor)) return undefined;
  if (decl.commands !== undefined && !isValidNamedList(decl.commands, isValidCommandDescriptor)) return undefined;

  return decl;
}

function isValidPropertyDescriptor(p: unknown): p is WcBindableProperty {
  if (!p || typeof p !== "object") return false;
  const pp = p as Partial<WcBindableProperty>;
  if (typeof pp.name !== "string" || pp.name.length === 0) return false;
  if (typeof pp.event !== "string" || pp.event.length === 0) return false;
  if (pp.getter !== undefined && typeof pp.getter !== "function") return false;
  return true;
}

function isValidInputDescriptor(p: unknown): p is WcBindableInput {
  if (!p || typeof p !== "object") return false;
  const pp = p as Partial<WcBindableInput>;
  if (typeof pp.name !== "string" || pp.name.length === 0) return false;
  // `attribute` is a Schema-defined optional field of type `string`. Core
  // never interprets it (see SPEC-extensions.md), but its declared type
  // is still part of the wcBindable schema — a non-string value here is
  // an invalid declaration even though core would otherwise ignore the
  // field. Validating it keeps "isWcBindable === true ⇒ schema is well-
  // formed" honest.
  if (pp.attribute !== undefined && typeof pp.attribute !== "string") return false;
  return true;
}

function isValidCommandDescriptor(p: unknown): p is WcBindableCommand {
  if (!p || typeof p !== "object") return false;
  const pp = p as Partial<WcBindableCommand>;
  if (typeof pp.name !== "string" || pp.name.length === 0) return false;
  // Same rationale as `attribute` above: `async` is a Schema-typed
  // optional boolean. Type-validate it even though core never reads it.
  if (pp.async !== undefined && typeof pp.async !== "boolean") return false;
  return true;
}

function isValidNamedList<T extends { name: string }>(
  list: unknown,
  isValidEntry: (entry: unknown) => entry is T,
): list is T[] {
  if (!Array.isArray(list)) return false;
  const seen = new Set<string>();
  for (const entry of list) {
    if (!isValidEntry(entry)) return false;
    if (seen.has(entry.name)) return false; // duplicate name within the list
    seen.add(entry.name);
  }
  return true;
}

export function isWcBindable(target: unknown): target is WcBindableElement {
  return getWcBindableDeclaration(target) !== undefined;
}

export type UnbindFn = () => void;

export interface BindOptions {
  /**
   * When the initial-value synchronization should happen.
   *
   * - `"call"` (default): read each declared property synchronously inside
   *   `bind()` and deliver any value where `name in target` is true. Backward-
   *   compatible behavior.
   * - `"connect"`: when `target` is an `HTMLElement` that is not yet
   *   connected to a document, defer the initial-value read until the
   *   element becomes connected (i.e. after `connectedCallback` has run).
   *   For headless `EventTarget`s and already-connected elements, behaves
   *   like `"call"`.
   *
   *   **Read this as `"light-dom-connect"`.** The option is narrowly
   *   scoped — it observes via a `MutationObserver` on the top-level
   *   `document`, which (a) does NOT traverse shadow roots, so a target
   *   appended into a shadow tree never fires the deferred sync, and
   *   (b) installs one document-wide observer per deferred bind. It is
   *   the right tool for one specific use case: a caller that has an
   *   `el` reference it will hand to a host (`document.body.appendChild`,
   *   `van.add`, MobX root mount) at a later point and does not want to
   *   sequence "append before bind" manually. It is NOT a general-purpose
   *   lifecycle abstraction; prefer the default `"call"` from inside a
   *   framework's mounted lifecycle hook whenever you have one.
   *
   *   Implementation detail: connection is detected via a `MutationObserver`
   *   on the top-level `document`. `MutationObserver` does NOT traverse
   *   shadow roots — a target appended into another element's shadow tree
   *   becomes `isConnected === true` without firing the observer, so the
   *   deferred sync never runs. Adapters that hold a direct ref to the
   *   target (via a framework lifecycle hook, e.g. React `useEffect`,
   *   Vue `onMounted`, Stencil `componentDidLoad`, or a custom element's
   *   own `connectedCallback`) SHOULD call `bind()` with the default
   *   `syncOn: "call"` from inside that hook rather than relying on
   *   `syncOn: "connect"`. See SPEC.md § Deferring the Initial Sync Until
   *   Connection.
   */
  syncOn?: "call" | "connect";
}

// DOM globals are accessed through these locals so that the module
// imports cleanly in headless runtimes (Node, Deno, Workers) where
// `HTMLElement` / `document` / `MutationObserver` are not defined as
// globals. When any of them is undefined, the `syncOn: "connect"` path
// silently falls back to the synchronous `"call"` path.
const HTMLElementCtor: typeof HTMLElement | undefined =
  typeof HTMLElement !== "undefined" ? HTMLElement : undefined;
const documentRef: Document | undefined =
  typeof document !== "undefined" ? document : undefined;
const MutationObserverCtor: typeof MutationObserver | undefined =
  typeof MutationObserver !== "undefined" ? MutationObserver : undefined;

export function bind(
  target: unknown,
  onUpdate: (name: string, value: unknown) => void,
  options?: BindOptions,
): UnbindFn {
  // Discovery performs the full schema validation (descriptor shapes,
  // name-uniqueness within properties/inputs/commands). A declaration that
  // survives this check is safe to bind without further validation here —
  // there is no path where isWcBindable() returns true but bind() silently
  // no-ops on the same target.
  const decl = getWcBindableDeclaration(target);
  if (decl === undefined) return () => {};
  // After the discovery guard, `target` is known to expose
  // addEventListener / removeEventListener (the helper's EventTarget
  // capability check), so the assertion below is safe — narrowing
  // `unknown` to EventTarget without re-checking.
  const et = target as EventTarget;

  const { properties } = decl;
  const cleanups: (() => void)[] = [];
  let disposed = false;

  for (const prop of properties) {
    const getter = prop.getter ?? DEFAULT_GETTER;
    const handler = (event: Event) => onUpdate(prop.name, getter(event));
    et.addEventListener(prop.event, handler);
    cleanups.push(() => et.removeEventListener(prop.event, handler));
  }

  // initialSync may throw if:
  //   - a property's `name in target` trap (e.g. on a Proxy) throws,
  //   - reading `target[prop.name]` invokes a getter that throws, or
  //   - the consumer's `onUpdate` callback throws.
  // If we don't catch it here, the listeners attached above leak — the
  // caller never receives the unbind function. Catch, tear down every
  // resource installed so far, and rethrow so the caller sees the error.
  const initialSync = () => {
    if (disposed) return;
    for (const prop of properties) {
      // Use `in` so that a property whose current value is `undefined` is
      // still observable on first sync — distinguishing "value is undefined"
      // from "property is not exposed on the target".
      if (prop.name in et) {
        const current = (et as unknown as Record<string, unknown>)[prop.name];
        onUpdate(prop.name, current);
      }
    }
  };

  const runOrCleanup = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      disposed = true;
      cleanups.forEach((c) => {
        try { c(); } catch { /* swallow secondary errors during cleanup */ }
      });
      throw err;
    }
  };

  const syncOn = options?.syncOn ?? "call";
  // A declaration with empty `properties` has nothing to initial-sync, so
  // there is no work the deferred path could meaningfully do — short-
  // circuiting here keeps the "empty properties returns a real no-op
  // cleanup" promise from § Property Descriptor even under syncOn:"connect".
  // Without this, we would install a document-wide MutationObserver whose
  // callback only ever runs an empty loop, and the returned cleanup would
  // include the observer.disconnect() — i.e. NOT a no-op.
  const canDefer =
    syncOn === "connect" &&
    properties.length > 0 &&
    HTMLElementCtor !== undefined &&
    et instanceof HTMLElementCtor &&
    !et.isConnected &&
    documentRef !== undefined &&
    MutationObserverCtor !== undefined;

  if (canDefer) {
    // Observe document mutations until the target becomes connected, then
    // run the initial sync once. The observer is also torn down by unbind().
    // NOTE: MutationObserver does not traverse shadow roots; see
    // BindOptions.syncOn JSDoc.
    // Deferred initialSync errors are routed through runOrCleanup so the
    // listener set installed by bind() is torn down before the error
    // surfaces — same contract as the synchronous path.
    const htmlTarget = et as HTMLElement;
    const observer = new MutationObserverCtor(() => {
      if (htmlTarget.isConnected) {
        observer.disconnect();
        runOrCleanup(initialSync);
      }
    });
    observer.observe(documentRef, { childList: true, subtree: true });
    cleanups.push(() => observer.disconnect());
  } else {
    runOrCleanup(initialSync);
  }

  return () => {
    // Exception-safe teardown: every cleanup runs, even if an earlier one
    // throws. Without this, a Proxy-wrapped removeEventListener or an
    // overridden observer.disconnect() that throws would prevent the
    // remaining listeners from being removed — directly contradicting the
    // teardown contract's "MUST remove every listener" rule. Secondary
    // errors are swallowed (logged-by-runtime via the dispatch path on
    // re-throw would be misleading here; this is best-effort teardown,
    // not error reporting). This mirrors the synchronous-throw cleanup
    // path used by runOrCleanup above.
    disposed = true;
    for (const fn of cleanups) {
      try { fn(); } catch { /* swallow per teardown-contract semantics */ }
    }
  };
}
