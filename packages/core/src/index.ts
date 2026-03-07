export interface WcBindableProperty {
  name: string;
  event: string;
  getter?: (event: Event) => unknown;
}

export interface WcBindableDeclaration {
  protocol: "wc-bindable";
  version: 1;
  properties: WcBindableProperty[];
}

export interface WcBindableElement extends HTMLElement {
  constructor: { wcBindable: WcBindableDeclaration };
}

const DEFAULT_GETTER = (e: Event): unknown => (e as CustomEvent).detail;

export function isWcBindable(element: HTMLElement): element is WcBindableElement {
  const decl = (element.constructor as { wcBindable?: WcBindableDeclaration }).wcBindable;
  return decl?.protocol === "wc-bindable" && decl?.version === 1;
}

export type UnbindFn = () => void;

export function bind(
  element: HTMLElement,
  onUpdate: (name: string, value: unknown) => void,
): UnbindFn {
  if (!isWcBindable(element)) return () => {};

  const { properties } = element.constructor.wcBindable;
  const cleanups: (() => void)[] = [];

  for (const prop of properties) {
    const getter = prop.getter ?? DEFAULT_GETTER;
    const handler = (event: Event) => onUpdate(prop.name, getter(event));
    element.addEventListener(prop.event, handler);
    cleanups.push(() => element.removeEventListener(prop.event, handler));
  }

  return () => cleanups.forEach((fn) => fn());
}
