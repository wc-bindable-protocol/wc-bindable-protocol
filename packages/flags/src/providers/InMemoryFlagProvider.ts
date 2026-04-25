import type { FlagIdentity, FlagMap, FlagProvider, FlagUnsubscribe, FlagValue } from "../types.js";
import { deepCloneAndFreeze } from "../freeze.js";

/**
 * Simple per-identity flag rule. The first matching entry wins; if no
 * entry matches, the flag's default value is used.
 */
export interface InMemoryFlagRule<T extends FlagValue = FlagValue> {
  /** Flag key. */
  key: string;
  /** Value returned to identities matching `predicate`. */
  value: T;
  /** Match predicate — receives the {@link FlagIdentity}. */
  predicate: (identity: FlagIdentity) => boolean;
}

/**
 * Definition of a single flag known to the in-memory provider.
 */
export interface InMemoryFlagDefinition<T extends FlagValue = FlagValue> {
  key: string;
  /** Value returned when no rule matches. */
  defaultValue: T;
  rules?: InMemoryFlagRule<T>[];
}

export interface InMemoryFlagProviderOptions {
  flags?: InMemoryFlagDefinition[];
}

/**
 * Reference Provider for tests, demos, and local development.
 *
 * Evaluates flag values in-process from a list of {@link InMemoryFlagDefinition}.
 * Changes pushed via {@link setFlag} / {@link setFlags} are delivered to all
 * current subscribers synchronously. Subscribers receive the full
 * evaluated map — never a delta — mirroring the wire contract of the
 * remote-facing `FlagsCore`.
 */
export class InMemoryFlagProvider implements FlagProvider {
  private _flags: Map<string, InMemoryFlagDefinition> = new Map();
  // Subscribers are keyed by identity userId. Multiple subscribers for
  // the same userId are supported (tests frequently register more than
  // one), so each value is a Set.
  private _subscribers: Map<string, Set<{ identity: FlagIdentity; onChange: (next: FlagMap) => void }>> = new Map();

  constructor(options: InMemoryFlagProviderOptions = {}) {
    for (const def of options.flags ?? []) {
      this._flags.set(def.key, def);
    }
  }

  async identify(identity: FlagIdentity): Promise<FlagMap> {
    return this._evaluate(identity);
  }

  subscribe(
    identity: FlagIdentity,
    onChange: (next: FlagMap) => void,
    // Accepted solely to match the {@link FlagProvider} interface so
    // `new InMemoryFlagProvider()` can be used directly (not just via
    // the interface type) with all three arguments. Intentionally
    // unused: this provider has no polling baseline to seed —
    // `onChange` is invoked deterministically from `setFlag` /
    // `setFlags`, never from a polling diff.
    _initial?: FlagMap,
  ): FlagUnsubscribe {
    const bucket = this._subscribers.get(identity.userId) ?? new Set();
    const entry = { identity, onChange };
    bucket.add(entry);
    this._subscribers.set(identity.userId, bucket);
    return () => {
      const current = this._subscribers.get(identity.userId);
      if (!current) return;
      current.delete(entry);
      if (current.size === 0) this._subscribers.delete(identity.userId);
    };
  }

  async reload(identity: FlagIdentity): Promise<FlagMap> {
    return this._evaluate(identity);
  }

  dispose(): void {
    this._subscribers.clear();
    this._flags.clear();
  }

  // --- Test / demo helpers ----------------------------------------------

  /**
   * Replace the value (or default value) of a single flag and notify
   * every subscriber with a freshly evaluated map.
   */
  setFlag<T extends FlagValue>(key: string, defaultValue: T): void {
    const existing = this._flags.get(key);
    if (existing) {
      this._flags.set(key, { ...existing, defaultValue });
    } else {
      this._flags.set(key, { key, defaultValue });
    }
    this._notifyAll();
  }

  /**
   * Replace the full flag set with a new list of definitions and notify
   * every subscriber.
   */
  setFlags(flags: InMemoryFlagDefinition[]): void {
    this._flags.clear();
    for (const def of flags) this._flags.set(def.key, def);
    this._notifyAll();
  }

  private _evaluate(identity: FlagIdentity): FlagMap {
    const out: Record<string, FlagValue> = {};
    for (const def of this._flags.values()) {
      let value: FlagValue = def.defaultValue;
      if (def.rules) {
        for (const rule of def.rules) {
          if (rule.predicate(identity)) {
            value = rule.value;
            break;
          }
        }
      }
      out[def.key] = value;
    }
    // Deep-clone-and-freeze every level to match Flagsmith/Unleash
    // providers: evaluated values here share references with the
    // rule definitions stored in `this._flags`, so a shallow freeze
    // would leak source-of-truth refs to consumers (e.g. arrays or
    // `{ enabled, value }` objects could be mutated through the
    // evaluated map and bleed into the next evaluation). FlagsCore
    // does its own deep-clone as a final guard, but making every
    // Provider emit isolated snapshots keeps the contract symmetric
    // and avoids relying on the Core for safety.
    return deepCloneAndFreeze(out);
  }

  private _notifyAll(): void {
    for (const bucket of this._subscribers.values()) {
      for (const { identity, onChange } of bucket) {
        // Each subscriber is re-evaluated independently because rules
        // can produce different values per identity.
        onChange(this._evaluate(identity));
      }
    }
  }
}
