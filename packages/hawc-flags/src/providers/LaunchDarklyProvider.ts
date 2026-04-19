import type {
  FlagIdentity,
  FlagMap,
  FlagProvider,
  FlagUnsubscribe,
  FlagValue,
  LaunchDarklyContext,
  LaunchDarklyProviderOptions,
  LaunchDarklySingleKindContext,
} from "../types.js";
import { raiseError } from "../raiseError.js";
import { identityKey, stableStringify } from "./_identityKey.js";

const DEFAULT_INIT_TIMEOUT_MS = 5_000;

/**
 * Minimal structural shape we rely on from `@launchdarkly/node-server-sdk`.
 * Declared here rather than imported so the package compiles without the
 * peer dependency installed and remains resilient to minor SDK
 * revisions.
 */
interface LDClientLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  waitForInitialization?(arg?: unknown): Promise<unknown>;
  allFlagsState(context: LaunchDarklyContext, options?: unknown): Promise<LDFlagsStateLike>;
  close?(): Promise<void> | void;
}

interface LDFlagsStateLike {
  valid?: boolean;
  allValues?(): Record<string, unknown>;
  toJSON?(): unknown;
}

interface SubscriberEntry {
  onChange: (next: FlagMap) => void;
}

interface LDBucket {
  identity: FlagIdentity;
  lastSerialized: string;
  subscribers: Set<SubscriberEntry>;
  /**
   * Guard against stacking overlapping evaluations for the same bucket.
   * `update` can fire bursts (one per changed flag) and each evaluation
   * is async, so a naive `void this._fanOut(...)` would interleave
   * fan-outs and potentially deliver an older evaluation after a newer
   * one. We serialize per-bucket: while an evaluation is in flight, the
   * next `update` is marked `pending` and the in-flight task re-runs
   * once on completion.
   */
  inFlight: Promise<void> | null;
  pending: boolean;
}

/**
 * LaunchDarkly-backed {@link FlagProvider}.
 *
 * Uses `@launchdarkly/node-server-sdk` (declared as an optional peer dep)
 * loaded via dynamic import. Architecturally mirrors
 * {@link UnleashProvider}: the SDK streams upstream updates and emits
 * `update` on every flag change, so fan-out is event-driven — no
 * per-identity timer.
 *
 * The {@link FlagIdentity} → {@link LaunchDarklyContext} mapping
 * constructs a single-kind user context by default (`{ kind: "user",
 * key: identity.userId, ...identity.attrs }`). Override via
 * `options.contextBuilder` for multi-kind contexts or
 * project-specific attribute shapes.
 *
 * Output shape is controlled by {@link LaunchDarklyProviderOptions.valueShape}:
 * `"wrapped"` (default) publishes `{ enabled, value }` entries so a
 * single `data-wcs` template (`values.flags.X.enabled`) works across
 * Flagsmith / Unleash / LaunchDarkly identically; `"raw"` publishes
 * LD's native value types directly — pick this for an LD-only frontend
 * where wrapping would surprise readers used to LD's semantics.
 */
export class LaunchDarklyProvider implements FlagProvider {
  private _options: LaunchDarklyProviderOptions;
  private _clientPromise: Promise<LDClientLike> | null = null;
  private _client: LDClientLike | null = null;
  private _buckets: Map<string, LDBucket> = new Map();
  private _updateListener: ((...args: unknown[]) => void) | null = null;
  private _disposed = false;

