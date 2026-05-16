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

export interface WcBindableElement extends EventTarget {
  constructor: WcBindableConstructor;
}

/** Minimum protocol version this adapter understands. */
export const SUPPORTED_PROTOCOL_VERSION = 1;

const DEFAULT_GETTER = (e: Event): unknown => (e as CustomEvent).detail;

export function isWcBindable(target: EventTarget): target is WcBindableElement {
  const decl = (target.constructor as { wcBindable?: WcBindableDeclaration }).wcBindable;
  if (decl?.protocol !== "wc-bindable") return false;
  // Forward-compatible version check: accept any integer >= the adapter's
  // supported version. Future versions are required by the spec to remain
  // backward-compatible at the `properties` binding contract level, and to
  // express new functionality via fields that older adapters ignore.
  return (
    typeof decl.version === "number" &&
    Number.isInteger(decl.version) &&
    decl.version >= SUPPORTED_PROTOCOL_VERSION
  );
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
   *   like `"call"`. Useful when `bind()` is called before
   *   `appendChild()` / `customElement.upgrade()` so the read sees the
   *   post-connection state.
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
  target: EventTarget,
  onUpdate: (name: string, value: unknown) => void,
  options?: BindOptions,
): UnbindFn {
  if (!isWcBindable(target)) return () => {};

  const { properties } = target.constructor.wcBindable;
  const cleanups: (() => void)[] = [];
  let disposed = false;

  for (const prop of properties) {
    const getter = prop.getter ?? DEFAULT_GETTER;
    const handler = (event: Event) => onUpdate(prop.name, getter(event));
    target.addEventListener(prop.event, handler);
    cleanups.push(() => target.removeEventListener(prop.event, handler));
  }

  const initialSync = () => {
    if (disposed) return;
    for (const prop of properties) {
      // Use `in` so that a property whose current value is `undefined` is
      // still observable on first sync — distinguishing "value is undefined"
      // from "property is not exposed on the target".
      if (prop.name in (target as object)) {
        const current = (target as unknown as Record<string, unknown>)[prop.name];
        onUpdate(prop.name, current);
      }
    }
  };

  const syncOn = options?.syncOn ?? "call";
  const canDefer =
    syncOn === "connect" &&
    HTMLElementCtor !== undefined &&
    target instanceof HTMLElementCtor &&
    !target.isConnected &&
    documentRef !== undefined &&
    MutationObserverCtor !== undefined;

  if (canDefer) {
    // Observe document mutations until the target becomes connected, then
    // run the initial sync once. The observer is also torn down by unbind().
    // NOTE: MutationObserver does not traverse shadow roots; see
    // BindOptions.syncOn JSDoc.
    const observer = new MutationObserverCtor(() => {
      if ((target as HTMLElement).isConnected) {
        observer.disconnect();
        initialSync();
      }
    });
    observer.observe(documentRef, { childList: true, subtree: true });
    cleanups.push(() => observer.disconnect());
  } else {
    initialSync();
  }

  return () => {
    disposed = true;
    cleanups.forEach((fn) => fn());
  };
}
