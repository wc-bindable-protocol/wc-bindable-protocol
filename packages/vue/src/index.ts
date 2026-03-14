import { ref, onMounted, onUnmounted, reactive } from "vue";
import type { Ref } from "vue";
import { bind, isWcBindable } from "@wc-bindable/core";

export function useWcBindable<
  T extends HTMLElement,
  V extends Record<string, unknown> = Record<string, unknown>,
>(initialValues: Partial<V> = {}): { ref: Ref<T | null>; values: V } {
  const templateRef = ref<T | null>(null) as Ref<T | null>;
  const values = reactive<V>({ ...initialValues } as V);

  let unbind: (() => void) | undefined;

  onMounted(() => {
    const el = templateRef.value;
    if (!el || !isWcBindable(el)) return;

    unbind = bind(el, (name, value) => {
      values[name] = value;
    });
  });

  onUnmounted(() => {
    unbind?.();
  });

  return { ref: templateRef, values };
}
