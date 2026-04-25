import type {
  FlagIdentity,
  FlagMap,
  FlagProvider,
  FlagsmithProviderOptions,
  FlagUnsubscribe,
  FlagValue,
} from "../types.js";
import { raiseError } from "../raiseError.js";
import { identityKey as _identityKey, stableStringify as _stableStringify } from "./_identityKey.js";

const DEFAULT_POLLING_INTERVAL_MS = 30_000;
const DEFAULT_ENVIRONMENT_REFRESH_SECONDS = 60;

/**
 * Module-scope flag gating the "realtime accepted but not implemented"
 * warning to a single dispatch per process. Without this, every
 * FlagsmithProvider construction with `realtime: true` re-logs — a
 * framework that rebuilds the provider on every request would flood
 * the log stream with the same warning per request. Exposed for tests
 * via {@link __resetRealtimeWarning} so assertions on the warning's
 * presence / absence can run independently.
 */
let _realtimeWarningLogged = false;

/** Test-only reset of the one-shot realtime-warning guard. */
export function __resetRealtimeWarning(): void {
  _realtimeWarningLogged = false;
}

/**
 * Minimal shape we rely on from `flagsmith-nodejs`. Declared
 * structurally here rather than imported so the package compiles
 * without the peer dependency installed, and so future SDK releases
 * that add fields don't break type-checking.
 */
interface FlagsmithClientLike {
  getIdentityFlags(identifier: string, traits?: Record<string, unknown>): Promise<FlagsmithIdentityFlagsLike>;
  close?(): Promise<void> | void;
}

interface FlagsmithIdentityFlagsLike {
  /** Returns every flag as an array — Flagsmith v5 API. */
  getAllFlags?(): FlagsmithFlagLike[];
  /** Older API shape. */
  allFlags?(): FlagsmithFlagLike[];
}

interface FlagsmithFlagLike {
  featureName?: string;
  feature?: { name?: string };
  enabled: boolean;
  value?: unknown;
}

/**
 * Flagsmith-backed {@link FlagProvider}.
 *
 * Uses `flagsmith-nodejs` (declared as an optional peer dep) loaded via
 * dynamic import, so consumers who pick a different provider do not pay
 * the install cost.
 *
 * Update delivery is polling-only in v1. `options.realtime` is accepted
 * for forward compatibility but currently logs a warning and falls back
 * to polling — true SSE support (`realtime.flagsmith.com/sse`) will
 * land in a follow-up. The polling interval defaults to 30 s; set
 * `pollingIntervalMs: 0` to disable background polling entirely if the
 * application only cares about identify-time / explicit `reload()` values.
 *
 * Trait mapping: {@link FlagIdentity.attrs} is forwarded verbatim as
 * Flagsmith traits. `FlagsCore` already flattens an Auth0 `UserContext`
 * into a Flagsmith-friendly shape (`org_id`, `permissions`, `roles`,
 * `email`, `name`), so no further translation is applied here.
 */
/**
 * One entry per `subscribe()` call. The Set that holds these lives on
 * the {@link PollerBucket}; wrapping each subscription in a fresh
 * object keeps duplicate `onChange` references as independent logical
 * subscriptions — `subscribe(id, fn); subscribe(id, fn)` yields two
 * distinct unsubscribes that disable one subscription each. Storing
 * raw function references in a Set would dedupe by identity and
 * collapse the two calls into one, breaking the N-subscribe →
 * N-independent-unsub contract on {@link FlagProvider}.
 */
interface SubscriberEntry {
  onChange: (next: FlagMap) => void;
}

/**
 * Shared polling state for every subscriber bound to the same identity key.
 * One bucket = one `setInterval`; `subscribers` fans out each unique flag
 * change to all registered entries.
 */
interface PollerBucket {
  identity: FlagIdentity;
  timer: ReturnType<typeof setInterval> | null;
  /**
   * JSON-serialized last known snapshot. Seeded from the `initial`
   * passed to `subscribe()` (the caller's own identify/reload result)
   * and thereafter updated on each poll that produces a new value or
   * on a `reload()` that lands while the bucket is live.
   */
  lastSerialized: string;
  subscribers: Set<SubscriberEntry>;
}

