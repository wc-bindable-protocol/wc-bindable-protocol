import { useSignal, useStore, type Signal } from "@qwik.dev/core";
import {
  useVisibleTaskQrl,
  inlinedQrl,
  type TaskFn,
} from "@qwik.dev/core/internal";
import { bind, isWcBindable } from "@wc-bindable/core";

export function useWcBindable<
  T extends Element = HTMLElement,
  V extends object = Record<string, unknown>,
>(initialValues: Partial<V> = {}): { ref: Signal<T | undefined>; values: V } {
  const ref = useSignal<T>();
  const values = useStore<V>({ ...initialValues } as V);

  const task: TaskFn = ({ cleanup, track }) => {
    const el = track(() => ref.value);
    if (!el || !isWcBindable(el)) return;

    const unbind = bind(el, (name, value) => {
      (values as Record<string, unknown>)[name] = value;
    });

    cleanup(unbind);
  };

  useVisibleTaskQrl(
    inlinedQrl(task, "wc_bindable_task", [ref, values]),
  );

  return { ref, values };
}
