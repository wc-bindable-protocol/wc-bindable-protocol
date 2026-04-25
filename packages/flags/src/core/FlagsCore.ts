import { raiseError } from "../raiseError.js";
import { deepCloneAndFreeze } from "../freeze.js";
import type {
  FlagIdentity,
  FlagMap,
  FlagProvider,
  FlagsCoreOptions,
  FlagUnsubscribe,
  IWcBindable,
  UserContextLike,
} from "../types.js";

const EMPTY_FLAGS: FlagMap = Object.freeze({});

/**
 * Server-side feature flag Core.
 *
 * Runs in any JavaScript runtime (Node, Deno, Bun, Cloudflare Workers).
 * Talks to the underlying flag service through a pluggable
 * {@link FlagProvider}. Exposes a minimal bindable surface whose only
 * observable property is the full flag map — individual flags are
 * addressed through dotted-path access (`values.flags.<key>`).
 *
 * Lifecycle:
 *
 * 1. Construction captures the provider and optional `userContext`.
 *    No network I/O is performed.
 * 2. If `userContext` is present, `_autoIdentify()` fires on first
 *    public method call (or can be explicitly awaited via
 *    `ensureIdentified()`). This avoids doing work in the constructor
 *    — which runs on the server before the transport is even open —
 *    while still letting the client-side session light up `ready` with
 *    a real flag map in the initial sync batch.
 * 3. `identify()` / `reload()` publish a new `flags` snapshot on
 *    completion. Provider-push updates flow through `subscribe` and
 *    publish the same way.
 */
