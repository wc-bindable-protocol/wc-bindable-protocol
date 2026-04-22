import type {
  FlagIdentity,
  FlagMap,
  FlagProvider,
  FlagUnsubscribe,
  FlagValue,
  UnleashContext,
  UnleashProviderOptions,
} from "../types.js";
import { raiseError } from "../raiseError.js";
import { identityKey, stableStringify } from "./_identityKey.js";

/**
 * Minimal structural shape we rely on from `unleash-client`. Declared
 * here rather than imported so the package compiles without the peer
 * dependency installed and remains resilient to minor SDK revisions.
 */
interface UnleashClientLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  isEnabled(name: string, context?: UnleashContext): boolean;
  getVariant(name: string, context?: UnleashContext): UnleashVariantLike;
  getFeatureToggleDefinitions(): Array<{ name: string }>;
  destroy?(): void | Promise<void>;
}

interface UnleashVariantLike {
  name: string;
  enabled: boolean;
  payload?: { type?: string; value?: string };
}

interface SubscriberEntry {
  onChange: (next: FlagMap) => void;
}

interface UnleashBucket {
  identity: FlagIdentity;
  lastSerialized: string;
  subscribers: Set<SubscriberEntry>;
}

/**
 * Unleash-backed {@link FlagProvider}.
 *
 * Uses `unleash-client` (declared as an optional peer dep) loaded via
 * dynamic import. Architecturally simpler than {@link FlagsmithProvider}
 * because Unleash's SDK:
 *
 * - Runs a single upstream polling loop on `refreshInterval`,
 *   independent of how many identities this Provider serves.
 * - Emits `changed` whenever upstream toggle definitions update, so
 *   fan-out is event-driven — no per-identity timer.
 * - Evaluates `isEnabled(name, context)` / `getVariant(name, context)`
 *   in-process against the cached definitions.
 *
 * The {@link FlagIdentity} → {@link UnleashContext} mapping flattens
 * `identity.attrs` into `context.properties` (all values stringified).
 * Override via `options.contextBuilder` to tailor the shape.
 *
 * Flag map shape mirrors {@link FlagsmithProvider}: each entry is
 * `{ enabled, value }`, where `value` is the variant payload (or
 * variant name) when the toggle is enabled and has a variant
 * assignment, otherwise `null`.
 */
export class UnleashProvider implements FlagProvider {
  private _options: UnleashProviderOptions;
  private _clientPromise: Promise<UnleashClientLike> | null = null;
  private _client: UnleashClientLike | null = null;
  private _buckets: Map<string, UnleashBucket> = new Map();
  private _changedListener: ((...args: unknown[]) => void) | null = null;
  private _disposed = false;

  constructor(options: UnleashProviderOptions) {
    if (!options || !options.url) {
      raiseError("UnleashProvider: `url` is required.");
    }
    if (!options.appName) {
      raiseError("UnleashProvider: `appName` is required.");
    }
    this._options = options;
  }

  async identify(identity: FlagIdentity): Promise<FlagMap> {
    const client = await this._getClient();
    return this._evaluate(client, identity);
  }

  subscribe(
    identity: FlagIdentity,
    onChange: (next: FlagMap) => void,
    initial?: FlagMap,
  ): FlagUnsubscribe {
    if (this._disposed) {
      raiseError("UnleashProvider: cannot subscribe on a disposed provider.");
    }
    const key = identityKey(identity);
    let bucket = this._buckets.get(key);
    if (!bucket) {
      bucket = {
        identity,
        // Seed the change-detection baseline with the caller-supplied
        // initial snapshot. When omitted, the sentinel falls through
        // and the first `changed`-driven re-evaluation acts as the
        // initial push — same ordering semantics as FlagsmithProvider.
        lastSerialized: initial !== undefined ? stableStringify(initial) : "__INIT__",
        subscribers: new Set(),
      };
      this._buckets.set(key, bucket);
    }
    // NB: once a bucket exists, its `lastSerialized` is authoritative.
    // A later subscriber's `initial` is ignored for the same reason as
    // FlagsmithProvider — see the comment there.

    const entry: SubscriberEntry = { onChange };
    bucket.subscribers.add(entry);

    return () => {
      const current = this._buckets.get(key);
      if (!current) return;
      if (!current.subscribers.delete(entry)) return;
      if (current.subscribers.size === 0) {
        this._buckets.delete(key);
      }
    };
  }

