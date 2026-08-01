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
 * source of truth for "is this target protocol-valid / bindable" —
 * `isWcBindable()` is exactly `getWcBindableDeclaration(target) !== undefined`,
 * and no declaration that survives this filter will silently no-op inside
 * `bind()`. "Protocol-valid / bindable" is NOT a security predicate: a
 * declaration that passes this check can still carry a `getter` that runs
 * in the consumer's JS context, and discovery itself performs JS property
 * access on the target (Proxy traps / accessor side effects fire). See
 * SPEC.md § Trust Boundaries and § Protocol Model and Assumptions →
 * Trust model for the threat-model statement.
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
  // MUST NOT throw on ANY input shape — not only hostile Proxy targets
  // whose `get` traps throw on `target` property access, but also hostile
  // declaration / descriptor objects whose getters throw (e.g. a Proxy
  // `wcBindable` whose `protocol` getter raises, a Proxy property
  // descriptor whose `name` getter raises). The whole body therefore
  // lives inside a single try/catch — any thrown access during
  // validation funnels to the same `return undefined`.
  try {
    if (target === null || (typeof target !== "object" && typeof target !== "function")) {
      return undefined;
    }
    const addListener = (target as { addEventListener?: unknown }).addEventListener;
    const removeListener = (target as { removeEventListener?: unknown }).removeEventListener;
    const ctor = (target as { constructor?: { wcBindable?: WcBindableDeclaration } }).constructor;
    const decl = ctor?.wcBindable;

    // SPEC.md § Overview pins EventTarget as the minimum consumer-side
    // capability. Reject targets that satisfy the declaration schema but
    // cannot actually be bound to — without this, `bind()` would throw
    // on `addEventListener` later, defeating the "discovery == bindability"
    // contract.
    if (typeof addListener !== "function" || typeof removeListener !== "function") return undefined;
    if (decl?.protocol !== "wc-bindable") return undefined;
    if (typeof decl.version !== "number" || !Number.isInteger(decl.version)) return undefined;
    if (decl.version < MIN_COMPATIBLE_VERSION) return undefined;
    if (!Array.isArray(decl.properties)) return undefined;
    if (!isValidNamedList(decl.properties, isValidPropertyDescriptor)) return undefined;
    if (decl.inputs !== undefined && !isValidNamedList(decl.inputs, isValidInputDescriptor)) return undefined;
    if (decl.commands !== undefined && !isValidNamedList(decl.commands, isValidCommandDescriptor)) return undefined;

    return decl;
  } catch {
    return undefined;
  }
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
   *
   * - `"define"`: when discovery fails **and** `target` is an element whose
   *   tag name contains a `-` (i.e. it may still be an un-upgraded custom
   *   element), defer discovery, listener registration, and the initial
   *   sync until `customElements.whenDefined(tagName)` resolves, then
   *   register exactly as `"call"` would. When discovery already succeeds,
   *   `"define"` is indistinguishable from `"call"` — same synchronous
   *   frame, same ordering. This is the option that distinguishes "this
   *   target is not wc-bindable" from "this custom element has not
   *   upgraded yet"; without it both collapse into the same silent no-op
   *   cleanup. See SPEC.md § Deferring Discovery Until Definition.
   *
   * The two deferrals are independent and compose, so `syncOn` also
   * accepts an **array** of modes:
   *
   * ```ts
   * bind(el, onUpdate, { syncOn: ["define", "connect"] })
   * ```
   *
   * waits for the definition, then — once the declaration is readable —
   * still defers the initial-value read until the element is connected.
   * That is the correct combination for an imperative binder whose caller
   * hands it a detached element built from a definition that may not have
   * loaded yet. Order within the array is irrelevant; discovery always
   * precedes the initial sync. `"call"` in an array is inert (it names the
   * absence of a deferral), and unrecognized entries are ignored the same
   * way an unrecognized bare string is.
   */
  syncOn?: SyncOnMode | SyncOnMode[];
}

/** A single `BindOptions.syncOn` mode. See {@link BindOptions.syncOn}. */
export type SyncOnMode = "call" | "connect" | "define";

