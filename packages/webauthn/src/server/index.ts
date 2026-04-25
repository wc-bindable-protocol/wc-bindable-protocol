export { WebAuthnCore } from "../core/WebAuthnCore.js";
export { InMemoryChallengeStore } from "../stores/InMemoryChallengeStore.js";
export { InMemoryCredentialStore } from "../stores/InMemoryCredentialStore.js";
export { SimpleWebAuthnVerifier } from "./SimpleWebAuthnVerifier.js";
export { HttpError } from "./HttpError.js";
export {
  createWebAuthnHandlers,
  type WebAuthnHandlers,
  type CreateWebAuthnHandlersOptions,
} from "./createWebAuthnHandlers.js";

export type {
  IChallengeStore, ICredentialStore, IWebAuthnVerifier,
  CredentialRecord, ChallengeSlot,
  WebAuthnCoreOptions, WebAuthnMode, WebAuthnStatus, WebAuthnUser,
  UserVerificationRequirement, AttestationConveyancePreference,
  RegistrationResponseJSON, AuthenticationResponseJSON,
  VerifiedRegistration, VerifiedAuthentication,
  PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON,
} from "../types.js";
