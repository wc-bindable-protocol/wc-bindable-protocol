import { config, getRemoteCoreUrl } from "../config.js";
import { IWcBindable, AiMessage } from "../types.js";
import { AiCore } from "../core/AiCore.js";
import { AiMessage as AiMessageElement } from "./AiMessage.js";
import { registerAutoTrigger, unregisterAutoTrigger } from "../autoTrigger.js";
import {
  createRemoteCoreProxy,
  WebSocketClientTransport,
  type RemoteCoreProxy,
  type ClientTransport,
} from "@wc-bindable/remote";
import { bind } from "@wc-bindable/core";

export class Ai extends HTMLElement {
  static hasConnectedCallbackPromise = false;
  static wcBindable: IWcBindable = {
    ...AiCore.wcBindable,
    properties: [
      ...AiCore.wcBindable.properties,
      { name: "trigger", event: "hawc-ai:trigger-changed" },
    ],
  };
  static get observedAttributes(): string[] {
    return ["provider"];
  }

  private _core: AiCore | null = null;
  private _proxy: RemoteCoreProxy | null = null;
  private _remoteValues: Record<string, unknown> = {};
  private _unbind: (() => void) | null = null;
  private _ws: WebSocket | null = null;
  private _trigger: boolean = false;
  private _prompt: string = "";
  private _errorState: any = null;
  private _hasLocalError: boolean = false;
  private _autoTriggerRegistered: boolean = false;

  private get _isRemote(): boolean {
    return this._proxy !== null;
  }

  constructor() {
    super();
    if (!config.remote.enableRemote) {
      this._core = new AiCore(this);
    }
  }

  private _initRemote(): void {
    const url = getRemoteCoreUrl();
    if (!url) {
      throw new Error("[@wc-bindable/hawc-ai] remote.enableRemote is true but remoteCoreUrl is empty. Set remote.remoteCoreUrl or AI_REMOTE_CORE_URL environment variable.");
    }
    const ws = new WebSocket(url);
    this._ws = ws;
    const transport = new WebSocketClientTransport(ws);
    this._connectRemote(transport);
  }

  private _setErrorState(error: any): void {
    this._errorState = error;
    this._hasLocalError = true;
    this.dispatchEvent(new CustomEvent("hawc-ai:error", {
      detail: error,
      bubbles: true,
    }));
  }

  /** Clear only client-side (local) errors; leave server-synced errors untouched. */
  private _clearErrorState(): void {
    if (!this._hasLocalError) return;
    this._hasLocalError = false;
    this._errorState = null;
    this.dispatchEvent(new CustomEvent("hawc-ai:error", {
      detail: this.error,
      bubbles: true,
    }));
  }

  private _applyProvider(value: string | null): void {
    if (this._isRemote) {
      this._proxy!.setWithAck("provider", value || null)
        .then(() => this._clearErrorState())
        .catch(e => this._setErrorState(e));
    } else if (this._core) {
      this._core.provider = value || null;
    }
  }

  /** @internal — visible for testing */
  _connectRemote(transport: ClientTransport): void {
    this._proxy = createRemoteCoreProxy(AiCore.wcBindable, transport);

    // Bridge proxy events to this HTMLElement so framework adapters work
    this._unbind = bind(this._proxy, (name, value) => {
      // Revive serialized Error objects back into Error instances so that
      // el.error instanceof Error holds in remote mode just as it does locally.
      if (name === "error") {
        value = Ai._reviveError(value);
        this._errorState = null;
        this._hasLocalError = false;
      }
      this._remoteValues[name] = value;
      // Find the matching event name from the declaration
      const prop = Ai.wcBindable.properties.find(p => p.name === name);
      if (prop) {
        this.dispatchEvent(new CustomEvent(prop.event, {
          detail: value,
          bubbles: true,
        }));
      }
    });
  }

  // --- Input attributes ---

  get provider(): string {
    return this.getAttribute("provider") || "";
  }

  set provider(value: string) {
    this.setAttribute("provider", value);
  }

  get model(): string {
    return this.getAttribute("model") || "";
  }

  set model(value: string) {
    this.setAttribute("model", value);
  }

