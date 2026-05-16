import { bind, isWcBindable } from "@wc-bindable/core";

export type UnbindFn = () => void;

export type OnUpdate = (name: string, value: unknown) => void;

export function wcBindable(el: HTMLElement, onUpdate: OnUpdate): UnbindFn {
  if (!isWcBindable(el)) return () => {};
  return bind(el, onUpdate);
}