  async reload(identity: FlagIdentity): Promise<FlagMap> {
    // Re-evaluate against the SDK's current cache. `unleash-client` does
    // not expose a force-fetch-upstream API across versions; upstream
    // freshness is governed by the SDK's own `refreshInterval`. If an
    // application needs sub-interval freshness it should lower
    // `refreshInterval` rather than spam `reload()`.
    const client = await this._getClient();
    const map = await this._evaluate(client, identity);
    const bucket = this._buckets.get(identityKey(identity));
    if (bucket) bucket.lastSerialized = stableStringify(map);
    return map;
  }

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    for (const bucket of this._buckets.values()) bucket.subscribers.clear();
    this._buckets.clear();
    const client = this._client;
    if (client) {
      if (this._changedListener && client.off) {
        try {
          client.off("changed", this._changedListener);
        } catch {
          // Non-fatal.
        }
      }
      if (client.destroy) {
        try {
          await client.destroy();
        } catch {
          // Non-fatal.
        }
      }
    }
    this._client = null;
    this._clientPromise = null;
    this._changedListener = null;
  }

  // --- Private --------------------------------------------------------------

  private async _getClient(): Promise<UnleashClientLike> {
    if (this._disposed) raiseError("UnleashProvider: provider has been disposed.");
    if (this._client) return this._client;
    if (this._clientPromise) return this._clientPromise;

    this._clientPromise = (async () => {
      let mod: Record<string, unknown>;
      try {
        /*
         * Optional peer dep. Use a ts-ignore (not a ts-expect-error)
         * because the directive needs to stay a no-op both when the
         * consumer HAS `unleash-client` installed (resolution succeeds,
         * so an expect-error directive would trigger TS2578 "unused")
         * and when they DO NOT (TS2307 "cannot find module", so
         * suppression is required). Consistency across install states
         * matters more than style here.
         */
        // @ts-ignore
        mod = await import("unleash-client");
      } catch (err) {
        /* v8 ignore start -- dynamic-import rejections are always Error in both native and vitest runtimes; the String(err) branch is defensive */
        const message = err instanceof Error ? err.message : String(err);
        /* v8 ignore stop */
        raiseError(
          `UnleashProvider: failed to load "unleash-client" — install it as a peer dependency. Original error: ${message}`,
        );
      }

      // Probe for either the factory `initialize()` (preferred,
      // canonical v3+) or a constructor `Unleash` (older shape /
      // some bundles). `in` avoids triggering strict-mock errors
      // on vitest-mocked modules where accessing an undefined
      // named export would throw; we only dereference keys that
      // actually exist.
      let init: ((opts: unknown) => UnleashClientLike) | null = null;
      if ("initialize" in mod && typeof mod.initialize === "function") {
        init = mod.initialize as (opts: unknown) => UnleashClientLike;
      } else if ("Unleash" in mod && typeof mod.Unleash === "function") {
        const Ctor = mod.Unleash as new (opts: unknown) => UnleashClientLike;
        init = (opts) => new Ctor(opts);
      }
      if (!init) {
        raiseError("UnleashProvider: `unleash-client` module did not expose `initialize` or `Unleash`.");
      }

      // When `clientKey` is supplied, prepend it to any user-supplied
      // custom headers as the `Authorization` entry — that is the shape
      // unleash-client expects for SDK tokens.
      const headers: Record<string, string> = { ...(this._options.customHeaders ?? {}) };
      if (this._options.clientKey !== undefined) {
        headers.Authorization = this._options.clientKey;
      }
      const client = init({
        url: this._options.url,
        appName: this._options.appName,
        instanceId: this._options.instanceId,
        environment: this._options.environment,
        refreshInterval: this._options.refreshInterval,
        metricsInterval: this._options.metricsInterval,
        customHeaders: Object.keys(headers).length > 0 ? headers : undefined,
        customHeadersFunction: this._options.customHeadersFunction,
        disableMetrics: this._options.disableMetrics,
      });

      // From this point on the SDK has already begun background work
      // (upstream polling loop, metrics flush, optional socket). Any
      // failure before we commit the client must tear it down, or
      // retries after a transient outage would leak dead SDK
      // instances whose listeners and timers keep running forever.
      // Hoist the listener references so the cleanup path can detach
      // them — some Unleash versions' `destroy()` does not iterate
      // registered listeners, so explicit `off()` is defense-in-depth.
      let onReady: (() => void) | null = null;
      let onError: ((err: unknown) => void) | null = null;
      try {
        // Await `ready` before the first evaluation — otherwise
        // getFeatureToggleDefinitions() may return an empty list and
        // identify() would silently publish `{}` to every subscriber.
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          onReady = (): void => {
            /* v8 ignore start -- the SDK emits `ready` at most once per init cycle; `settled` guards a pathological re-fire */
            if (settled) return;
            /* v8 ignore stop */
            settled = true;
            resolve();
          };
          onError = (err: unknown): void => {
            /* v8 ignore start -- a post-settle error from the SDK cannot change the already-resolved promise; defensive re-entrance guard */
            if (settled) return;
            /* v8 ignore stop */
            settled = true;
            reject(err instanceof Error ? err : new Error(String(err)));
          };
          client.on("ready", onReady);
          client.on("error", onError);
        });

        // Ready/error listeners have served their purpose; detach
        // them so the client's dispatch map stays lean across its
        // whole lifetime.
        _detachQuietly(client, "ready", onReady);
        _detachQuietly(client, "error", onError);

        // Race-check: `dispose()` that ran while we were awaiting
        // `ready` (or `import()` before that) could not tear down
        // this client because `_client` was still null. It only
        // flipped `_disposed`. If we commit now, the half-built
        // client lives forever on a disposed Provider with its
        // polling / metrics / listeners still running. Raise into
        // the catch below so the standard cleanup path runs.
        if (this._disposed) {
          raiseError("UnleashProvider: disposed during initialization.");
        }

        // Wire the change fan-out once the client is ready.
        const onChanged = (): void => this._onChanged();
        this._changedListener = onChanged;
        client.on("changed", onChanged);

        this._client = client;
        return client;
      } catch (err) {
        _detachQuietly(client, "ready", onReady);
        _detachQuietly(client, "error", onError);
        // The disposed-race path above throws BEFORE wiring the
        // changed listener, so there is nothing to detach here in
        // that case. On real init-failure paths, `_changedListener`
        // is also unset. Left without a detach to avoid the false
        // impression that the catch sees a committed changed-listener.
        if (client.destroy) {
          try {
            await client.destroy();
          } catch {
            // Non-fatal: the original init error is what we care about.
          }
        }
        throw err;
      }
    })();

    try {
      return await this._clientPromise;
    } catch (err) {
      // Reset so a subsequent caller retries (transient module-load
      // or upstream failures should not be terminal).
      this._clientPromise = null;
      throw err;
    }
  }

  private _evaluate(client: UnleashClientLike, identity: FlagIdentity): FlagMap {
    const context = this._buildContext(identity);
    const defs = client.getFeatureToggleDefinitions();
    const filter = this._options.toggleFilter;
    const out: Record<string, FlagValue> = {};
    for (const def of defs) {
      if (filter && !filter(def.name)) continue;
      const enabled = client.isEnabled(def.name, context);
      let value: FlagValue = null;
      if (enabled) {
        const v = client.getVariant(def.name, context);
        if (v && v.enabled) {
          value = _extractVariantValue(v);
        }
      }
      out[def.name] = { enabled, value };
    }
    return Object.freeze(out);
  }

  private _buildContext(identity: FlagIdentity): UnleashContext {
    if (this._options.contextBuilder) return this._options.contextBuilder(identity);
    const properties: Record<string, string> = {};
    const attrs = identity.attrs ?? {};
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) {
        properties[k] = v.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join(",");
      } else if (typeof v === "object") {
        properties[k] = JSON.stringify(v);
      } else if (
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean" ||
        typeof v === "bigint"
      ) {
        // Explicit allow-list for the primitive fall-through. The older
        // `String(v)` catch-all also stringified functions (emitting
        // their full source) and Symbols (emitting `Symbol(desc)`) —
        // both are information-leak footguns when a caller accidentally
        // routes e.g. a method reference through `attrs`. Aligning with
        // FlagsmithProvider's `_sanitizeTraits`: non-primitive exotic
        // types are dropped outright rather than stringified.
        properties[k] = String(v);
      }
      // Everything else (function, symbol) is intentionally dropped —
      // see the rationale above the primitive branch.
    }
    return {
      userId: identity.userId,
      properties,
      environment: this._options.environment,
    };
  }

  private _onChanged(): void {
    const client = this._client;
    /* v8 ignore start -- _onChanged is only attached after _client is set and detached on dispose; the double-guard is defense-in-depth */
    if (this._disposed || !client) return;
    /* v8 ignore stop */
    for (const bucket of this._buckets.values()) {
      /* v8 ignore start -- the unsubscribe closure deletes empty buckets eagerly; an empty bucket reaching this line would require a concurrent unsub race that the synchronous `changed` dispatch does not admit */
      if (bucket.subscribers.size === 0) continue;
      /* v8 ignore stop */
      const next = this._evaluate(client, bucket.identity);
      const serialized = stableStringify(next);
      if (serialized === bucket.lastSerialized) continue;
      bucket.lastSerialized = serialized;
      // Snapshot before iteration — a subscriber's onChange may
      // synchronously unsubscribe.
      for (const entry of Array.from(bucket.subscribers)) {
        entry.onChange(next);
      }
    }
  }
}