/**
 * Does the caller's `syncOn` request `mode`?
 *
 * Accepts the bare-string and array forms, and — like every other input
 * `bind()` takes — MUST NOT throw on a malformed value: an unrecognized
 * string, an array holding unrecognized entries, a non-string non-array,
 * and a `Proxy`-wrapped array whose index reads throw all resolve to
 * "this mode was not requested", i.e. the `"call"` default. See SPEC.md
 * § Deferring the Initial Sync Until Connection (unknown-value rule).
 */
function wantsSyncMode(options: BindOptions | undefined, mode: SyncOnMode): boolean {
  const syncOn = options?.syncOn;
  if (syncOn === mode) return true;
  if (!Array.isArray(syncOn)) return false;
  try {
    return syncOn.includes(mode);
  } catch {
    return false;
  }
}

// DOM globals are accessed through these locals so that the module
// imports cleanly in headless runtimes (Node, Deno, Workers) where
// `HTMLElement` / `document` / `MutationObserver` / `customElements` are
// not defined as globals. When any of them is undefined, the
// `syncOn: "connect"` and `syncOn: "define"` paths silently fall back to
// the synchronous `"call"` path.
const HTMLElementCtor: typeof HTMLElement | undefined =
  typeof HTMLElement !== "undefined" ? HTMLElement : undefined;
const documentRef: Document | undefined =
  typeof document !== "undefined" ? document : undefined;
const MutationObserverCtor: typeof MutationObserver | undefined =
  typeof MutationObserver !== "undefined" ? MutationObserver : undefined;
const customElementsRef: CustomElementRegistry | undefined =
  typeof customElements !== "undefined" ? customElements : undefined;

/**
 * Return the tag name to wait on when discovery failed but `target` may
 * still be an un-upgraded custom element, or `undefined` when there is
 * nothing to wait for.
 *
 * The gate is deliberately narrow — a `-` in the tag name is the only
 * signal the platform gives us before upgrade, and it is exactly the
 * condition under which `customElements.whenDefined()` could ever resolve.
 * A dashless element, a synthetic `EventTarget`, a plain object, `null`,
 * and a runtime without `customElements` all return `undefined` so the
 * caller falls straight through to the historical no-op.
 *
 * Like the discovery helper, this MUST NOT throw on any input shape: a
 * hostile `Proxy` can raise from the `instanceof` (`Symbol.hasInstance`)
 * check or from the `localName` read, so the whole body is wrapped.
 */
function pendingCustomElementTag(target: unknown): string | undefined {
  if (customElementsRef === undefined || HTMLElementCtor === undefined) return undefined;
  try {
    if (!(target instanceof HTMLElementCtor)) return undefined;
    // `localName` (not `tagName`) because custom element names are always
    // lowercase while `tagName` is upper-cased for HTML elements, and
    // `whenDefined()` matches on the lowercase name.
    const tag = target.localName;
    if (typeof tag !== "string" || !tag.includes("-")) return undefined;
    return tag;
  } catch {
    return undefined;
  }
}

export function bind(
  target: unknown,
  onUpdate: (name: string, value: unknown) => void,
  options?: BindOptions,
): UnbindFn {
  // Programmer error: a non-function onUpdate cannot be reached for an
  // empty-properties target (no event would ever fire it), so defer-and-let-
  // it-throw would silently accept the bug. Reject it synchronously here.
  // See SPEC.md § onUpdate validity.
  if (typeof onUpdate !== "function") {
    throw new TypeError("bind: onUpdate must be a function");
  }
  // Discovery performs the full schema validation (descriptor shapes,
  // name-uniqueness within properties/inputs/commands). A declaration that
  // survives this check is protocol-valid and accepted by bind() without
  // further validation here — there is no path where isWcBindable() returns
  // true but bind() silently no-ops on the same target. "Protocol-valid"
  // is not a security predicate (see SPEC.md § Trust Boundaries).
  const decl = getWcBindableDeclaration(target);
  if (decl !== undefined) return bindDeclared(target, decl, onUpdate, options);

  // Discovery failed. Under the default `"call"` (and under `"connect"`
  // alone, and under any unrecognized value per the unknown-syncOn
  // fallback) that is terminal — return the historical no-op. Only
  // `"define"` asks us to distinguish "not bindable" from "not upgraded
  // yet".
  if (!wantsSyncMode(options, "define")) return () => {};
  const tag = pendingCustomElementTag(target);
  if (tag === undefined) return () => {};
  return bindWhenDefined(target, tag, onUpdate, options);
}

