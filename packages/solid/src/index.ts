import { createSignal, onCleanup, type Accessor } from "solid-js";
import { bind, isWcBindable } from "@wc-bindable/core";

export type WcBindableDirective = (
  el: HTMLElement,
  accessor: Accessor<(name: string, value: unknown) => void>,
) => void;

export const wcBindable: WcBindableDirective = (el, accessor) => {
  if (!isWcBindable(el)) return;

  const unbind = bind(el, (name, value) => {
    accessor()(name, value);
  });

  onCleanup(unbind);
};

export function createWcBindable() {
  const [values, setValues] = createSignal<Record<string, unknown>>({});

  const directive = (el: HTMLElement) => {
    wcBindable(el, () => (name, value) => {
      setValues((prev) => ({ ...prev, [name]: value }));
    });
  };

  return [values, directive] as const;
}
