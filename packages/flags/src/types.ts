export interface ITagNames {
  readonly flags: string;
}

export interface IWritableTagNames {
  flags?: string;
}

export interface IConfig {
  readonly tagNames: ITagNames;
}

export interface IWritableConfig {
  tagNames?: IWritableTagNames;
}

export interface IWcBindableProperty {
  readonly name: string;
  readonly event: string;
  readonly getter?: (event: Event) => any;
}

export interface IWcBindableCommand {
  readonly name: string;
  readonly async?: boolean;
}

export interface IWcBindable {
  readonly protocol: "wc-bindable";
  readonly version: number;
  readonly properties: IWcBindableProperty[];
  readonly commands?: IWcBindableCommand[];
}

/**
 * Value carried by a single feature flag.
 *
 * The set of accepted types is deliberately wide: LaunchDarkly,
 * Flagsmith, Unleash, and Split all support boolean / string / number
 * values and some support JSON payloads ("variations", "multivariate
 * flags"). Rejecting non-boolean values would force providers to
 * lossily coerce, which would surprise integrators.
 */
export type FlagValue = boolean | string | number | null | FlagValue[] | { [key: string]: FlagValue };

/**
 * The full flag map published by a {@link FlagProvider}.
 *
 * Schema-less by design — consumers access individual flags via
 * `values.flags.<flagKey>` rather than declaring each key in
 * `static wcBindable`. See README §Schema-less design.
 */
export type FlagMap = Readonly<Record<string, FlagValue>>;

/**
 * Identity handed to {@link FlagProvider}. `userId` is required for
 * targeting rules; `attrs` carries additional traits (email, plan,
 * country, etc.) that the provider can use as rule inputs.
 *
 * When {@link FlagsCore} is constructed with a `userContext` from
 * `@wc-bindable/auth0`, `identify()` is called automatically
 * with `userContext.sub` as `userId` and a Flagsmith-style trait
 * flattening of `email` / `name` / `permissions` / `roles` / `orgId`.
 */
export interface FlagIdentity {
  userId: string;
  attrs?: Record<string, unknown>;
}

/**
 * Unsubscribe handle returned from {@link FlagProvider.subscribe}.
 * Providers must be safe to call this more than once (idempotent).
 */
export type FlagUnsubscribe = () => void;

/**
 * Abstraction over a feature-flag service.
 *
 * Implementations wrap vendor SDKs (Flagsmith, LaunchDarkly, Unleash,
 * etc.). The contract is deliberately narrow:
 *
 * - `identify()` returns the initial flag snapshot for a given identity.
 *   Synchronous failure → throw; async failure → reject.
 * - `subscribe()` registers a handler invoked whenever the provider
 *   observes a flag change (polling diff, SSE push, etc.). Handler is
 *   NOT called with the initial snapshot — that path goes through
 *   `identify()`. The optional `initial` argument lets the caller seed
 *   the Provider's change-detection baseline with the value already
 *   obtained from `identify()` / `reload()`, so the Provider does not
 *   fire `onChange` on its first internal tick when the content has
 *   not actually changed. Each `subscribe()` call returns a distinct
 *   `FlagUnsubscribe`: N calls → N independent unsubscribes, even when
 *   the same `onChange` reference is reused.
 * - `reload()` forces a refresh bypassing any provider-side cache.
 * - `dispose()` releases any provider-owned resources (polling timer,
 *   open SSE connection, SDK client). Called from {@link FlagsCore.dispose}.
 */
export interface FlagProvider {
  identify(identity: FlagIdentity): Promise<FlagMap>;
  subscribe(
    identity: FlagIdentity,
    onChange: (next: FlagMap) => void,
    initial?: FlagMap,
  ): FlagUnsubscribe;
  reload(identity: FlagIdentity): Promise<FlagMap>;
  dispose?(): Promise<void> | void;
}

/**
 * Minimal shape of the `UserContext` produced by
 * `@wc-bindable/auth0`'s `verifyAuth0Token()`. Typed structurally
 * here so `@wc-bindable/flags` does not depend on auth0-gate at
 * the package level — server integrations can pass the real UserContext
 * and it will structurally satisfy this.
 */
export interface UserContextLike {
  sub: string;
  email?: string;
  name?: string;
  permissions?: string[];
  roles?: string[];
  orgId?: string;
  raw?: Record<string, unknown>;
}