/**
 * Pending `syncOn: "define"` waits, grouped by tag name.
 *
 * `customElements.whenDefined()` exposes no cancellation affordance, and a
 * promise reaction pins everything it closes over until the promise
 * settles — so attaching one reaction per `bind()` call would keep every
 * cancelled bind's `target` alive until the tag is defined, and *forever*
 * for a tag that never is. Under mount / unmount churn against a tag that
 * never arrives (a typo, a code-split chunk that failed to load) that is
 * an unbounded leak, which is not an acceptable cost to impose on a bind
 * that the caller already tore down.
 *
 * So the reaction is attached **once per tag name**, and each pending bind
 * is an entry in that tag's waiter set which its own cleanup removes. A
 * cancelled wait therefore releases its `target` immediately.
 *
 * The map entry is deliberately **not** deleted when its set becomes
 * empty: keeping it is what lets the next `bind()` on the same tag reuse
 * the single existing reaction instead of attaching another one, which is
 * exactly the churn case above. The residual cost is one empty `Set` per
 * distinct never-defined tag name — bounded by the number of tag names,
 * not by the number of binds. Once a tag *is* defined the entry is dropped
 * entirely.
 */
const definitionWaiters = new Map<string, Set<() => void>>();

/**
 * Register `waiter` to run when `tag` is defined. Returns `false` when no
 * wait could be armed (a non-conformant registry whose `whenDefined()`
 * throws synchronously instead of returning a rejected promise), in which
 * case the caller falls back to the no-op cleanup.
 */
function addDefinitionWaiter(tag: string, waiter: () => void): boolean {
  const existing = definitionWaiters.get(tag);
  if (existing !== undefined) {
    existing.add(waiter);
    return true;
  }

  let pending: Promise<unknown>;
  try {
    pending = customElementsRef!.whenDefined(tag);
  } catch {
    // A registry whose whenDefined() throws synchronously is non-conformant
    // (the DOM spec mandates a rejected promise), but bind()'s MUST-NOT-
    // throw-on-invalid-input posture applies here too.
    return false;
  }

  const waiters = new Set<() => void>([waiter]);
  definitionWaiters.set(tag, waiters);
  pending.then(
    () => {
      // Drop the entry before running anything: a waiter's own initial sync
      // can re-enter bind() for the same tag, and that call must arm a
      // fresh wait rather than join a set that is already draining.
      definitionWaiters.delete(tag);
      for (const w of [...waiters]) {
        // Re-checked per iteration because an earlier waiter's onUpdate may
        // have unbound a later one.
        if (!waiters.has(w)) continue;
        try {
          w();
        } catch (err) {
          // Each bind is independent: one bind's registration throw MUST
          // NOT stop the sibling binds on the same tag from registering.
          // Re-raising on a fresh unhandled rejection preserves the
          // reporting channel documented in SPEC.md § Teardown Contract
          // while keeping the loop going — which is what a
          // reaction-per-bind implementation would have done anyway.
          void Promise.reject(err);
        }
      }
    },
    () => {
      // Not a valid custom element name — the reserved hyphenated names
      // (`font-face`, `annotation-xml`, `missing-glyph`, …) pass the `-`
      // gate yet can never be defined, and the registry rejects with a
      // SyntaxError the consumer cannot act on. Absorb it and drop the
      // waiters; nothing will ever run them.
      //
      // Note this is the SECOND argument to .then(), not a trailing
      // .catch(): a throw escaping the fulfillment handler above must stay
      // observable, and a .catch() here would swallow it too.
      definitionWaiters.delete(tag);
    },
  );
  return true;
}