  get baseUrl(): string {
    return this.getAttribute("base-url") || "";
  }

  set baseUrl(value: string) {
    this.setAttribute("base-url", value);
  }

  /**
   * API key passed through the `api-key` attribute.
   * This value is exposed in the DOM, so it is intended for development and prototyping only.
   * In production, point `base-url` at a backend proxy that injects the provider API key server-side.
   */
  get apiKey(): string {
    return this.getAttribute("api-key") || "";
  }

  set apiKey(value: string) {
    this.setAttribute("api-key", value);
  }

  get system(): string {
    return this.getAttribute("system") || "";
  }

  set system(value: string) {
    this.setAttribute("system", value);
  }

  get stream(): boolean {
    return !this.hasAttribute("no-stream");
  }

  set stream(value: boolean) {
    if (value) {
      this.removeAttribute("no-stream");
    } else {
      this.setAttribute("no-stream", "");
    }
  }

  get apiVersion(): string {
    return this.getAttribute("api-version") || "";
  }

  set apiVersion(value: string) {
    this.setAttribute("api-version", value);
  }

  // --- JS-only properties ---

  get prompt(): string { return this._prompt; }
  set prompt(value: string) { this._prompt = value; }

  get temperature(): number | undefined {
    const v = this.getAttribute("temperature");
    return v !== null ? Number(v) : undefined;
  }

  set temperature(value: number | undefined) {
    if (value !== undefined) {
      this.setAttribute("temperature", String(value));
    } else {
      this.removeAttribute("temperature");
    }
  }

  get maxTokens(): number | undefined {
    const v = this.getAttribute("max-tokens");
    return v !== null ? Number(v) : undefined;
  }

  set maxTokens(value: number | undefined) {
    if (value !== undefined) {
      this.setAttribute("max-tokens", String(value));
    } else {
      this.removeAttribute("max-tokens");
    }
  }

  // --- Output state ---

  get content(): string {
    if (this._isRemote) return (this._remoteValues.content as string) ?? "";
    return this._core?.content ?? "";
  }

  get loading(): boolean {
    if (this._isRemote) return (this._remoteValues.loading as boolean) ?? false;
    return this._core?.loading ?? false;
  }

  get streaming(): boolean {
    if (this._isRemote) return (this._remoteValues.streaming as boolean) ?? false;
    return this._core?.streaming ?? false;
  }

  get error(): any {
    if (this._isRemote) {
      // Client-side errors (from setWithAck / transport failures) take priority.
      if (this._hasLocalError) return this._errorState;
      // Otherwise return the server-synced value, falling back to _errorState
      // only before the first server sync.
      return "error" in this._remoteValues ? this._remoteValues.error : this._errorState;
    }
    return this._core?.error ?? this._errorState;
  }

  get usage(): any {
    if (this._isRemote) return this._remoteValues.usage ?? null;
    return this._core?.usage ?? null;
  }

  get messages(): AiMessage[] {
    if (this._isRemote) {
      const msgs = this._remoteValues.messages as AiMessage[] | undefined;
      return msgs ? msgs.map(m => ({ ...m })) : [];
    }
    return this._core?.messages ?? [];
  }

  set messages(value: AiMessage[]) {
    if (this._isRemote) {
      this._proxy!.setWithAck("messages", value)
        .then(() => this._clearErrorState())
        .catch(e => this._setErrorState(e));
    } else if (this._core) {
      this._core!.messages = value;
    }
  }

  // --- Trigger ---

  get trigger(): boolean { return this._trigger; }

  set trigger(value: boolean) {
    const v = !!value;
    if (v) {
      this._trigger = true;
      this.dispatchEvent(new CustomEvent("hawc-ai:trigger-changed", {
        detail: true,
        bubbles: true,
      }));
      this.send().catch(() => {}).finally(() => {
        this._trigger = false;
        this.dispatchEvent(new CustomEvent("hawc-ai:trigger-changed", {
          detail: false,
          bubbles: true,
        }));
      });
    }
  }

  // --- Methods ---