/**
 * Constructor options for {@link FlagsCore}.
 */
export interface FlagsCoreOptions {
  /**
   * Event dispatch target. Defaults to the Core itself. Pass an
   * HTMLElement or {@link RemoteShellProxy} EventTarget to have events
   * fire directly on the transport/DOM node, avoiding a re-dispatch hop.
   */
  target?: EventTarget;
  provider: FlagProvider;
  /**
   * Auth0-derived user context, if available. When provided, the Core
   * auto-identifies on first use — no explicit `identify()` call is
   * required from the client. Applications without Auth0 (or running
   * anonymously) can omit this and call `identify()` themselves.
   */
  userContext?: UserContextLike;
}

/**
 * Browser-side bindable surface seen by `data-wcs` / `bind()`.
 *
 * Access individual flag values via `values.flags.<flagKey>`. The flag
 * map is replaced wholesale on every change event (never mutated in
 * place), so reference-equality-based change detection in reactive
 * frameworks is honest.
 */
export interface FlagsValues {
  flags: FlagMap;
  identified: boolean;
  loading: boolean;
  error: Error | null;
}

/**
 * Context shape forwarded to Unleash's `isEnabled` / `getVariant`.
 * Mirrored from the SDK's public type so consumers can write a
 * `contextBuilder` without depending on `unleash-client` directly.
 */
export interface UnleashContext {
  userId?: string;
  sessionId?: string;
  remoteAddress?: string;
  environment?: string;
  /**
   * Arbitrary string-valued traits. Unleash strategies consume these
   * via predicates like `userWithId` / `remoteAddress` / `contextField`.
   * Array / object values must be serialized to strings upstream.
   */
  properties?: Record<string, string>;
}

/**
 * Unleash-specific Provider options.
 *
 * The underlying `unleash-client` SDK runs its own polling loop
 * (`refreshInterval`) and emits `changed` whenever it observes an
 * upstream update. {@link UnleashProvider} wires that event to its
 * per-identity fan-out, so — unlike Flagsmith — no additional
 * identity-level timer is necessary. Per-identity evaluation happens
 * in-process against the SDK's cached toggle definitions.
 */
export interface UnleashProviderOptions {
  /** Base URL of the Unleash API (e.g. `https://unleash.example.com/api`). */
  url: string;
  /** Application name — used by Unleash for metrics and filtering. */
  appName: string;
  /** Server-side SDK token. Required by Unleash 4.5+. */
  clientKey?: string;
  /** Distinct per-instance identifier for metrics. */
  instanceId?: string;
  /** Target environment (`"development"`, `"production"`, …). */
  environment?: string;
  /** Upstream polling interval in ms. Passed directly to the SDK. */
  refreshInterval?: number;
  /** Metrics-posting interval in ms. Passed directly to the SDK. */
  metricsInterval?: number;
  /** Custom HTTP headers for upstream requests. */
  customHeaders?: Record<string, string>;
  /** Async header provider (e.g. rotating JWTs). */
  customHeadersFunction?: () => Promise<Record<string, string>>;
  /** Suppress metrics publishing entirely. */
  disableMetrics?: boolean;
  /**
   * Custom mapping from {@link FlagIdentity} to {@link UnleashContext}.
   * Defaults: `userId` passes through; every entry in `identity.attrs`
   * is stringified into `properties` (arrays joined with `,`; objects
   * `JSON.stringify`-ed; primitives `String(v)`-ed). Override to
   * produce a custom shape — e.g. to map `orgId` to `sessionId` or to
   * omit attributes Unleash does not use.
   */
  contextBuilder?: (identity: FlagIdentity) => UnleashContext;
  /**
   * Restrict which toggles the Provider surfaces. Useful when the
   * Unleash project is shared across applications and only a subset of
   * toggles is relevant to this frontend. Defaults to "include all".
   */
  toggleFilter?: (name: string) => boolean;
}

/**
 * Per-context metadata. Mirrors the SDK's `LDContextMeta`.
 *
 * `privateAttributes` lists attribute names (or slash-delimited paths
 * to nested JSON properties) that should NOT be sent to LaunchDarkly
 * in analytics events — evaluation still sees them, but analytics
 * payloads redact them. The `kind`, `key`, and `_meta` attributes
 * cannot be marked private.
 */
export interface LaunchDarklyContextMeta {
  /** Attribute names (or paths) to strip from analytics events. */
  privateAttributes?: string[];
}

