import { createSignal, onCleanup } from "solid-js";
import { bind, isWcBindable } from "@wc-bindable/core";

export function useWcBindable(
  el: HTMLElement,
  initialValues: Record<string, unknown> = {},
) {
  const [values, setValues] = createSignal<Record<string, unknown>>({ ...initialValues });

  let unbind: (() => void) | undefined;

  if (isWcBindable(el)) {
    unbind = bind(el, (name, value) => {
      setValues((prev) => ({ ...prev, [name]: value }));
    });
  }

  onCleanup(() => unbind?.());

  return values;
}
