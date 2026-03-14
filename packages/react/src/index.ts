import { useRef, useState, useEffect, useCallback } from "react";
import { bind, isWcBindable } from "@wc-bindable/core";

export function useWcBindable<
  T extends HTMLElement,
  V extends Record<string, unknown> = Record<string, unknown>,
>(initialValues: Partial<V> = {}) {
  const ref = useRef<T>(null);
  const [values, setValues] = useState<V>(initialValues as V);

  const onUpdate = useCallback((name: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || !isWcBindable(el)) return;

    return bind(el, onUpdate);
  }, [onUpdate]);

  return [ref, values] as const;
}