/**
 * Attributes common to any single context kind — used both as the
 * standalone single-kind shape (via {@link LaunchDarklySingleKindContext})
 * and as each child object inside a multi-kind context. Mirrors the
 * SDK's `LDContextCommon` so consumers can write a `contextBuilder`
 * without depending on `@launchdarkly/node-server-sdk` directly.
 */
export interface LaunchDarklyContextCommon {
  /** Primary identifier within the context kind. Required. */
  key: string;
  name?: string;
  email?: string;
  anonymous?: boolean;
  /**
   * Per-context metadata (private attribute declarations, etc.). See
   * {@link LaunchDarklyContextMeta}.
   */
  _meta?: LaunchDarklyContextMeta;
  /**
   * Arbitrary custom attributes. LD evaluates targeting rules against
   * these — any JSON-serializable value is accepted.
   */
  [attr: string]: unknown;
}

/**
 * Single-kind LaunchDarkly context. `kind` names the context kind and
 * defaults to `"user"` at the SDK level; `key` is the primary
 * identifier within that kind.
 *
 * NOTE: the field type is `string` for compatibility with LD's own SDK
 * types, but the literal `"multi"` is **reserved for the root of a
 * multi-kind context** and is invalid on a single-kind context.
 * TypeScript cannot natively express "any string except 'multi'"
 * without forcing casts at every call site, so this restriction is
 * only enforced at runtime along the default-builder path — the
 * Provider's constructor rejects `options.contextKind === "multi"`.
 * A custom `contextBuilder` returning a malformed `{ kind: "multi", key }`
 * object is **not** caught by the Provider; the downstream LD SDK's
 * own validation surfaces the error at evaluation time.
 */
export interface LaunchDarklySingleKindContext extends LaunchDarklyContextCommon {
  /**
   * Context kind. Defaults to `"user"` at the SDK level. Must not be
   * the literal `"multi"` — use {@link LaunchDarklyMultiKindContext}
   * for multi-kind contexts.
   */
  kind?: string;
}

/**
 * Multi-kind LaunchDarkly context. The root MUST have `kind: "multi"`
 * and does NOT carry a root-level `key` — each child context is keyed
 * by its kind name (e.g. `user`, `organization`) and carries its own
 * {@link LaunchDarklyContextCommon}. Mirrors the SDK's
 * `LDMultiKindContext`.
 *
 * Example:
 * ```ts
 * const ctx: LaunchDarklyMultiKindContext = {
 *   kind: "multi",
 *   user: { key: "user-123", name: "Alice" },
 *   organization: { key: "org-456", name: "Acme" },
 * };
 * ```
 */
export interface LaunchDarklyMultiKindContext {
  kind: "multi";
  [contextKind: string]: "multi" | LaunchDarklyContextCommon;
}

/**
 * A LaunchDarkly context forwarded to `allFlagsState` / `variation`.
 * Consumers may return either a single-kind or a multi-kind shape from
 * a {@link LaunchDarklyProviderOptions.contextBuilder}.
 */
export type LaunchDarklyContext = LaunchDarklySingleKindContext | LaunchDarklyMultiKindContext;

/**
 * Shape of flag values surfaced to subscribers.
 *
 * - `"wrapped"` (default, package-wide convention): each entry is
 *   `{ enabled, value }`. Boolean flags map to `{ enabled: v, value: v }`;
 *   non-boolean non-null flags map to `{ enabled: true, value: v }`;
 *   null/undefined map to `{ enabled: false, value: null }`. This
 *   matches Flagsmith / Unleash so a single `data-wcs` template
 *   (`values.flags.X.enabled`) works against every Provider.
 * - `"raw"` (LD-native): each entry is the flag's evaluated value
 *   (boolean / string / number / JSON). Pick this when integrating an
 *   LD-only frontend where wrapping would surprise readers used to
 *   LD's native semantics.
 *
 * The default is `"wrapped"` so a consumer swapping from
 * Flagsmith / Unleash to LaunchDarkly keeps their existing templates
 * working without a silent regression.
 */
export type LaunchDarklyValueShape = "raw" | "wrapped";

/**
 * LaunchDarkly-specific Provider options.
 *
 * The underlying `@launchdarkly/node-server-sdk` SDK streams upstream
 * flag updates by default and emits `update` whenever a flag changes.
 * {@link LaunchDarklyProvider} wires that event to its per-identity
 * fan-out — no additional identity-level timer. Per-identity evaluation
 * calls `allFlagsState(context)` against the SDK's in-process cache.
 */
