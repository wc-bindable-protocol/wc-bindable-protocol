import { bind, type BindOptions } from "@wc-bindable/core";

export type UnbindFn = () => void;
export type OnUpdate = (name: string, value: unknown) => void;

export interface WcBindableOptions {
  /**
   * Forwarded to `bind()`. Defaults to `"define"` so an element whose
   * definition arrives after this call still binds — see SPEC.md
   * § Deferring Discovery Until Definition. Pass `"call"` to opt back into
   * the historical behavior, where a not-yet-upgraded element is skipped
   * permanently.
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

export interface CreateWcBindableOptions extends WcBindableOptions {
  update?: () => void;
}

export interface WcBindableBinder<V extends object> {
  readonly values: V;
  bind(el: Element): void;
  unbind(): void;
}

export function createWcBindable<V extends object = Record<string, unknown>>(
  initialValues: Partial<V> = {},
  options: CreateWcBindableOptions = {},
): WcBindableBinder<V> {
  const state = { ...(initialValues as V) };
  const update = options.update ?? (() => {});
  let unbindFn: UnbindFn | null = null;

  return {
    get values() {
      return state;
    },
    bind(el) {
      if (unbindFn) {
        unbindFn();
        unbindFn = null;
      }
      unbindFn = bind(el, (name, value) => {
        (state as Record<string, unknown>)[name] = value;
        update();
      }, { syncOn: options.syncOn ?? "define" });
    },
    unbind() {
      if (unbindFn) {
        unbindFn();
        unbindFn = null;
      }
    },
  };
}
