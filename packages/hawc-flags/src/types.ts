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
 * `@wc-bindable/hawc-auth0`, `identify()` is called automatically
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
 * `@wc-bindable/hawc-auth0`'s `verifyAuth0Token()`. Typed structurally
 * here so `@wc-bindable/hawc-flags` does not depend on hawc-auth0 at
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
