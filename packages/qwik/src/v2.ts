import { useSignal, useStore, type Signal } from "@qwik.dev/core";
import {
  useVisibleTaskQrl,
  inlinedQrl,
  type TaskFn,
} from "@qwik.dev/core/internal";
import { bind, type BindOptions } from "@wc-bindable/core";

export interface UseWcBindableOptions {
  /**
   * Forwarded to `bind()`. Defaults to `"define"` so an element whose
   * definition arrives after the visible task runs still binds — see
   * SPEC.md § Deferring Discovery Until Definition. Pass `"call"` to opt
   * back into the historical behavior, where a not-yet-upgraded element is
   * skipped permanently.
   */
  syncOn?: BindOptions["syncOn"];
}

export function useWcBindable<
  T extends Element = HTMLElement,
  V extends object = Record<string, unknown>,
>(
  initialValues: Partial<V> = {},
  options: UseWcBindableOptions = {},
): { ref: Signal<T | undefined>; values: V } {
  const ref = useSignal<T>();
  const values = useStore<V>({ ...initialValues } as V);
  const syncOn = options.syncOn ?? "define";

  const task: TaskFn = ({ cleanup, track }) => {
    const el = track(() => ref.value);
    if (!el) return;

    // No `isWcBindable()` gate: bind() already returns a no-op cleanup for
    // a non-bindable target, and the gate is precisely what defeated
    // `syncOn: "define"` — it fails for a not-yet-upgraded custom element,
    // and `track(() => ref.value)` does not re-fire on upgrade.
    const unbind = bind(el, (name, value) => {
      (values as Record<string, unknown>)[name] = value;
    }, { syncOn });

    cleanup(unbind);
  };

  useVisibleTaskQrl(
    inlinedQrl(task, "wc_bindable_task", [ref, values, syncOn]),
  );

  return { ref, values };
}