/**
 * `syncOn: "define"` deferral. Waits for `customElements.whenDefined(tag)`,
 * re-runs discovery against the (now upgraded) target, and — if it is
 * bindable — hands off to the ordinary `bindDeclared()` path.
 *
 * The cleanup returned here is safe to call while the wait is pending: it
 * cancels the pending work, registers nothing even if the tag is defined
 * later, and releases the target (see `definitionWaiters`).
 */
function bindWhenDefined(
  target: unknown,
  tag: string,
  onUpdate: (name: string, value: unknown) => void,
  options?: BindOptions,
): UnbindFn {
  let disposed = false;
  let inner: UnbindFn | undefined;

  const waiter = () => {
    if (disposed) return;
    // `define()` upgrades elements that are already in a document, but a
    // detached element is only upgraded on insertion. Ask for it
    // explicitly so the "create imperatively → bind → append later"
    // pattern is not silently excluded. On an already-upgraded element
    // this is a no-op.
    try {
      customElementsRef!.upgrade?.(target as Node);
    } catch {
      /* non-conformant / minimal registry — fall through to discovery */
    }
    const decl = getWcBindableDeclaration(target);
    // Defined, but not wc-bindable after all: this is case 1 from
    // SPEC.md § Deferring Discovery Until Definition, arrived at one
    // microtask late. Register nothing, exactly as the synchronous
    // discovery failure would have.
    if (decl === undefined) return;
    try {
      inner = bindDeclared(target, decl, onUpdate, options);
      // Unlike the synchronous path, the caller ALREADY holds this
      // closure's unbind function while the deferred initial sync runs —
      // so an `onUpdate` that tears itself down re-enters the cleanup
      // below at a moment when `inner` is still unassigned, and would
      // otherwise leave the listeners bindDeclared() just installed
      // attached forever. Re-check the flag once bindDeclared() returns
      // and honour the disposal that happened underneath it. (The
      // `syncOn: "connect"` path has no equivalent hole: its listeners
      // are already in the shared cleanup list before the deferred sync
      // runs.)
      if (disposed) {
        const late = inner;
        inner = undefined;
        late();
      }
    } catch (err) {
      // bindDeclared() already tore down everything it installed. Mark
      // this closure disposed so the caller's later unbind() is a literal
      // no-op, mirroring the deferred-throw rule in § Teardown Contract.
      disposed = true;
      throw err;
    }
  };

  if (!addDefinitionWaiter(tag, waiter)) return () => {};

  return () => {
    if (disposed) return;
    disposed = true;
    // Drop out of the tag's waiter set so a cancelled wait stops retaining
    // `target` — the whole reason the waits are pooled per tag.
    definitionWaiters.get(tag)?.delete(waiter);
    inner?.();
  };
}

