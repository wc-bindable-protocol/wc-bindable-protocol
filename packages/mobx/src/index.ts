import { observable, runInAction, set } from "mobx";
import { bind, type BindOptions } from "@wc-bindable/core";

export type UnbindFn = () => void;
export type OnUpdate = (name: string, value: unknown) => void;

export interface WcBindableOptions {
  /**
   * Forwarded to `bind()`. Note the two different defaults: `wcBindable()`
   * uses `"define"`, while `createWcBindable().bind()` uses
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

export type WcBindableState<V extends object> = V;

export interface WcBindableBinder<V extends object> {
  readonly state: WcBindableState<V>;
  bind(el: Element): void;
  unbind(): void;
}

export function createWcBindable<V extends object = Record<string, unknown>>(
  initialValues: Partial<V> = {},
  options: WcBindableOptions = {},
): WcBindableBinder<V> {
  // deep: false keeps the wc-bindable contract "values are passed as-is" — MobX's
  // default deep enhancer would wrap assigned arrays/objects in observable proxies
  // and break reference identity for consumers.
  const state = observable(
    { ...(initialValues as object) } as Record<string, unknown>,
    {},
    { deep: false },
  );

  let unbindFn: UnbindFn | null = null;

  return {
    get state() {
      return state as unknown as WcBindableState<V>;
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
      //     after appendChild() manually.
      // The `isWcBindable()` gate is gone for the same reason: it ran
      // before "define" could ever help.
      unbindFn = bind(el, (name, value) => {
        runInAction(() => {
          set(state, name, value);
        });
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
