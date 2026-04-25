/**
 * Server-side entry point.
 *
 * The default barrel (`@wc-bindable/s3`) re-exports the browser custom
 * elements (`<s3-uploader>`, `<s3-callback>`) which extend `HTMLElement`.
 * Loading those classes from Node throws `ReferenceError: HTMLElement is not
 * defined`, so server-side consumers must use this entry instead.
 *
 * It exports only the headless pieces that are safe to instantiate in Node:
 *   - `S3Core`           (the wcBindable Core that holds AWS credentials)
 *   - `AwsS3Provider`    (default SigV4 provider)
 *   - `presignS3Url`     (low-level SigV4 helper)
 *   - retry helpers, types
 *
 * Browser components and bootstrap helpers stay in the default barrel.
 */
export { S3Core } from "./core/S3Core.js";
export { AwsS3Provider } from "./providers/AwsS3Provider.js";
export type { AwsS3ProviderOptions } from "./providers/AwsS3Provider.js";
export { presignS3Url } from "./signing/sigv4.js";
export type {
  SigV4Credentials, SigV4PresignParams, SigV4PresignResult,
} from "./signing/sigv4.js";
export { retryWithBackoff, defaultPutRetryPolicy, PutHttpError, MissingEtagError } from "./retry.js";
export type { RetryOptions, S3OwnedError } from "./retry.js";
export type {
  IS3Provider, S3RequestOptions, PresignedUpload, PresignedDownload,
  S3ObjectMetadata, S3Progress, PostProcessHook, PostProcessContext,
  PostProcessOptions, S3Error, MultipartInit, MultipartPartUrl, MultipartPart,
  WcsS3CoreValues,
} from "./types.js";