function bindDeclared(
  target: unknown,
  decl: WcBindableDeclaration,
  onUpdate: (name: string, value: unknown) => void,
  options?: BindOptions,
): UnbindFn {
  // After the discovery guard, `target` is known to expose
  // addEventListener / removeEventListener (the helper's EventTarget
  // capability check), so the assertion below is safe — narrowing
  // `unknown` to EventTarget without re-checking.
  const et = target as EventTarget;

  const { properties } = decl;
  const cleanups: (() => void)[] = [];
  let disposed = false;

  // Run an arbitrary function and, if it throws, tear down every cleanup
  // installed so far before rethrowing. Used to wrap BOTH the listener
  // registration loop (a `Proxy`-wrapped addEventListener can throw via
  // a `get` trap on the registry method — see SPEC.md § Overview, which
  // permits relay / Proxy wrappers as valid bind targets) AND the
  // synchronous initial-sync pass (a property's `in` trap, a getter, or
  // the consumer's `onUpdate` callback can throw). Without this wrapper,
  // a throw at registration leaves N-1 listeners attached without ever
  // returning the unbind function to the caller — a permanent leak.
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

  runOrCleanup(() => {
    for (const prop of properties) {
      const getter = prop.getter ?? DEFAULT_GETTER;
      const handler = (event: Event) => onUpdate(prop.name, getter(event));
      et.addEventListener(prop.event, handler);
      cleanups.push(() => et.removeEventListener(prop.event, handler));
    }
  });

  // initialSync may throw if:
  //   - a property's `name in target` trap (e.g. on a Proxy) throws,
  //   - reading `target[prop.name]` invokes a getter that throws, or
  //   - the consumer's `onUpdate` callback throws.
  // Wrapped in the same runOrCleanup as the registration loop above so
  // listeners and any deferred-sync observer are torn down before the
  // error reaches the caller.
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

  // A declaration with empty `properties` has nothing to initial-sync, so
  // there is no work the deferred path could meaningfully do — short-
  // circuiting here keeps the "empty properties returns a real no-op
  // cleanup" promise from § Property Descriptor even under syncOn:"connect".
  // Without this, we would install a document-wide MutationObserver whose
  // callback only ever runs an empty loop, and the returned cleanup would
  // include the observer.disconnect() — i.e. NOT a no-op.
  //
  // Reached both from bind() directly and from the deferred-discovery path,
  // which forwards the caller's original options — so `["define",
  // "connect"]` still defers the initial sync here after the definition
  // arrives.
  const canDefer =
    wantsSyncMode(options, "connect") &&
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
    // surfaces — same contract as the synchronous path. The observer
    // *setup* (constructor + observe()) is ALSO wrapped in runOrCleanup
    // because § Teardown Contract explicitly names "the deferred-sync
    // observer's setup" as an install-time throw the cleanup MUST cover;
    // a hostile MutationObserverCtor / observe() that throws would
    // otherwise leak the listeners attached by the registration loop.
    const htmlTarget = et as HTMLElement;
    // Single-path observer disposal: the callback's success path and the
    // unbind cleanup path both go through `disposeObserver`, which guards
    // against double-disconnect via its own `observerDisposed` flag. This
    // matters for a hostile / counting `observer.disconnect()` override —
    // SPEC.md § Teardown Contract names that exact threat as in-scope.
    // `observer` is declared as a `let` so disposeObserver can be pushed
    // to `cleanups` BEFORE the (possibly-throwing) constructor+observe
    // pair; the optional chain on `observer?.disconnect()` makes the
    // helper a safe no-op in the "pushed but not yet assigned" window.
    let observer: MutationObserver | undefined;
    let observerDisposed = false;
    const disposeObserver = () => {
      if (observerDisposed) return;
      observerDisposed = true;
      observer?.disconnect();
    };
    cleanups.push(disposeObserver);
    runOrCleanup(() => {
      observer = new MutationObserverCtor(() => {
        if (htmlTarget.isConnected) {
          disposeObserver();
          runOrCleanup(initialSync);
        }
      });
      observer.observe(documentRef, { childList: true, subtree: true });
    });
  } else {
    runOrCleanup(initialSync);
  }

  return () => {
    // Idempotent teardown: the second and later invocations are an
    // unconditional no-op, satisfying SPEC.md § Teardown Contract's
    // "MUST be a safe no-op on subsequent calls" rule without depending
    // on the constituent cleanups themselves being idempotent. This is
    // symmetric with the registration-side defensive posture (we wrap
    // the addEventListener loop in runOrCleanup precisely because a
    // hostile Proxy can throw mid-loop — by the same logic, a hostile
    // Proxy whose removeEventListener is non-idempotent must not be
    // called twice).
    if (disposed) return;
    disposed = true;
    // Exception-safe teardown: every cleanup runs, even if an earlier one
    // throws. Secondary errors are swallowed — this is best-effort
    // teardown, not error reporting; surfacing a cleanup-time secondary
    // error in place of the caller's expected silent unbind is more
    // confusing than useful. Same shape as the runOrCleanup fallback
    // above.
    for (const fn of cleanups) {
      try { fn(); } catch { /* swallow per teardown-contract semantics */ }
    }
  };
}
