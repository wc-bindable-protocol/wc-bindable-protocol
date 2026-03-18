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

export type WcBindableConstructor = (new (...args: unknown[]) => EventTarget) & {
  wcBindable: WcBindableDeclaration;
};

export interface WcBindableElement extends EventTarget {
  constructor: WcBindableConstructor;
}

const DEFAULT_GETTER = (e: Event): unknown => (e as CustomEvent).detail;

export function isWcBindable(target: EventTarget): target is WcBindableElement {
  const decl = (target.constructor as { wcBindable?: WcBindableDeclaration }).wcBindable;
  return decl?.protocol === "wc-bindable" && decl?.version === 1;
}

export type UnbindFn = () => void;

export function bind(
  target: EventTarget,
  onUpdate: (name: string, value: unknown) => void,
): UnbindFn {
  if (!isWcBindable(target)) return () => {};

  const { properties } = target.constructor.wcBindable;
  const cleanups: (() => void)[] = [];

  for (const prop of properties) {
    const getter = prop.getter ?? DEFAULT_GETTER;
    const handler = (event: Event) => onUpdate(prop.name, getter(event));
    target.addEventListener(prop.event, handler);
    cleanups.push(() => target.removeEventListener(prop.event, handler));

    const current = (target as unknown as Record<string, unknown>)[prop.name];
    if (current !== undefined) {
      onUpdate(prop.name, current);
    }
  }

  return () => cleanups.forEach((fn) => fn());
}
