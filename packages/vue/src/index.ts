import { ref, onMounted, onUnmounted, reactive } from "vue";
import type { Ref } from "vue";
import { bind, type BindOptions } from "@wc-bindable/core";

export interface UseWcBindableOptions {
  /**
   * Forwarded to `bind()`. Defaults to `"define"` so an element whose
   * definition arrives after this component mounts still binds — see
   * SPEC.md § Deferring Discovery Until Definition. Pass `"call"` to opt
   * back into the historical behavior, where a not-yet-upgraded element is
   * skipped permanently.
   */
  syncOn?: BindOptions["syncOn"];
}

export function useWcBindable<
  T extends HTMLElement,
  V extends object = Record<string, unknown>,
>(
  initialValues: Partial<V> = {},
  options: UseWcBindableOptions = {},
): { ref: Ref<T | null>; values: V } {
  const templateRef = ref<T | null>(null) as Ref<T | null>;
  const values = reactive<V>({ ...initialValues } as V);

  let unbind: (() => void) | undefined;

  onMounted(() => {
    const el = templateRef.value;
    if (!el) return;

    // No `isWcBindable()` gate: bind() already returns a no-op cleanup for
    // a non-bindable target, and the gate is precisely what defeated
    // `syncOn: "define"` — it fails for a not-yet-upgraded custom element,
    // and onMounted does not run again to notice the upgrade.
    unbind = bind(el, (name, value) => {
      (values as Record<string, unknown>)[name] = value;
    }, { syncOn: options.syncOn ?? "define" });
  });

  onUnmounted(() => {
    unbind?.();
  });

  return { ref: templateRef, values: values as V };
}
