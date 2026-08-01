import type Alpine from "alpinejs";
import { bind, type BindOptions } from "@wc-bindable/core";

export interface WcBindablePluginOptions {
  /**
   * Forwarded to `bind()` for every element the directive binds. Defaults
   * to `"define"` so an element whose definition arrives after the
   * directive runs still binds — see SPEC.md § Deferring Discovery Until
   * Definition. Pass `"call"` to opt back into the historical behavior,
   * where a not-yet-upgraded element is skipped permanently. Alpine
   * directives have no per-element options slot, so this is set once when
   * the plugin is registered.
   */
  syncOn?: BindOptions["syncOn"];
}

export default function wcBindablePlugin(
  alpine: typeof Alpine,
  options: WcBindablePluginOptions = {},
) {
  const syncOn = options.syncOn ?? "define";
  alpine.directive(
    "wc-bindable",
    (el, { expression }, { evaluate, cleanup }) => {
      const target = expression ? evaluate<string>(expression) : undefined;

      // No `isWcBindable()` gate: bind() already returns a no-op cleanup
      // for a non-bindable target, and the gate is precisely what defeated
      // `syncOn: "define"` — it fails for a not-yet-upgraded custom
      // element, and the directive body does not run again on upgrade.
      const unbind = bind(el, (name, value) => {
        const data = alpine.$data(el) as Record<string, unknown>;
        if (target) {
          const obj = (data[target] ?? {}) as Record<string, unknown>;
          data[target] = { ...obj, [name]: value };
        } else {
          data[name] = value;
        }
      }, { syncOn });

      cleanup(unbind);
    },
  );
}