export class FlagsmithProvider implements FlagProvider {
  private _options: FlagsmithProviderOptions;
  private _clientPromise: Promise<FlagsmithClientLike> | null = null;
  private _client: FlagsmithClientLike | null = null;
  /**
   * identityKey → PollerBucket. A single timer per identity fans out to
   * N subscribers, keeping API calls O(#identities) rather than
   * O(#subscribers).
   *
   * Baseline state is carried ONLY in the bucket. When the last
   * subscriber leaves and the bucket is destroyed, all identity-keyed
   * state is released with it — no long-lived cache keyed by identity
   * that would grow unboundedly on a long-running server.
   */
  private _pollers: Map<string, PollerBucket> = new Map();
  private _disposed = false;

  constructor(options: FlagsmithProviderOptions) {
    if (!options || !options.environmentKey) {
      raiseError("FlagsmithProvider: `environmentKey` is required.");
    }
    this._options = options;
    if (options.realtime && !_realtimeWarningLogged) {
      _realtimeWarningLogged = true;
      console.warn(
        "[@wc-bindable/flags] FlagsmithProvider: `realtime` is accepted but not yet implemented — falling back to polling. Lower `pollingIntervalMs` for faster change detection. (This warning is logged once per process.)",
      );
    }
  }

  async identify(identity: FlagIdentity): Promise<FlagMap> {
    const client = await this._getClient();
    return this._fetch(client, identity);
  }

  subscribe(
    identity: FlagIdentity,
    onChange: (next: FlagMap) => void,
    initial?: FlagMap,
  ): FlagUnsubscribe {
    if (this._disposed) {
      raiseError("FlagsmithProvider: cannot subscribe on a disposed provider.");
    }

    const intervalMs = this._options.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
    const key = _identityKey(identity);

    let bucket = this._pollers.get(key);
    if (!bucket) {
      bucket = {
        identity,
        timer: null,
        // Seed the change-detection baseline with the caller-supplied
        // initial snapshot. When omitted (direct API users who skip
        // identify()), the sentinel falls through and the first poll
        // functions as the initial push — acceptable for that rarer
        // path. FlagsCore always passes the identify() result here.
        lastSerialized: initial !== undefined ? _stableStringify(initial) : "__INIT__",
        subscribers: new Set(),
      };
      if (intervalMs > 0) {
        const capturedBucket = bucket;
        bucket.timer = setInterval(() => {
          void this._pollBucket(capturedBucket);
        }, intervalMs);
        // Node-specific: avoid preventing process exit. Silently
        // tolerated on platforms without `.unref()`.
        const t = bucket.timer as unknown as { unref?: () => void };
        /* v8 ignore start -- `unref` is always a function in Node; the guard is only for non-Node timer backends */
        if (typeof t.unref === "function") t.unref();
        /* v8 ignore stop */
      }
      this._pollers.set(key, bucket);
    }
    // NB: once a bucket exists, its `lastSerialized` is authoritative.
    // A later subscriber's `initial` is intentionally ignored, even if
    // it appears fresher: without a trusted ordering signal we cannot
    // tell stale from fresh, and rolling the baseline backward would
    // replay already-delivered changes to existing subscribers, while
    // rolling it forward would silently deny existing subscribers the
    // transition from their own `initial` to the bucket's observed
    // state. The bucket only updates its baseline via observed poll
    // results or an explicit `reload()`. A late subscriber with fresh
    // data accepts at most one redundant `onChange` fire on the next
    // poll tick — the right trade for correctness on existing peers.

    // Wrap in a fresh entry so duplicate `onChange` references remain
    // independent logical subscriptions (see SubscriberEntry).
    const entry: SubscriberEntry = { onChange };
    bucket.subscribers.add(entry);

    return () => {
      const current = this._pollers.get(key);
      if (!current) return;
      if (!current.subscribers.delete(entry)) return;
      if (current.subscribers.size === 0) {
        if (current.timer) clearInterval(current.timer);
        this._pollers.delete(key);
      }
    };
  }

