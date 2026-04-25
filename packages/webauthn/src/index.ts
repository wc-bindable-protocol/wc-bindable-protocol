export { bootstrapWebAuthn } from "./bootstrapWebAuthn.js";
export { registerComponents } from "./registerComponents.js";
export { getConfig, setConfig, config } from "./config.js";
export { WebAuthn as WcsWebAuthn } from "./components/WebAuthn.js";
export { encode as base64urlEncode, decode as base64urlDecode, randomChallenge } from "./codec/base64url.js";

export type {
  IWritableConfig, IWritableTagNames, ITagNames, IConfig,
  IWcBindable, IWcBindableProperty, IWcBindableInput, IWcBindableCommand,
  WebAuthnMode, WebAuthnStatus, WebAuthnUser, WebAuthnValues, WebAuthnShellValues,
  UserVerificationRequirement, AttestationConveyancePreference, AuthenticatorAttachment,
  CredentialRecord, ChallengeSlot,
  IChallengeStore, ICredentialStore, IWebAuthnVerifier,
  RegistrationResponseJSON, AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON,
  VerifiedRegistration, VerifiedAuthentication,
  WebAuthnCoreOptions,
} from "./types.js";
