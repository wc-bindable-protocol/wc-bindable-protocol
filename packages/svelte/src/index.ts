import type { Action } from "svelte/action";
import { bind, isWcBindable } from "@wc-bindable/core";

export interface WcBindableParams {
  onUpdate: (name: string, value: unknown) => void;
}

export const wcBindable: Action<HTMLElement, WcBindableParams> = (
  node,
  params,
) => {
  let unbind: (() => void) | undefined;

  function setup(p: WcBindableParams | undefined) {
    unbind?.();
    if (!p || !isWcBindable(node)) return;
    unbind = bind(node, p.onUpdate);
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