/**
 * Map an Unleash variant to the {@link FlagValue} published on the
 * `value` slot of the emitted flag entry.
 *
 * - `payload.type === "json"`: attempt `JSON.parse(payload.value)` and
 *   publish the parsed structure so downstream consumers don't have
 *   to re-parse a nested JSON string themselves. On parse failure,
 *   publish the raw string verbatim — an invalid JSON payload from
 *   the SDK is a vendor-side data issue, not a reason to drop the
 *   variant; the raw string lets the consumer log/inspect it.
 * - Any other `payload.type` (`"string"`, `"number"`, `"csv"`, …):
 *   publish `payload.value` as a string — Unleash's wire contract
 *   delivers all payload values as strings regardless of declared
 *   type, and auto-coercing e.g. `"number"` payloads would change
 *   observable types under the consumer. Leaving them as strings is
 *   aligned with LaunchDarkly's raw behaviour and requires only a
 *   `Number(...)` at the call site if the consumer needs a number.
 * - No payload at all: fall back to the variant name (Unleash's
 *   multivariate A/B/C experiment surface — `bucket_A` / `bucket_B`
 *   etc.). The trailing `?? null` is defensive against a
 *   pathological variant with neither payload nor name (not emitted
 *   by the real SDK).
 */
/* v8 ignore start -- `v.name` / `v.payload.value` are always strings per Unleash's public schema; the trailing nulls exist for SDK versions that stray from the contract */
function _extractVariantValue(v: UnleashVariantLike): FlagValue {
  const payload = v.payload;
  if (payload && typeof payload.value === "string") {
    if (payload.type === "json") {
      try {
        return JSON.parse(payload.value) as FlagValue;
      } catch {
        // Invalid JSON from the upstream — publish the raw string so
        // the consumer can still observe it and diagnose.
        return payload.value;
      }
    }
    return payload.value;
  }
  return v.name ?? null;
}
/* v8 ignore stop */

/**
 * Best-effort `client.off(event, listener)` used during cleanup paths.
 * Tolerates the listener being `null` (never registered) and an `off()`
 * implementation that either does not exist on the SDK version in use
 * or throws — the callers run in error / success-after-ready paths
 * where the original error (if any) is the only failure we care about.
 */
function _detachQuietly(
  client: UnleashClientLike,
  event: string,
  listener: ((...args: unknown[]) => void) | null,
): void {
  /* v8 ignore start -- `listener` is always set by the synchronous Promise executor before control reaches any cleanup call site; the null guard is defense-in-depth for callers who may not have run the executor yet */
  if (!listener) return;
  /* v8 ignore stop */
  if (!client.off) return;
  try {
    client.off(event, listener);
  } catch {
    // Non-fatal.
  }
}