  constructor(options: LaunchDarklyProviderOptions) {
    if (!options || !options.sdkKey) {
      raiseError("LaunchDarklyProvider: `sdkKey` is required.");
    }
    // `"multi"` is reserved for the root of a multi-kind context and
    // invalid on a single-kind context. TypeScript cannot natively
    // express "any string except 'multi'" on the `contextKind` field
    // without forcing casts everywhere, so we gate it at runtime —
    // otherwise the default builder would silently produce
    // `{ kind: "multi", key: userId }`, which LD rejects downstream
    // with a far less actionable error.
    //
    // Scope: this check covers only the default-builder path. A custom
    // `contextBuilder` is free to return a malformed `{ kind: "multi",
    // key }` single-kind-shaped object; the Provider does not
    // re-validate its output and the LD SDK's own context validation
    // surfaces the error at evaluation time. Extending this guard to
    // contextBuilder results would couple the Provider to LD's
    // validation rules and duplicate work the SDK already performs.
    if (options.contextKind === "multi") {
      raiseError(
        "LaunchDarklyProvider: `contextKind: \"multi\"` is reserved for multi-kind contexts. Supply a `contextBuilder` returning a LaunchDarklyMultiKindContext instead.",
      );
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
      raiseError("LaunchDarklyProvider: cannot subscribe on a disposed provider.");
    }
    const key = identityKey(identity);
    let bucket = this._buckets.get(key);
    if (!bucket) {
      bucket = {
        identity,
        // Seed the change-detection baseline with the caller-supplied
        // initial snapshot. When omitted, the sentinel falls through
        // and the first `update`-driven re-evaluation acts as the
        // initial push — same ordering semantics as UnleashProvider.
        lastSerialized: initial !== undefined ? stableStringify(initial) : "__INIT__",
        subscribers: new Set(),
        inFlight: null,
        pending: false,
      };
      this._buckets.set(key, bucket);
    }
    // NB: once a bucket exists, its `lastSerialized` is authoritative.
    // A later subscriber's `initial` is ignored for the same reason as
    // UnleashProvider/FlagsmithProvider — see the comments there.

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
    // Re-evaluate against the SDK's current cache. The SDK's own
    // streaming/polling controls upstream freshness; applications
    // needing sub-stream freshness should lower `pollInterval` (or
    // flush via LD's operational tools) rather than spam `reload()`.
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
      if (this._updateListener && client.off) {
        try {
          client.off("update", this._updateListener);
        } catch {
          // Non-fatal.
        }
      }
      if (client.close) {
        try {
          await client.close();
        } catch {
          // Non-fatal.
        }
      }
    }
    this._client = null;
    this._clientPromise = null;
    this._updateListener = null;
  }

  // --- Private --------------------------------------------------------------

  private async _getClient(): Promise<LDClientLike> {
    if (this._disposed) raiseError("LaunchDarklyProvider: provider has been disposed.");
    if (this._client) return this._client;
    if (this._clientPromise) return this._clientPromise;

    this._clientPromise = (async () => {
      let mod: Record<string, unknown>;
      try {
        /*
         * Optional peer dep. Use a ts-ignore (not a ts-expect-error)
         * because the directive needs to stay a no-op both when the
         * consumer HAS `@launchdarkly/node-server-sdk` installed and
         * when they DO NOT (TS2307) — the ignore is stable across
         * both install states.
         */
        // @ts-ignore
        mod = await import("@launchdarkly/node-server-sdk");
      } catch (err) {
        /* v8 ignore start -- dynamic-import rejections are always Error in both native and vitest runtimes; the String(err) branch is defensive */
        const message = err instanceof Error ? err.message : String(err);
        /* v8 ignore stop */
        raiseError(
          `LaunchDarklyProvider: failed to load "@launchdarkly/node-server-sdk" — install it as a peer dependency. Original error: ${message}`,
        );
      }

      // Probe for `init(sdkKey, options)`. LD's Node SDK exposes it
      // as a named export (ESM) and on the default export (CJS
      // interop path). Probe `mod` first (native ESM), then
      // `mod.default` (CJS consumer). `in` guards avoid vitest's
      // strict-mock error on accessing undefined named exports.
      let init: ((key: string, opts?: unknown) => LDClientLike) | null = null;
      if ("init" in mod && typeof (mod as { init?: unknown }).init === "function") {
        init = (mod as { init: (key: string, opts?: unknown) => LDClientLike }).init;
      } else if ("default" in mod) {
        const def = (mod as { default?: unknown }).default;
        /* v8 ignore start -- the object / typeof / nested init guards are defensive against malformed default exports (e.g. `default: null`); the covered CJS path has a well-formed object default */
        if (def && typeof def === "object" && "init" in def
            && typeof (def as { init?: unknown }).init === "function") {
          /* v8 ignore stop */
          init = (def as { init: (key: string, opts?: unknown) => LDClientLike }).init;
        }
      }
      if (!init) {
        raiseError("LaunchDarklyProvider: `@launchdarkly/node-server-sdk` module did not expose `init`.");
      }

      const sdkOptions: Record<string, unknown> = {};
      if (this._options.streamUri !== undefined) sdkOptions.streamUri = this._options.streamUri;
      if (this._options.baseUri !== undefined) sdkOptions.baseUri = this._options.baseUri;
      if (this._options.eventsUri !== undefined) sdkOptions.eventsUri = this._options.eventsUri;
      if (this._options.stream !== undefined) sdkOptions.stream = this._options.stream;
      if (this._options.pollInterval !== undefined) sdkOptions.pollInterval = this._options.pollInterval;
      if (this._options.disableEvents !== undefined) sdkOptions.sendEvents = !this._options.disableEvents;

      const client = init(this._options.sdkKey, sdkOptions);

      // From this point on the SDK has already begun background work
      // (streaming socket / polling loop, events flush). Any failure
      // before we commit the client must tear it down, or retries
      // after a transient outage would leak dead SDK instances.
      try {
        if (client.waitForInitialization) {
          // `@launchdarkly/node-server-sdk` v9 accepts `{ timeout }` in
          // seconds; older majors accept a bare number. The peer-dep
          // range is `^9`, so we commit to the object form.
          const timeoutSeconds = (this._options.initializationTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS) / 1000;
          await client.waitForInitialization({ timeout: timeoutSeconds });
        }

        // Race-check: `dispose()` that ran while we were awaiting
        // initialization could not tear down this client because
        // `_client` was still null — it only flipped `_disposed`.
        // If we commit now, the half-built client lives forever on a
        // disposed Provider with its streaming / events loops still
        // running. Raise into the catch below so the standard
        // cleanup path runs.
        if (this._disposed) {
          raiseError("LaunchDarklyProvider: disposed during initialization.");
        }

        // Wire the update fan-out once the client is ready.
        const onUpdate = (...args: unknown[]): void => this._onUpdate(args);
        this._updateListener = onUpdate;
        client.on("update", onUpdate);

        this._client = client;
        return client;
      } catch (err) {
        if (client.close) {
          try {
            await client.close();
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

  private async _evaluate(client: LDClientLike, identity: FlagIdentity): Promise<FlagMap> {
    const context = this._buildContext(identity);
    const state = await client.allFlagsState(
      context,
      this._options.clientSideOnly ? { clientSideOnly: true } : undefined,
    );
    const values = typeof state.allValues === "function" ? state.allValues() : {};
    const filter = this._options.flagFilter;
    const shape = this._options.valueShape ?? "wrapped";
    const out: Record<string, FlagValue> = {};
    for (const k of Object.keys(values)) {
      if (filter && !filter(k)) continue;
      out[k] = shape === "wrapped" ? _wrapValue(values[k]) : (values[k] as FlagValue);
    }
    return Object.freeze(out);
  }

  private _buildContext(identity: FlagIdentity): LaunchDarklyContext {
    if (this._options.contextBuilder) return this._options.contextBuilder(identity);
    const kind = this._options.contextKind ?? "user";
    const ctx: LaunchDarklySingleKindContext = {
      kind,
      key: identity.userId,
    };
    const attrs = identity.attrs ?? {};
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      // Skip undefined — LD's context schema treats undefined as
      // "attribute not present" and serializing it as null would
      // change targeting semantics. Preserve null explicitly (it is
      // a valid trait value in LD).
      if (v === undefined) continue;
      // Never allow caller attrs to overwrite the structural keys
      // (`kind`, `key`). Consumers who need a non-default kind should
      // pass `contextKind` or supply a `contextBuilder`.
      if (k === "kind" || k === "key") continue;
      ctx[k] = v;
    }
    return ctx;
  }

  private _onUpdate(_args: unknown[]): void {
    const client = this._client;
    /* v8 ignore start -- _onUpdate is only attached after _client is set and detached on dispose; the double-guard is defense-in-depth */
    if (this._disposed || !client) return;
    /* v8 ignore stop */
    for (const bucket of this._buckets.values()) {
      /* v8 ignore start -- the unsubscribe closure deletes empty buckets eagerly; an empty bucket reaching this line would require a concurrent unsub race that the synchronous `update` dispatch does not admit */
      if (bucket.subscribers.size === 0) continue;
      /* v8 ignore stop */
      if (bucket.inFlight) {
        // Coalesce: re-run after the current evaluation finishes.
        bucket.pending = true;
        continue;
      }
      this._startFanOut(client, bucket);
    }
  }

  private _startFanOut(client: LDClientLike, bucket: LDBucket): void {
    bucket.inFlight = (async () => {
      do {
        bucket.pending = false;
        let next: FlagMap;
        try {
          next = await this._evaluate(client, bucket.identity);
        } catch {
          // Treat transient evaluation failures as "no change" — the
          // last good map stays in place. FlagsCore's error surface
          // is reserved for user-initiated identify/reload failures
          // so a background update hiccup does not flicker the UI
          // error banner.
          return;
        }
        // A concurrent dispose / final-unsubscribe that landed while
        // we were awaiting the evaluation may have torn this bucket
        // down. Silently drop the result rather than fanning out to
        // an empty Set.
        if (this._disposed || bucket.subscribers.size === 0) return;
        const serialized = stableStringify(next);
        if (serialized === bucket.lastSerialized) continue;
        bucket.lastSerialized = serialized;
        // Snapshot before iteration — a subscriber's onChange may
        // synchronously unsubscribe.
        for (const entry of Array.from(bucket.subscribers)) {
          entry.onChange(next);
        }
      } while (bucket.pending);
    })().finally(() => {
      bucket.inFlight = null;
    });
  }
}

/**
 * Map a raw LD flag value into the wrapped `{ enabled, value }` shape
 * used by Flagsmith/Unleash. Rules:
 *
 * - `true` / `false` → `{ enabled: v, value: v }` — boolean flags carry
 *   identical enabled/value for callers who only want one axis.
 * - `null` / `undefined` → `{ enabled: false, value: null }` — treated
 *   as "flag missing / no variation".
 * - everything else (string / number / array / object) →
 *   `{ enabled: true, value: v }` — non-boolean variations always count
 *   as "flag delivered a variation".
 *
 * This produces a FlagValue that satisfies the package-wide
 * `values.flags.X.enabled` / `.value` access pattern without losing
 * the typed payload.
 */
function _wrapValue(v: unknown): FlagValue {
  if (typeof v === "boolean") return { enabled: v, value: v };
  if (v === null || v === undefined) return { enabled: false, value: null };
  return { enabled: true, value: v as FlagValue };
}
