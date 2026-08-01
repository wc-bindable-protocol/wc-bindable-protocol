import m from "mithril";
import { bind, type BindOptions } from "@wc-bindable/core";

export type UnbindFn = () => void;
export type OnUpdate = (name: string, value: unknown) => void;

export interface WcBindableOptions {
  /**
   * Forwarded to `bind()`. Defaults to `"define"` so an element whose
   * definition arrives after this call still binds — see SPEC.md
   * § Deferring Discovery Until Definition. Pass `"call"` to opt back into
   * the historical behavior, where a not-yet-upgraded element is skipped
   * permanently.
   */
  syncOn?: BindOptions["syncOn"];
}

export function wcBindable(
  el: HTMLElement,
  onUpdate: OnUpdate,
  options: WcBindableOptions = {},
): UnbindFn {
  // No `isWcBindable()` gate: bind() already returns a no-op cleanup for a
  // non-bindable target, and the gate is precisely what defeated
  // `syncOn: "define"` — it fails for a not-yet-upgraded custom element,
  // and nothing re-runs this call on upgrade.
  return bind(el, onUpdate, { syncOn: options.syncOn ?? "define" });
}

export interface CreateWcBindableOptions extends WcBindableOptions {
  redraw?: () => void;
}

export interface WcBindableState<V extends object> {
  readonly values: V;
  oncreate(vnode: { dom: Element }): void;
  onremove(): void;
}

export function createWcBindable<V extends object = Record<string, unknown>>(
  initialValues: Partial<V> = {},
  options: CreateWcBindableOptions = {},
): WcBindableState<V> {
  const redraw = options.redraw ?? (() => m.redraw());
  const state = { ...(initialValues as V) };
  let unbind: UnbindFn | null = null;

  return {
    get values() {
      return state;
    },
    oncreate(vnode) {
      const el = vnode.dom as HTMLElement;
      unbind = bind(el, (name, value) => {
        (state as Record<string, unknown>)[name] = value;
        redraw();
      }, { syncOn: options.syncOn ?? "define" });
    },
    onremove() {
      if (unbind) {
        unbind();
        unbind = null;
      }
    },
  };
}
