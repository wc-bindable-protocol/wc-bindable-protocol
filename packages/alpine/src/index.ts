import type Alpine from "alpinejs";
import { bind, isWcBindable } from "@wc-bindable/core";

export default function wcBindablePlugin(alpine: typeof Alpine) {
  alpine.directive(
    "wc-bindable",
    (el, { expression }, { evaluate, cleanup }) => {
      if (!isWcBindable(el)) return;

      const target = expression ? evaluate<string>(expression) : undefined;

      const unbind = bind(el, (name, value) => {
        const data = alpine.$data(el) as Record<string, unknown>;
        if (target) {
          const obj = (data[target] ?? {}) as Record<string, unknown>;
          data[target] = { ...obj, [name]: value };
        } else {
          data[name] = value;
        }
      });

      cleanup(unbind);
    },
  );
}