export interface LaunchDarklyProviderOptions {
  /** Server-side SDK key. Required. */
  sdkKey: string;
  /**
   * Default context kind used when building an LDContext from a
   * {@link FlagIdentity}. Defaults to `"user"`. Ignored when
   * `contextBuilder` is supplied. Must not be the literal `"multi"` —
   * multi-kind contexts require a `contextBuilder`, because their
   * structural shape is not expressible as a flat `{ kind, key, ...attrs }`.
   */
  contextKind?: string;
  /** Override the default streaming endpoint (e.g. for LD Relay Proxy). */
  streamUri?: string;
  /** Override the default polling endpoint. */
  baseUri?: string;
  /** Override the default events endpoint. */
  eventsUri?: string;
  /**
   * Enable/disable streaming updates. Defaults to the SDK default
   * (streaming on). Set to `false` to fall back to polling.
   */
  stream?: boolean;
  /**
   * Polling interval in seconds when `stream` is `false`. Forwarded to
   * the SDK's `pollInterval`. Ignored when streaming is enabled.
   */
  pollInterval?: number;
  /** Suppress analytics events. Forwarded to the SDK's `sendEvents`. */
  disableEvents?: boolean;
  /**
   * Timeout waiting for the SDK to finish its initial LaunchDarkly
   * handshake. Default 5_000 ms. On timeout the initial `identify()`
   * rejects and the Provider tears down the half-built client.
   */
  initializationTimeoutMs?: number;
  /**
   * Restrict which flags the Provider surfaces. Useful when the LD
   * project is shared across applications and only a subset of flags is
   * relevant to this frontend. Defaults to "include all".
   */
  flagFilter?: (name: string) => boolean;
  /**
   * Restrict to flags flagged "Make this flag available to client-side
   * SDKs" in the LaunchDarkly dashboard — defense-in-depth when flag
   * definitions are reused across internal and public surfaces.
   */
  clientSideOnly?: boolean;
  /**
   * Output shape for each flag. See {@link LaunchDarklyValueShape}.
   * Defaults to `"wrapped"` so `values.flags.X.enabled` works the
   * same way it does under Flagsmith / Unleash. Set to `"raw"` to
   * surface LD's native value types directly.
   */
  valueShape?: LaunchDarklyValueShape;
  /**
   * Custom mapping from {@link FlagIdentity} to {@link LaunchDarklyContext}.
   * Defaults: `{ kind: options.contextKind ?? "user", key: identity.userId,
   * ...identity.attrs }` with `undefined` attributes dropped. Override to
   * produce a multi-kind context or rename attributes to match the
   * targeting schema of your LD project.
   */
  contextBuilder?: (identity: FlagIdentity) => LaunchDarklyContext;
}

/**
 * Flagsmith-specific Provider options.
 *
 * `flagsmith-nodejs` supports two evaluation modes:
 * - `"remote"` (default): each evaluation calls the Flagsmith API.
 *   Cheap to wire up, network-dependent per call.
 * - `"local"`: environment definition is pulled periodically and
 *   evaluated locally. Faster, but adds `environmentRefreshIntervalSeconds`.
 */
export interface FlagsmithProviderOptions {
  /** Server-side SDK key (NOT the environment / client-side key). */
  environmentKey: string;
  /** Override the default Flagsmith API URL. */
  apiUrl?: string;
  /**
   * Enable local evaluation. When `true`, pulls the environment
   * definition and evaluates flags in-process. Required for high
   * throughput or when Flagsmith API latency is unacceptable.
   */
  enableLocalEvaluation?: boolean;
  /** Local-evaluation refresh interval in seconds (default 60). */
  environmentRefreshIntervalSeconds?: number;
  /**
   * Polling interval in milliseconds for detecting remote flag changes
   * per identity. Default 30_000 ms. Set to `0` to disable polling
   * (relies solely on `realtime` pushes or explicit `reload()` calls).
   */
  pollingIntervalMs?: number;
  /**
   * Enable Flagsmith's realtime push channel (SSE). When `true`,
   * subscriptions listen for server-sent change notifications in
   * addition to (or instead of) polling. Requires a Flagsmith plan
   * that supports realtime. Default `false`.
   */
  realtime?: boolean;
}
