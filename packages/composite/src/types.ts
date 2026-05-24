import type { Logger } from "./logger.js";

/**
 * The composite profile version this implementation conforms to. This is the
 * `version` field of the tier-claim object and is deliberately separate from
 * the core protocol version on `constructor.wcBindable.version` (COMPOSITE.md
 * § Tier claim must be discoverable out-of-band).
 */
export const COMPOSITE_PROFILE_VERSION = 1;

/**
 * Well-known symbol carrying a composed shell's per-instance tier claim
 * (COMPOSITE.md § Tier claim must be discoverable out-of-band).
 */
export const COMPOSITE_TIERS_SYMBOL = Symbol.for("wc-bindable.composite.tiers");

/**
 * The standard, machine-readable tier-claim object exposed at
 * {@link COMPOSITE_TIERS_SYMBOL}. Open shape: consumers MUST ignore unrecognized
 * fields and MUST read `version` before trusting the rest.
 */
export interface CompositeTierClaim {
  protocol: "wc-bindable.composite";
  /** Integer >= 1. This profile is version 1. */
  version: number;
  /** `true` ⇒ this instance claims T2 (local facade — assignable / callable members). */
  localFacade: boolean;
  /** `true` ⇒ this instance claims T3 (Extension-1 surface). Always `false` here. */
  extension1: boolean;
  /**
   * `true` ⇒ this instance's current declaration may be handed directly to
   * `RemoteShellProxy`. Absent ≡ `false` (COMPOSITE.md § Discovering remote
   * compatibility).
   */
  remoteCompatible?: boolean;
}

/**
 * Structured reference to a single member of one source target. String forms
 * like `"s3.progress"` are used only as display names; the mapping is resolved
 * through this structured ref, never by splitting the string (COMPOSITE.md § 3).
 */
export interface SourceRef {
  /** Source id — a local label chosen by the composition author. */
  source: string;
  /** The property / input / command name inside that source's declaration. */
  name: string;
}

/** Explicit expose map: composed public name → the source member it maps to. */
export interface ExposeMap {
  properties?: Record<string, SourceRef>;
  inputs?: Record<string, SourceRef>;
  commands?: Record<string, SourceRef>;
}

/**
 * `"all-prefixed"` auto-exposes every source member under its
 * `<sourceId>.<sourceName>` default composed name (COMPOSITE.md § JavaScript
 * API). Otherwise pass an explicit {@link ExposeMap}.
 */
export type ExposeConfig = ExposeMap | "all-prefixed";

export interface CreateCompositeTargetConfig {
  /** Source id → source wc-bindable target. */
  sources: Record<string, EventTarget>;
  /** What the shell exposes. Defaults to `"all-prefixed"`. */
  expose?: ExposeConfig;
  /**
   * When `true`, declared `inputs` / `commands` are materialized as assignable /
   * callable members of the shell (tier T2) and `localFacade` is reported
   * `true`. When `false`, they are declaration-only metadata (tier T1) and
   * assigning / invoking them does nothing. Defaults to `true` whenever any
   * input or command is exposed.
   */
  localFacade?: boolean;
  /**
   * Claim remote compatibility (COMPOSITE.md § Discovering remote
   * compatibility). Reserved names are rejected regardless; this only sets the
   * `remoteCompatible` flag on the tier claim. Defaults to `false`.
   */
  remoteCompatible?: boolean;
  /** Logger for getter-failure / delegation reports. Defaults to the console logger. */
  logger?: Logger;
}

/** The shell returned by {@link createCompositeTarget}: an ordinary wc-bindable target. */
export type CompositeShell = EventTarget & {
  readonly [COMPOSITE_TIERS_SYMBOL]: CompositeTierClaim;
  /**
   * Idempotent terminal teardown. Removes every installed source listener and
   * makes subsequent input / command delegation fail predictably (COMPOSITE.md
   * § 10). Does NOT dispose the source targets (borrow semantics).
   */
  dispose(): void;
  /** Composed members are dynamically keyed, so allow string indexing. */
  [key: string]: unknown;
};
