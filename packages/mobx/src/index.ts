import { observable, runInAction, set } from "mobx";
import { bind, isWcBindable } from "@wc-bindable/core";

export type UnbindFn = () => void;
export type OnUpdate = (name: string, value: unknown) => void;

export function wcBindable(el: Element, onUpdate: OnUpdate): UnbindFn {
  if (!isWcBindable(el)) return () => {};
  return bind(el, onUpdate);
}

export type WcBindableState<V extends object> = V;

export interface WcBindableBinder<V extends object> {
  readonly state: WcBindableState<V>;
  bind(el: Element): void;
  unbind(): void;
}

export function createWcBindable<V extends object = Record<string, unknown>>(
  initialValues: Partial<V> = {},
): WcBindableBinder<V> {
  // deep: false keeps the wc-bindable contract "values are passed as-is" — MobX's
  // default deep enhancer would wrap assigned arrays/objects in observable proxies
  // and break reference identity for consumers.
  const state = observable(
    { ...(initialValues as object) } as Record<string, unknown>,
    {},
    { deep: false },
  );

  let unbindFn: UnbindFn | null = null;

  return {
    get state() {
      return state as unknown as WcBindableState<V>;
    },
    bind(el) {
      if (unbindFn) {
        unbindFn();
        unbindFn = null;
      }
      if (!isWcBindable(el)) return;
      unbindFn = bind(el, (name, value) => {
        runInAction(() => {
          set(state, name, value);
        });
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
