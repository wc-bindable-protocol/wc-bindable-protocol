export { bootstrapS3 } from "./bootstrapS3.js";
export { getConfig, getRemoteCoreUrl } from "./config.js";
export { S3Core } from "./core/S3Core.js";
export { S3 as WcsS3 } from "./components/S3.js";
export { S3Callback as WcsS3Callback } from "./components/S3Callback.js";
export { AwsS3Provider } from "./providers/AwsS3Provider.js";
export type { AwsS3ProviderOptions } from "./providers/AwsS3Provider.js";
export { presignS3Url, SkewError } from "./signing/sigv4.js";
export type {
  SigV4Credentials, SigV4PresignParams, SigV4PresignResult,
} from "./signing/sigv4.js";
export { retryWithBackoff, defaultPutRetryPolicy, PutHttpError, MissingEtagError } from "./retry.js";
export type { RetryOptions, S3OwnedError } from "./retry.js";

export type {
  IWritableConfig, IWritableTagNames, IWritableRemoteConfig,
  IS3Provider, S3RequestOptions, PresignedUpload, PresignedDownload,
  S3ObjectMetadata, S3Progress, PostProcessHook, PostProcessContext,
  PostProcessOptions, S3Error, SerializedError, WcsS3AnyError,
  WcsS3CoreValues, WcsS3Values,
} from "./types.js";
