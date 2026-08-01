import { createSignal, onCleanup, type Accessor } from "solid-js";
import { bind, type BindOptions } from "@wc-bindable/core";

export interface WcBindableOptions {
  /**
   * Forwarded to `bind()`. Defaults to `"define"` so an element whose
   * definition arrives after the directive runs still binds — see SPEC.md
   * § Deferring Discovery Until Definition. Pass `"call"` to opt back into
   * the historical behavior, where a not-yet-upgraded element is skipped
   * permanently.
   */
  syncOn?: BindOptions["syncOn"];
}

export type WcBindableDirective = (
  el: HTMLElement,
  accessor: Accessor<(name: string, value: unknown) => void>,
  options?: WcBindableOptions,
) => void;

export const wcBindable: WcBindableDirective = (el, accessor, options = {}) => {
  // No `isWcBindable()` gate: bind() already returns a no-op cleanup for a
  // non-bindable target, and the gate is precisely what defeated
  // `syncOn: "define"` — it fails for a not-yet-upgraded custom element,
  // and the directive body does not run again to notice the upgrade.
  const unbind = bind(el, (name, value) => {
    accessor()(name, value);
  }, { syncOn: options.syncOn ?? "define" });

  onCleanup(unbind);
};

export function createWcBindable<
  V extends object = Record<string, unknown>,
>(initialValues: Partial<V> = {}, options: WcBindableOptions = {}) {
  const [values, setValues] = createSignal<V>(initialValues as V);

  const directive = (el: HTMLElement) => {
    wcBindable(el, () => (name, value) => {
      setValues((prev) => ({ ...prev, [name]: value }));
    }, options);
  };

  return [values, directive] as const;
}