  private _collectSystem(): string {
    // system属性が優先
    if (this.system) return this.system;
    // 子要素から収集（role="system" の最初の要素のみ。role未指定もsystem扱い）
    const tag = config.tagNames.aiMessage;
    const msgEl = this.querySelector<AiMessageElement>(`${tag}[role="system"], ${tag}:not([role])`);
    if (msgEl) {
      return msgEl.messageContent;
    }
    return "";
  }

  async send(): Promise<string | null> {
    if (this._isRemote) {
      try {
        // Use invokeWithOptions with timeoutMs: 0 to disable the default 30s
        // timeout — AI inference and long streaming responses routinely exceed it.
        return await this._proxy!.invokeWithOptions("send", [this._prompt, {
          model: this.model,
          stream: this.stream,
          temperature: this.temperature,
          maxTokens: this.maxTokens,
          system: this._collectSystem(),
          apiKey: this.apiKey,
          baseUrl: this.baseUrl,
          apiVersion: this.apiVersion,
        }], { timeoutMs: 0 }) as string | null;
      } catch (e) {
        if (Ai._isTransportError(e)) {
          // Transport-level failures (disconnect, disposed proxy) are not surfaced
          // by the server's AiCore error events, so expose them through the component state.
          // Also reset loading/streaming so UI does not stay permanently busy.
          this._setErrorState(e);
          this._remoteValues.loading = false;
          this._remoteValues.streaming = false;
          this.dispatchEvent(new CustomEvent("hawc-ai:loading-changed", { detail: false, bubbles: true }));
          this.dispatchEvent(new CustomEvent("hawc-ai:streaming-changed", { detail: false, bubbles: true }));
          return null;
        }
        // Server-side command errors (validation, provider errors) are re-thrown
        // to match local mode's reject behavior.
        throw e;
      }
    }
    if (!this._core) {
      throw this._errorState ?? new Error("[@wc-bindable/hawc-ai] Ai is not initialized yet. Attach the element to the DOM before calling send().");
    }
    return this._core.send(this._prompt, {
      model: this.model,
      stream: this.stream,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      system: this._collectSystem(),
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      apiVersion: this.apiVersion,
    });
  }

  abort(): void {
    if (this._isRemote) {
      this._proxy!.invoke("abort").catch(() => {});
    } else if (this._core) {
      this._core!.abort();
    }
  }

  // --- Lifecycle ---

  connectedCallback(): void {
    this.style.display = "none";
    if (config.remote.enableRemote && !this._isRemote) {
      try {
        this._initRemote();
        this._errorState = null;
      } catch (error) {
        this._setErrorState(error);
      }
    }
    if (this.provider) this._applyProvider(this.provider);
    if (config.autoTrigger) {
      registerAutoTrigger();
      this._autoTriggerRegistered = true;
    }
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    if (name === "provider") {
      this._applyProvider(newValue);
    }
  }

  disconnectedCallback(): void {
    if (this._isRemote) {
      // Send abort to cancel any in-flight server-side inference before disposing.
      this._proxy!.invoke("abort").catch(() => {});
      this._unbind?.();
      this._unbind = null;
      this._proxy!.dispose();
      this._proxy = null;
      this._remoteValues = {};
      if (this._ws) {
        this._ws.close();
        this._ws = null;
      }
    } else if (this._core) {
      this._core!.abort();
    }
    if (this._autoTriggerRegistered) {
      unregisterAutoTrigger();
      this._autoTriggerRegistered = false;
    }
  }

  /** Revive a serialized Error (from remote JSON) back into an Error instance. */
  private static _reviveError(value: any): any {
    if (value == null || typeof value !== "object") return value;
    // AiHttpError has 'status'; skip it.
    if ("status" in value) return value;
    // Serialized Error has 'name' and 'message' but is not an Error instance.
    if ("name" in value && "message" in value && !(value instanceof Error)) {
      const err = new Error(value.message);
      err.name = value.name;
      if (value.stack) err.stack = value.stack;
      return err;
    }
    return value;
  }

  /** Detect transport-level errors from RemoteCoreProxy (disposed, closed, timeout). */
  private static _isTransportError(e: unknown): boolean {
    if (!(e instanceof Error)) return false;
    const msg = e.message;
    return msg.includes("disposed") || msg.includes("closed") || e.name === "TimeoutError";
  }
}
