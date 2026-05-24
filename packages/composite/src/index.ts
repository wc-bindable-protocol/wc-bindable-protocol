// @wc-bindable/composite — reference implementation of the wc-bindable
// Composition profile (SPEC-extensions.md § Extension 4 / COMPOSITE.md).
//
// Expose many wc-bindable source targets as one wc-bindable shell target, so
// existing `bind()` / framework-adapter / `@wc-bindable/remote` consumers work
// against the composed shell unchanged. Implements tier T1 (observation) and
// tier T2 (local facade); tier T3 (the Extension-1 surface) is not implemented.

export { createCompositeTarget } from "./createCompositeTarget.js";

export {
  defineComposite,
  defineCompositeClass,
  registerCompositeDefinitions,
  type DefineCompositeOptions,
  type DefineCompositeClassOptions,
  type CompositeElementConstructor,
  type SourceSpec,
} from "./declarative.js";

// Lower-level building blocks, exported for tooling and advanced composition.
export {
  planComposition,
  declarationsFromSources,
  CompositeEngine,
  CompositeUpdateEvent,
  SHELL_EVENT_PREFIX,
  type CompositionPlan,
} from "./engine.js";

export {
  isReservedComposedName,
  isReservedSourceId,
  reservedComposedNameReason,
} from "./reservedNames.js";

export { consoleLogger, silentLogger, type Logger } from "./logger.js";

export {
  COMPOSITE_PROFILE_VERSION,
  COMPOSITE_TIERS_SYMBOL,
  type CompositeTierClaim,
  type CompositeShell,
  type CreateCompositeTargetConfig,
  type ExposeConfig,
  type ExposeMap,
  type SourceRef,
} from "./types.js";
