import m from "mithril";
import { bind, isWcBindable } from "@wc-bindable/core";

export type UnbindFn = () => void;
export type OnUpdate = (name: string, value: unknown) => void;

export function wcBindable(el: HTMLElement, onUpdate: OnUpdate): UnbindFn {
  if (!isWcBindable(el)) return () => {};
  return bind(el, onUpdate);
}

export interface CreateWcBindableOptions {
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
      if (!isWcBindable(el)) return;
      unbind = bind(el, (name, value) => {
        (state as Record<string, unknown>)[name] = value;
        redraw();
      });
    },
    onremove() {
      if (unbind) {
        unbind();
        unbind = null;
      }
    },
  };
}