  async reload(identity: FlagIdentity): Promise<FlagMap> {
    const client = await this._getClient();
    const map = await this._fetch(client, identity);
    // Keep any active poller's baseline in sync so the next poll does
    // not re-fire the same content as a "change" just because reload
    // happened to run between poll ticks. When no bucket exists, there
    // is nothing to keep in sync — the caller owns the returned map
    // and can pass it to a subsequent subscribe() as `initial`.
    const bucket = this._pollers.get(_identityKey(identity));
    if (bucket) bucket.lastSerialized = _stableStringify(map);
    return map;
  }

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    for (const bucket of this._pollers.values()) {
      if (bucket.timer) clearInterval(bucket.timer);
      bucket.subscribers.clear();
    }
    this._pollers.clear();
    if (this._client?.close) {
      try {
        await this._client.close();
      } catch {
        // Non-fatal.
      }
    }
    this._client = null;
    this._clientPromise = null;
  }

  // --- Private --------------------------------------------------------------

  private async _getClient(): Promise<FlagsmithClientLike> {
    if (this._disposed) raiseError("FlagsmithProvider: provider has been disposed.");
    if (this._client) return this._client;
    if (this._clientPromise) return this._clientPromise;

    this._clientPromise = (async () => {
      let mod: { Flagsmith?: new (opts: unknown) => FlagsmithClientLike; default?: new (opts: unknown) => FlagsmithClientLike };
      try {
        /*
         * Optional peer dep — see UnleashProvider for the rationale.
         * TL;DR: a ts-expect-error directive flips between "needed"
         * (consumer has not installed the peer → TS2307) and "unused"
         * (consumer installed it → TS2578), breaking the build in
         * whichever install state it does not expect. ts-ignore is a
         * stable no-op across both states.
         */
        // @ts-ignore
        mod = await import("flagsmith-nodejs");
      } catch (err) {
        /* v8 ignore start -- dynamic-import rejections are always Error in both native and vitest runtimes; the String(err) branch is defensive */
        const message = err instanceof Error ? err.message : String(err);
        /* v8 ignore stop */
        raiseError(
          `FlagsmithProvider: failed to load "flagsmith-nodejs" — install it as a peer dependency. Original error: ${message}`,
        );
      }
      const Ctor = mod.Flagsmith ?? mod.default;
      if (!Ctor) {
        raiseError("FlagsmithProvider: `flagsmith-nodejs` module did not expose a Flagsmith constructor.");
      }
      const client = new Ctor({
        environmentKey: this._options.environmentKey,
        apiUrl: this._options.apiUrl,
        enableLocalEvaluation: this._options.enableLocalEvaluation ?? false,
        environmentRefreshIntervalSeconds:
          this._options.environmentRefreshIntervalSeconds ?? DEFAULT_ENVIRONMENT_REFRESH_SECONDS,
      });
      // Race-check: `dispose()` that fired while `await import()` was
      // pending could not close this client (it was still null on the
      // Provider); it only flipped `_disposed`. Constructing a fresh
      // client here (with local-evaluation the SDK starts an upstream
      // poller in its constructor) and then committing would strand
      // that SDK on a disposed Provider. Close it and bail now.
      if (this._disposed) {
        if (client.close) {
          try {
            await client.close();
          } catch {
            // Non-fatal.
          }
        }
        raiseError("FlagsmithProvider: disposed during initialization.");
      }
      this._client = client;
      return client;
    })();

    try {
      return await this._clientPromise;
    } catch (err) {
      // Reset the promise so a subsequent call can retry (transient
      // module-resolution blips, misconfigured bundlers, etc.).
      this._clientPromise = null;
      throw err;
    }
  }

  private async _fetch(client: FlagsmithClientLike, identity: FlagIdentity): Promise<FlagMap> {
    // Sanitize traits before they hit Flagsmith's wire. `identity.attrs`
    // is typed `Record<string, unknown>` so user-code Providers /
    // identify() callers could slip in anything — nested objects,
    // functions, Symbols, raw tokens. Flagsmith's trait API only
    // meaningfully consumes scalars, so passing arbitrary structures
    // would at best be silently dropped by the SDK's JSON encoder and
    // at worst leak values the caller never intended to ship upstream.
    // Keep only primitives (string / number / boolean / null); arrays
    // are CSV-joined to match the Unleash context mapping; nested
    // objects are dropped rather than stringified — a stringified
    // object entering a rule predicate as a single opaque string is
    // a footgun, and the consumer should opt in explicitly if they
    // want that shape.
    const traits = _sanitizeTraits(identity.attrs);
    const result = await client.getIdentityFlags(identity.userId, traits);
    return _flattenFlagsmithResult(result);
  }

  private async _pollBucket(bucket: PollerBucket): Promise<void> {
    /* v8 ignore start -- dispose() clears timers before the flag flips, so a disposed poll never actually starts in practice */
    if (this._disposed) return;
    /* v8 ignore stop */
    let client: FlagsmithClientLike;
    try {
      client = await this._getClient();
    } catch {
      // Client unavailable (module load failed). The next poll will
      // retry; surfacing to the Core via onChange isn't meaningful
      // here — the identify() path already reported the error.
      return;
    }
    let next: FlagMap;
    try {
      next = await this._fetch(client, bucket.identity);
    } catch {
      // Treat transient fetch failures as "no change" — the last
      // good map stays in place. FlagsCore's own error surface is
      // reserved for user-initiated identify/reload failures so a
      // background poll hiccup doesn't flicker the UI error banner.
      return;
    }

    // A concurrent dispose / final-unsubscribe that landed while we
    // were awaiting the fetch may have torn this bucket down. Silently
    // drop the result rather than fanning out to an empty Set.
    if (bucket.subscribers.size === 0) return;

    const serialized = _stableStringify(next);
    if (serialized === bucket.lastSerialized) return;
    bucket.lastSerialized = serialized;
    // Snapshot the subscriber set before iteration: a subscriber's
    // onChange handler could unsubscribe (and thus mutate the Set)
    // synchronously, and we want every subscriber at poll time to see
    // this tick.
    for (const entry of Array.from(bucket.subscribers)) {
      entry.onChange(next);
    }
  }
}

