export interface ITagNames {
  readonly webauthn: string;
}

export interface IWritableTagNames {
  webauthn?: string;
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

export interface IWcBindableInput {
  readonly name: string;
  readonly attribute?: string;
}

export interface IWcBindableCommand {
  readonly name: string;
  readonly async?: boolean;
}

export interface IWcBindable {
  readonly protocol: "wc-bindable";
  readonly version: 1;
  readonly properties: IWcBindableProperty[];
  readonly inputs?: IWcBindableInput[];
  readonly commands?: IWcBindableCommand[];
}

export type WebAuthnMode = "register" | "authenticate";

export type WebAuthnStatus =
  | "idle"
  | "challenging"
  | "creating"    // browser is running navigator.credentials.create()
  | "asserting"   // browser is running navigator.credentials.get()
  | "verifying"   // server is verifying the attestation/assertion
  | "completed"
  | "error";

export type UserVerificationRequirement = "required" | "preferred" | "discouraged";
export type AttestationConveyancePreference = "none" | "indirect" | "direct" | "enterprise";
export type AuthenticatorAttachment = "platform" | "cross-platform";

/** User handle as surfaced by the Core and Shell. `id` is a stable identifier. */
export interface WebAuthnUser {
  id: string;
  name: string;
  displayName: string;
}

/**
 * Persisted credential record. `publicKey` is the credential's COSE-encoded
 * public key as produced by the verifier; the store is opaque to the format.
 * `counter` is WebAuthn's signCount — monotonically increasing across
 * successful assertions, used to detect cloned authenticators.
 */
export interface CredentialRecord {
  credentialId: string;         // base64url
  userId: string;
  publicKey: string;            // base64url
  counter: number;
  transports?: string[];
  createdAt: number;            // epoch ms
}

/**
 * Per-session challenge slot. The Core writes a fresh challenge on every
 * `createRegistrationChallenge` / `createAuthenticationChallenge` and the
 * verifier consumes it exactly once. The `sessionId` binds the challenge
 * to a specific browser session (typically the application's own cookie
 * or an opaque token the Shell attaches to the verify POST). Without a
 * session binding, any concurrent WebAuthn ceremony could consume another
 * user's challenge and re-route the credential to the wrong account.
 */
export interface ChallengeSlot {
  challenge: string;            // base64url
  mode: WebAuthnMode;
  userId?: string;              // registration: pre-assigned; auth: resolved after verify
  createdAt: number;
}

export interface IChallengeStore {
  put(sessionId: string, slot: ChallengeSlot): Promise<void>;
  /** Consume-once: read AND delete. Returning the same challenge twice is a
   *  replay window — the store is obligated to atomic take-or-nothing. */
  take(sessionId: string): Promise<ChallengeSlot | null>;
}

export interface ICredentialStore {
  put(record: CredentialRecord): Promise<void>;
  getById(credentialId: string): Promise<CredentialRecord | null>;
  listByUser(userId: string): Promise<CredentialRecord[]>;
  /** Persist the new counter after a successful assertion. */
  updateCounter(credentialId: string, counter: number): Promise<void>;
}

/**
 * Registration response from navigator.credentials.create(), serialized to
 * JSON as PublicKeyCredential#toJSON() would produce. We model it loosely —
 * the concrete shape is enforced by the verifier, not this Core.
 */
export interface RegistrationResponseJSON {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
    [key: string]: unknown;
  };
  clientExtensionResults?: Record<string, unknown>;
  authenticatorAttachment?: AuthenticatorAttachment;
}

export interface AuthenticationResponseJSON {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
    [key: string]: unknown;
  };
  clientExtensionResults?: Record<string, unknown>;
  authenticatorAttachment?: AuthenticatorAttachment;
}

export interface PublicKeyCredentialCreationOptionsJSON {
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout?: number;
  excludeCredentials?: Array<{ id: string; type: "public-key"; transports?: string[] }>;
  authenticatorSelection?: {
    authenticatorAttachment?: AuthenticatorAttachment;
    residentKey?: "discouraged" | "preferred" | "required";
    userVerification?: UserVerificationRequirement;
  };
  attestation?: AttestationConveyancePreference;
}

export interface PublicKeyCredentialRequestOptionsJSON {
  challenge: string;
  timeout?: number;
  rpId: string;
  allowCredentials?: Array<{ id: string; type: "public-key"; transports?: string[] }>;
  userVerification?: UserVerificationRequirement;
}

/** Verified registration result handed back to the Core so it can persist. */
export interface VerifiedRegistration {
  credentialId: string;        // base64url
  publicKey: string;           // base64url (COSE)
  counter: number;
  transports?: string[];
}

export interface VerifiedAuthentication {
  credentialId: string;
  newCounter: number;
}

/**
 * Pluggable verifier abstraction. The Core orchestrates challenge +
 * persistence; the verifier owns cryptographic signature checking and
 * CBOR/COSE parsing. `@simplewebauthn/server` is the reference adapter,
 * but any implementation that fulfills this interface works.
 *
 * Symmetrical with `IS3Provider` in `@wc-bindable/hawc-s3` — same
 * dependency-injection shape, same "core owns decisions, provider owns
 * wire format" split.
 */
export interface IWebAuthnVerifier {
  verifyRegistration(params: {
    response: RegistrationResponseJSON;
    expectedChallenge: string;
    expectedOrigin: string | string[];
    expectedRPID: string;
    requireUserVerification: boolean;
  }): Promise<VerifiedRegistration>;

  verifyAuthentication(params: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    expectedOrigin: string | string[];
    expectedRPID: string;
    credential: CredentialRecord;
    requireUserVerification: boolean;
  }): Promise<VerifiedAuthentication>;
}

export interface WebAuthnCoreOptions {
  rpId: string;
  rpName: string;
  origin: string | string[];
  challengeStore: IChallengeStore;
  credentialStore: ICredentialStore;
  verifier: IWebAuthnVerifier;
  /** Default UV requirement applied to issued challenges. */
  userVerification?: UserVerificationRequirement;
  /** Default attestation conveyance preference for registration. */
  attestation?: AttestationConveyancePreference;
  /** Browser timeout hint injected into issued option blobs (ms). */
  timeout?: number;
  /** Challenge byte length. 32 is the WebAuthn spec-recommended floor. */
  challengeBytes?: number;
  /** Challenge TTL in ms. Slots older than this are rejected by verify. */
  challengeTtlMs?: number;
}

export interface WebAuthnValues {
  status: WebAuthnStatus;
  credentialId: string;
  user: WebAuthnUser | null;
  error: Error | null;
}

export interface WebAuthnShellValues extends WebAuthnValues {
  trigger: boolean;
}