export class FlagsCore extends EventTarget {
  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "flags",      event: "feature-flags:flags-changed" },
      { name: "identified", event: "feature-flags:identified-changed" },
      { name: "loading",    event: "feature-flags:loading-changed" },
      { name: "error",      event: "feature-flags:error" },
    ],
    commands: [
      { name: "identify", async: true },
      { name: "reload",   async: true },
    ],
  };

  private _target: EventTarget;
  private _provider: FlagProvider;
  private _userContext: UserContextLike | null;

  private _flags: FlagMap = EMPTY_FLAGS;
  private _identified = false;
  private _loading = false;
  private _error: Error | null = null;

  private _currentIdentity: FlagIdentity | null = null;
  private _unsubscribeProvider: FlagUnsubscribe | null = null;
  private _disposed = false;

  // Monotonic counter bumped on every identity transition or dispose.
  // Guards async results from superseded identify() / reload() calls
  // against overwriting state owned by a newer identity.
  private _generation = 0;

  // Coalesce auto-identify: multiple concurrent callers (e.g. initial
  // sync + explicit reload() from the client) must observe the same
  // in-flight promise, not race parallel provider calls.
  private _autoIdentifyPromise: Promise<void> | null = null;

  constructor(options: FlagsCoreOptions) {
    super();
    if (!options || !options.provider) {
      raiseError("FlagsCore: `provider` is required.");
    }
    this._target = options.target ?? this;
    this._provider = options.provider;
    this._userContext = options.userContext ?? null;
  }

  // --- Bindable properties --------------------------------------------------

  /**
   * Current flag map. Frozen snapshot; never mutated in place. A change
   * yields a new object reference so reactive frameworks that rely on
   * reference equality detect the update honestly.
   */
  get flags(): FlagMap {
    return this._flags;
  }

  get identified(): boolean {
    return this._identified;
  }

  get loading(): boolean {
    return this._loading;
  }

  get error(): Error | null {
    return this._error;
  }

  // --- Commands -------------------------------------------------------------

  /**
   * Identify the caller and load the initial flag snapshot.
   *
   * Replaces any prior identity. If the provider supports push updates,
   * this also registers the subscription; an earlier subscription is
   * unwound first.
   */
  async identify(userId: string, attrs?: Record<string, unknown>): Promise<void> {
    if (this._disposed) raiseError("FlagsCore: instance has been disposed.");
    if (!userId) raiseError("FlagsCore.identify: `userId` is required.");

    this._autoIdentifyPromise = null;

    const identity: FlagIdentity = {
      userId,
      attrs: attrs ? { ...attrs } : undefined,
    };
    await this._doIdentify(identity);
  }

  /**
   * Reload the current identity's flag snapshot, bypassing any
   * provider-side cache. No-op if the Core has never been identified.
   */
  async reload(): Promise<void> {
    if (this._disposed) raiseError("FlagsCore: instance has been disposed.");

    // Branch order matters: `_currentIdentity` is the authoritative
    // record of "what identity are we currently trying to run for".
    // It is set at the start of every `identify()` / `updateUserContext()`
    // cycle and is preserved across a failed `_doIdentify` so that
    // reload() can retry the same identity. If we checked
    // `_userContext` first, an explicit `identify("bob")` that failed
    // would silently roll back to the `_userContext`-derived identity
    // (e.g. alice) on the next reload, contradicting the "retry the
    // identity we were just trying" contract.
    const identity = this._currentIdentity;

    if (identity) {
      if (!this._identified) {
        // Current identity has no committed flag map yet (typically
        // an earlier identify() threw partway through). Re-run
        // identify rather than a cache-bypass fetch — reload must
        // not publish flags for an un-committed identity.
        await this._doIdentify(identity);
        return;
      }

      // Normal case: identify was committed, run a cache-bypass
      // fetch for the same identity.
      const myGen = this._generation;
      this._setError(null);
      this._setLoading(true);
      try {
        const next = await this._provider.reload(identity);
        if (this._generation !== myGen) return;
        this._publishFlags(next);
      } catch (err) {
        if (this._generation !== myGen) return;
        this._setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (this._generation === myGen) this._setLoading(false);
      }
      return;
    }

    // No `_currentIdentity` — no identify() has ever been called,
    // successful or otherwise. If a `userContext` is armed, auto-
    // identify with it now; otherwise this is a silent no-op
    // (matches the "errors do not throw" contract — callers that
    // need a hard failure can gate on `identified`).
    if (this._userContext) {
      await this.ensureIdentified();
    }
  }

  /**
   * Trigger auto-identify (if armed) and wait for the first snapshot.
   *
   * Called internally by `reload()` when no identity is set yet, and
   * exposed publicly so the remote session can force the Core to
   * produce a non-empty initial sync. Safe to call concurrently — all
   * callers share the same in-flight promise.
   */
  async ensureIdentified(): Promise<void> {
    if (this._identified || !this._userContext) return;
    if (this._autoIdentifyPromise) return this._autoIdentifyPromise;
    this._autoIdentifyPromise = this._autoIdentify();
    try {
      await this._autoIdentifyPromise;
    } finally {
      this._autoIdentifyPromise = null;
    }
  }

  /**
   * Propagate a refreshed `UserContext` (typically fired by auth0-gate's
   * `onTokenRefresh`). Re-identifies if `sub` or any targeting-relevant
   * trait has changed, otherwise no-ops.
   */
  async updateUserContext(user: UserContextLike): Promise<void> {
    if (this._disposed) return;
    const prev = this._userContext;
    this._userContext = user;

    // Decide if traits that feed targeting have actually changed.
    // A change in `raw` alone (non-RBAC claims) doesn't warrant a
    // re-identify — the provider's attrs surface only carries the
    // structured RBAC / profile fields.
    if (
      prev &&
      prev.sub === user.sub &&
      prev.email === user.email &&
      prev.name === user.name &&
      _sameStringSet(prev.permissions ?? [], user.permissions ?? []) &&
      _sameStringSet(prev.roles ?? [], user.roles ?? []) &&
      prev.orgId === user.orgId
    ) {
      return;
    }

    const identity = _buildIdentity(user);
    await this._doIdentify(identity);
  }

  /**
   * Release provider resources and tear down subscriptions. After
   * dispose, `identify()` / `reload()` throw synchronously; `flags`
   * retains its last value so an already-bound client does not see its
   * state wiped.
   */
  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    this._generation++;
    this._autoIdentifyPromise = null;

    if (this._unsubscribeProvider) {
      try {
        this._unsubscribeProvider();
      } catch {
        // Subscriber cleanup errors are non-fatal.
      }
      this._unsubscribeProvider = null;
    }

    if (this._provider.dispose) {
      try {
        await this._provider.dispose();
      } catch {
        // Provider dispose errors are non-fatal.
      }
    }
  }

  // --- Private --------------------------------------------------------------

  private async _autoIdentify(): Promise<void> {
    /* v8 ignore start -- ensureIdentified gates on _userContext before calling this; defensive inner guard */
    if (!this._userContext) return;
    /* v8 ignore stop */
    const identity = _buildIdentity(this._userContext);
    await this._doIdentify(identity);
  }

  private async _doIdentify(identity: FlagIdentity): Promise<void> {
    // Bump generation BEFORE starting new work so any still-running
    // prior identify() observes a mismatched generation on resume.
    this._generation++;
    const myGen = this._generation;

    // Tear down the previous subscription immediately. A provider that
    // keeps open SSE / polling per-identity would otherwise leak one
    // subscription per identify() call.
    if (this._unsubscribeProvider) {
      try {
        this._unsubscribeProvider();
      } catch {
        // ignore
      }
      this._unsubscribeProvider = null;
    }

    this._currentIdentity = identity;
    this._setError(null);
    this._setLoading(true);

    let initial: FlagMap;
    try {
      initial = await this._provider.identify(identity);
    } catch (err) {
      if (this._generation !== myGen) return;
      // The identify cycle for `identity` did NOT commit a flag map.
      // We already tore down the previous identity's subscription and
      // reassigned `_currentIdentity`, so the *old* `_flags` no longer
      // corresponds to `_currentIdentity`. Leaving them in place would
      // violate the invariant "`identified === true` ⇒ `flags` reflect
      // `_currentIdentity`" and — crucially — a subsequent `reload()`
      // would then fetch for the new identity and silently flip the
      // flag map without a matching identify cycle, which is the bug
      // surfaced by the design review (alice → bob identify fails →
      // UI keeps showing alice's flags → reload() hands over bob's).
      //
      // Reset the bindable surface so consumers see: `flags === {}`,
      // `identified === false`, `error === err`. `_currentIdentity`
      // stays set to the failed target so `reload()` can retry it
      // via `_doIdentify` (see `reload()`).
      this._publishFlags(EMPTY_FLAGS);
      this._setIdentified(false);
      this._setError(err instanceof Error ? err : new Error(String(err)));
      this._setLoading(false);
      return;
    }

    if (this._generation !== myGen) return;

    this._publishFlags(initial);
    this._setIdentified(true);
    this._setLoading(false);

    // Subscribe AFTER publishing the initial snapshot so there is a
    // well-defined ordering: consumers see `identified=true` with a
    // flag map that is guaranteed to be at least as fresh as the
    // subscribe-time snapshot. We pass `initial` as the third argument
    // so the Provider can use it as its change-detection baseline and
    // stay silent when its first internal tick returns the same data
    // the client already has.
    try {
      this._unsubscribeProvider = this._provider.subscribe(identity, (next) => {
        if (this._generation !== myGen) return;
        this._publishFlags(next);
      }, initial);
    } catch (err) {
      // Subscription failure is non-fatal: the initial snapshot is
      // already installed; we surface the error and let the client
      // rely on explicit `reload()` for subsequent updates.
      /* v8 ignore start -- sync subscribe throw between an already-awaited identify and its own line cannot observe a concurrent gen bump */
      if (this._generation !== myGen) return;
      /* v8 ignore stop */
      this._setError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private _publishFlags(next: FlagMap): void {
    // Deep-clone-and-freeze every level. A shallow freeze would leave
    // object-shaped flag values (`{ enabled, value }` / JSON flags)
    // mutable to consumers and would share references back into the
    // Provider's rule definitions — violating the "Frozen snapshot;
    // never mutated in place" contract on `flags` and risking source
    // contamination from consumer-side writes. See `freeze.ts`.
    const snapshot = deepCloneAndFreeze(next);
    this._flags = snapshot;
    this._target.dispatchEvent(new CustomEvent("feature-flags:flags-changed", {
      detail: snapshot,
      bubbles: true,
    }));
  }

  private _setIdentified(value: boolean): void {
    if (this._identified === value) return;
    this._identified = value;
    this._target.dispatchEvent(new CustomEvent("feature-flags:identified-changed", {
      detail: value,
      bubbles: true,
    }));
  }

  private _setLoading(value: boolean): void {
    if (this._loading === value) return;
    this._loading = value;
    this._target.dispatchEvent(new CustomEvent("feature-flags:loading-changed", {
      detail: value,
      bubbles: true,
    }));
  }

  private _setError(value: Error | null): void {
    // Dedupe only the null → null case. A non-null error is always
    // re-dispatched — a successive distinct failure must stay
    // observable even when it happens to === the previous by
    // reference (pathological, but test frameworks do assert on it).
    if (value === null && this._error === null) return;
    this._error = value;
    this._target.dispatchEvent(new CustomEvent("feature-flags:error", {
      detail: value,
      bubbles: true,
    }));
  }
}

/**
 * Flatten a auth0-gate `UserContext` into a {@link FlagIdentity} using
 * a Flagsmith-friendly trait shape:
 *
 *   userId → `sub`
 *   attrs  → { email, name, org_id, permissions, roles }
 *
 * Trait names match Flagsmith's documented convention (lowercase
 * snake-ish), and permission/role arrays are canonicalized by sorting
 * — Auth0 token refreshes do NOT guarantee stable claim ordering, and
 * these fields are semantically sets (membership matters, order does
 * not). Leaving the incoming order in place would let a reorder-only
 * refresh flip the Flagsmith identity key (which hashes `attrs` as-is
 * in its serialized form), tearing down and recreating the poller for
 * the same logical identity.
 *
 * Undefined fields are dropped so targeting rules can distinguish
 * "trait absent" from "trait present but empty".
 */
function _buildIdentity(user: UserContextLike): FlagIdentity {
  const attrs: Record<string, unknown> = {};
  if (user.email !== undefined) attrs.email = user.email;
  if (user.name !== undefined) attrs.name = user.name;
  if (user.orgId !== undefined) attrs.org_id = user.orgId;
  if (user.permissions !== undefined) attrs.permissions = _canonicalArray(user.permissions);
  if (user.roles !== undefined) attrs.roles = _canonicalArray(user.roles);
  return {
    userId: user.sub,
    attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
  };
}

function _canonicalArray(a: readonly string[]): string[] {
  return [...a].sort();
}

/**
 * Set-equality on two string arrays. Used by `updateUserContext` to
 * decide whether an Auth0 token refresh actually changed the user's
 * RBAC membership, ignoring claim ordering that the provider does not
 * guarantee. Identity-contributing arrays are canonicalized elsewhere
 * (see `_buildIdentity`), so keeping comparison-time and identity-
 * construction-time logic aligned here is what makes a pure reorder a
 * true no-op end-to-end.
 */
function _sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const sa = _canonicalArray(a);
  const sb = _canonicalArray(b);
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}
