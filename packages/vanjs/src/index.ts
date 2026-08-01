import van, { type State } from "vanjs-core";
import { bind, type BindOptions } from "@wc-bindable/core";

export type UnbindFn = () => void;
export type OnUpdate = (name: string, value: unknown) => void;

export interface WcBindableOptions {
  /**
   * Forwarded to `bind()`. See the per-function defaults: `wcBindable()`
   * defaults to `"define"`, while `createWcBindable().bind()` defaults to
   * `["define", "connect"]` because it is handed a detached element. Pass
   * `"call"` to opt back into the historical synchronous behavior.
   */
  syncOn?: BindOptions["syncOn"];
}

export function wcBindable(
  el: Element,
  onUpdate: OnUpdate,
  options: WcBindableOptions = {},
): UnbindFn {
  // No `isWcBindable()` gate: bind() already returns a no-op cleanup for a
  // non-bindable target, and the gate is precisely what defeated
  // `syncOn: "define"` — it fails for a not-yet-upgraded custom element,
  // and nothing re-runs this call on upgrade.
  return bind(el, onUpdate, { syncOn: options.syncOn ?? "define" });
}

export type WcBindableStates<V extends object> = {
  [K in keyof V]: State<V[K]>;
};

export interface WcBindableBinder<V extends object> {
  readonly states: WcBindableStates<V>;
  bind(el: Element): void;
  unbind(): void;
}

export function createWcBindable<V extends object = Record<string, unknown>>(
  initialValues: Partial<V> = {},
  options: WcBindableOptions = {},
): WcBindableBinder<V> {
  const states = {} as Record<string, State<unknown>>;
  for (const key of Object.keys(initialValues) as (keyof V)[]) {
    states[key as string] = van.state(
      (initialValues as Record<string, unknown>)[key as string],
    );
  }

  let unbindFn: UnbindFn | null = null;

  return {
    get states() {
      return states as WcBindableStates<V>;
    },
    bind(el) {
      if (unbindFn) {
        unbindFn();
        unbindFn = null;
      }
      // syncOn: ["define", "connect"] because this binder is handed a
      // detached element built from a definition that may not have loaded
      // yet, and both deferrals are needed:
      //   - "define" so a not-yet-upgraded element is not skipped
      //     permanently. Without it, the discovery gate fails and nothing
      //     re-runs when the definition arrives.
      //   - "connect" so the initial-value read still happens after the
      //     element is attached, and users do not have to sequence bind()
      //     after van.add() manually.
      // The `isWcBindable()` gate is gone for the same reason: it ran
      // before "define" could ever help.
      unbindFn = bind(el, (name, value) => {
        const existing = states[name];
        if (existing) {
          existing.val = value;
        } else {
          states[name] = van.state(value);
        }
      }, { syncOn: options.syncOn ?? ["define", "connect"] });
    },
    unbind() {
      if (unbindFn) {
        unbindFn();
        unbindFn = null;
      }
    },
  };
}
