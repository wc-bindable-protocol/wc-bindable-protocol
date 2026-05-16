import { bind, isWcBindable } from "@wc-bindable/core";

export type UnbindFn = () => void;
export type OnUpdate = (name: string, value: unknown) => void;

export function wcBindable(el: Element, onUpdate: OnUpdate): UnbindFn {
  if (!isWcBindable(el)) return () => {};
  return bind(el, onUpdate);
}

export interface CreateWcBindableOptions {
  update?: () => void;
}

export interface WcBindableBinder<V extends object> {
  readonly values: V;
  bind(el: Element): void;
  unbind(): void;
}

export function createWcBindable<V extends object = Record<string, unknown>>(
  initialValues: Partial<V> = {},
  options: CreateWcBindableOptions = {},
): WcBindableBinder<V> {
  const state = { ...(initialValues as V) };
  const update = options.update ?? (() => {});
  let unbindFn: UnbindFn | null = null;

  return {
    get values() {
      return state;
    },
    bind(el) {
      if (unbindFn) {
        unbindFn();
        unbindFn = null;
      }
      if (!isWcBindable(el)) return;
      unbindFn = bind(el, (name, value) => {
        (state as Record<string, unknown>)[name] = value;
        update();
      });
    },
    unbind() {
      if (unbindFn) {
        unbindFn();
        unbindFn = null;
      }
    },
  };
}