/**
 * Coerce a free-form `identity.attrs` bag into the scalar trait shape
 * Flagsmith consumes. Arrays are CSV-joined (stringifying any nested
 * objects); nested plain objects, functions, Symbols, and `undefined`
 * values are dropped outright. Returns `undefined` when the sanitized
 * bag is empty, so the underlying SDK call receives no traits argument
 * rather than an empty object — matches the pre-sanitization behaviour
 * for callers that never supplied attrs at all.
 */
function _sanitizeTraits(
  attrs: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> | undefined {
  if (!attrs) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const k of Object.keys(attrs)) {
    const v = attrs[k];
    if (v === null) {
      out[k] = null;
    } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (Array.isArray(v)) {
      // CSV join, stringifying nested objects element-wise so the
      // shape matches UnleashProvider's context mapping.
      out[k] = v
        .map((e) => (typeof e === "string" ? e : JSON.stringify(e)))
        .join(",");
    }
    // Everything else (nested objects, functions, Symbols, undefined)
    // is intentionally dropped rather than stringified — see comment
    // at the call site for the rationale.
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function _flattenFlagsmithResult(result: FlagsmithIdentityFlagsLike): FlagMap {
  const list: FlagsmithFlagLike[] =
    (typeof result.getAllFlags === "function" && result.getAllFlags()) ||
    (typeof result.allFlags === "function" && result.allFlags()) ||
    [];
  const out: Record<string, FlagValue> = {};
  for (const f of list) {
    const name = f.featureName ?? f.feature?.name;
    if (!name) continue;
    // Shape chosen to match Flagsmith's mental model:
    //   enabled: boolean toggle state
    //   value:   remote config value (may be null for pure toggles)
    // Access via `values.flags.<name>.enabled` / `.value`.
    out[name] = {
      enabled: !!f.enabled,
      value: (f.value ?? null) as FlagValue,
    };
  }
  return Object.freeze(out);
}

