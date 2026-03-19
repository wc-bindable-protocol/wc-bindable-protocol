import { useState, useEffect, useCallback } from "preact/hooks";
import { bind, isWcBindable } from "@wc-bindable/core";

export function useWcBindable<
  T extends HTMLElement,
  V extends object = Record<string, unknown>,
>(initialValues: Partial<V> = {}) {
  const [el, setEl] = useState<T | null>(null);
  const [values, setValues] = useState<V>(initialValues as V);

  const ref = useCallback((node: T | null) => setEl(node), []);

  const onUpdate = useCallback((name: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  useEffect(() => {
    if (!el || !isWcBindable(el)) return;

    return bind(el, onUpdate);
  }, [el, onUpdate]);

  return [ref, values] as const;
}
