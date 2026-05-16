import { Signal } from "signal-polyfill";

/**
 * Tiny UI helper around `Signal.subtle.Watcher`.
 *
 * Runs `fn` once eagerly and again every time a Signal read inside it changes.
 * This is the boilerplate the TC39 proposal expects each rendering layer to
 * supply — it is intentionally re-stated here (rather than imported from a
 * framework) so the example shows what the polyfill itself gives you.
 */
export function effect(fn: () => void): () => void {
  const computed = new Signal.Computed(() => {
    fn();
  });
  const watcher = new Signal.subtle.Watcher(() => {
    queueMicrotask(() => {
      computed.get();
      watcher.watch();
    });
  });
  watcher.watch(computed);
  computed.get();
  return () => watcher.unwatch(computed);
}
