import type { WcBindableDeclaration } from "@wc-bindable/core";
import {
  CompositeEngine,
  declarationsFromSources,
  planComposition,
} from "./engine.js";
import { consoleLogger } from "./logger.js";
import {
  COMPOSITE_PROFILE_VERSION,
  COMPOSITE_TIERS_SYMBOL,
  type CompositeShell,
  type CompositeTierClaim,
  type CreateCompositeTargetConfig,
} from "./types.js";

/**
 * Base class for the headless shell instance. A fresh subclass is generated per
 * `createCompositeTarget` call so each shell carries its own `static wcBindable`
 * (the isolated-constructor pattern required by § 1 for per-instance
 * declarations).
 */
class CompositeShellBase extends EventTarget {}

/**
 * Expose multiple wc-bindable source targets as a single wc-bindable shell
 * target (COMPOSITE.md Extension 4 — Composition). The returned shell is an
 * ordinary `EventTarget` whose `constructor.wcBindable` is the synthesized
 * composed declaration, so `bind()`, every framework adapter, and
 * `@wc-bindable/remote` work against it unchanged.
 *
 * Implements tier **T1** (observation) always, and tier **T2** (local facade —
 * assignable inputs / callable commands) when `localFacade` is enabled (the
 * default whenever inputs / commands are exposed). Tier T3 (the Extension-1
 * `set` / `invoke` surface) is not implemented by this reference target; the
 * tier claim reports `extension1: false`.
 */
export function createCompositeTarget(config: CreateCompositeTargetConfig): CompositeShell {
  const expose = config.expose ?? "all-prefixed";
  const logger = config.logger ?? consoleLogger;

  const sourceDecls = declarationsFromSources(config.sources);

  // localFacade defaults to true whenever there is any input / command to
  // delegate. Plan once with the resolved flag; the flag also drives the § 4
  // cross-surface collision check inside planComposition.
  let localFacade = config.localFacade;
  if (localFacade === undefined) {
    // Cheap pre-plan as T1 to learn whether inputs/commands exist.
    const probe = planComposition(sourceDecls, expose, { localFacade: false });
    localFacade = probe.inputs.length > 0 || probe.commands.length > 0;
  }
  const plan = planComposition(sourceDecls, expose, { localFacade });

  const declaration: WcBindableDeclaration = plan.declaration;

  // Generated subclass holding this shell's isolated static declaration (§ 1).
  const ShellClass = class extends CompositeShellBase {};
  Object.defineProperty(ShellClass, "wcBindable", {
    value: declaration,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  const target = new ShellClass();

  const sources = new Map<string, EventTarget>();
  for (const id of Object.keys(config.sources)) sources.set(id, config.sources[id]);
  const engine = new CompositeEngine(plan, sources, target, logger);

  // § Tier claim: frozen, own, read-only per-instance claim.
  const claim: CompositeTierClaim = {
    protocol: "wc-bindable.composite",
    version: COMPOSITE_PROFILE_VERSION,
    localFacade: plan.localFacade,
    extension1: false,
  };
  if (config.remoteCompatible) claim.remoteCompatible = true;
  Object.freeze(claim);
  Object.defineProperty(target, COMPOSITE_TIERS_SYMBOL, {
    value: claim,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  // dispose() is materialized as an own method so it is reachable both via the
  // proxy and via direct property access; it is reserved as a composed name.
  Object.defineProperty(target, "dispose", {
    value: () => engine.dispose(),
    enumerable: false,
    writable: false,
    configurable: false,
  });

  engine.install();

  // The EventTarget instance methods must run with the real target as `this`
  // (their internal slots do not resolve through a Proxy receiver). Bind once
  // and cache so repeated reads return a stable reference. Crucially this set
  // does NOT include `constructor` — binding the generated class would strip its
  // static `wcBindable` and break discovery.
  const FORWARDED_METHODS = new Set(["addEventListener", "removeEventListener", "dispatchEvent"]);
  const boundMethods = new Map<PropertyKey, unknown>();
  const bindForwarded = (key: PropertyKey, value: (...args: unknown[]) => unknown): unknown => {
    let bound = boundMethods.get(key);
    if (bound === undefined) {
      bound = value.bind(target);
      boundMethods.set(key, bound);
    }
    return bound;
  };

  const handler: ProxyHandler<EventTarget> = {
    has(t, key) {
      // § 5: a composed property reports presence from the source. Input /
      // command facade members report present so tooling can see the surface.
      if (typeof key === "string") {
        if (engine.isProperty(key)) return engine.has(key);
        if (engine.localFacade && (engine.isInput(key) || engine.isCommand(key))) return true;
      }
      return Reflect.has(t, key);
    },
    get(t, key) {
      if (typeof key === "string") {
        if (engine.isProperty(key)) return engine.getValue(key);
        if (engine.localFacade && engine.isCommand(key)) return engine.getCommand(key);
        // A composed input has no readable value of its own; fall through so a
        // declared input that is not also a property reads as undefined.
      }
      // Forward everything else (addEventListener, dispatchEvent, dispose,
      // constructor, the tier symbol, ...) to the real target, using `t` as the
      // receiver. Only the EventTarget instance methods need `this` rebinding.
      const value = Reflect.get(t, key, t);
      if (typeof value === "function" && FORWARDED_METHODS.has(key as string)) {
        return bindForwarded(key, value as (...args: unknown[]) => unknown);
      }
      return value;
    },
    set(t, key, value) {
      if (typeof key === "string") {
        if (engine.isProperty(key)) {
          throw new TypeError(
            `@wc-bindable/composite: composed property ${JSON.stringify(key)} is read-only (it is an output)`,
          );
        }
        if (engine.localFacade && engine.isInput(key)) {
          engine.setInput(key, value); // delegates; a throwing setter propagates
          return true;
        }
      }
      return Reflect.set(t, key, value, t);
    },
  };

  return new Proxy(target, handler) as unknown as CompositeShell;
}
