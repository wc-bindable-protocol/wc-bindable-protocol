import { useState, useEffect, useCallback } from "preact/hooks";
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
>(initialValues: Partial<V> = {}, options: UseWcBindableOptions = {}) {
  const [el, setEl] = useState<T | null>(null);
  const [values, setValues] = useState<V>(initialValues as V);
  const syncOn = options.syncOn ?? "define";

  const ref = useCallback((node: T | null) => setEl(node), []);

  const onUpdate = useCallback((name: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  useEffect(() => {
    if (!el) return;

    // No `isWcBindable()` gate: bind() already returns a no-op cleanup for
    // a non-bindable target, and the gate is precisely what defeated
    // `syncOn: "define"` — it fails for a not-yet-upgraded custom element,
    // and because `el` keeps its identity across upgrade this effect never
    // re-runs to notice.
    return bind(el, onUpdate, { syncOn });
  }, [el, onUpdate, syncOn]);

  return [ref, values] as const;
}
