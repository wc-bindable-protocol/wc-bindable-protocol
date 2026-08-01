import type { Action } from "svelte/action";
import { bind, type BindOptions } from "@wc-bindable/core";

export interface WcBindableParams {
  onUpdate: (name: string, value: unknown) => void;
  /**
   * Forwarded to `bind()`. Defaults to `"define"` so an element whose
   * definition arrives after the action runs still binds — see SPEC.md
   * § Deferring Discovery Until Definition. Pass `"call"` to opt back into
   * the historical behavior, where a not-yet-upgraded element is skipped
   * permanently.
   */
  syncOn?: BindOptions["syncOn"];
}

export const wcBindable: Action<HTMLElement, WcBindableParams> = (
  node,
  params,
) => {
  let unbind: (() => void) | undefined;

  function setup(p: WcBindableParams | undefined) {
    unbind?.();
    if (!p) return;
    // No `isWcBindable()` gate: bind() already returns a no-op cleanup for
    // a non-bindable target, and the gate is precisely what defeated
    // `syncOn: "define"` — it fails for a not-yet-upgraded custom element,
    // and `update` only re-runs on a params change, not on upgrade.
    unbind = bind(node, p.onUpdate, { syncOn: p.syncOn ?? "define" });
  }

  setup(params);

  return {
    update(newParams) {
      setup(newParams);
    },
    destroy() {
      unbind?.();
    },
  };
};
