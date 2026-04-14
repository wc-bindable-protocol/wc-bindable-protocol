export interface ITagNames {
  readonly s3: string;
  readonly s3Callback: string;
}

export interface IWritableTagNames {
  s3?: string;
  s3Callback?: string;
}

export interface IRemoteConfig {
  readonly enableRemote: boolean;
  readonly remoteSettingType: "env" | "config";
  readonly remoteCoreUrl: string;
}

export interface IWritableRemoteConfig {
  enableRemote?: boolean;
  remoteSettingType?: "env" | "config";
  remoteCoreUrl?: string;
}

export interface IConfig {
  readonly tagNames: ITagNames;
  readonly remote: IRemoteConfig;
}

export interface IWritableConfig {
  tagNames?: IWritableTagNames;
  remote?: IWritableRemoteConfig;
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

/**
 * Object metadata exchanged between Shell and Core.
 * `size` is the byte length of the blob; `contentType` is the MIME type.
 */
export interface S3ObjectMetadata {
  size?: number;
  contentType?: string;
}

/**
 * Progress snapshot. `phase` distinguishes between sign/upload/postprocess
 * so the UI can show distinct labels without inspecting other state.
 */
export interface S3Progress {
  loaded: number;
  total: number;
  phase: "idle" | "signing" | "uploading" | "completing" | "done";
}

/**
 * Presigned PUT URL plus any extra headers the browser must echo back when
 * uploading. SigV4 unsigned-payload presign needs no extra headers, but other
 * providers (e.g. server-side encryption) may require them.
 */
export interface PresignedUpload {
  url: string;
  method: "PUT";
  headers?: Record<string, string>;
  expiresAt: number; // epoch ms
}

export interface PresignedDownload {
  url: string;
  method: "GET";
  expiresAt: number;
}

export interface S3RequestOptions {
  bucket: string;
  prefix?: string;
  contentType?: string;
  expiresInSeconds?: number;
}

/**
 * One part of a multipart upload as exposed to the browser.
 * `range` is a [startByteInclusive, endByteExclusive) slice into the source blob.
 */
export interface MultipartPartUrl {
  partNumber: number;
  url: string;
  range: [number, number];
}

/**
 * Server response for a multipart-init request. Contains everything the
 * browser needs to upload all parts and (server-side) finalize.
 */
export interface MultipartInit {
  uploadId: string;
  partSize: number;
  parts: MultipartPartUrl[];
  /** Mirrors the resolved key (with prefix) for the upload. */
  key: string;
}

/**
 * Browser-reported ETag per part — fed back to the server's completeMultipart.
 * ETags are kept as the server returned them (with quotes); the server
 * re-emits the quoted form into the CompleteMultipartUpload XML body.
 */
export interface MultipartPart {
  partNumber: number;
  etag: string;
}

/**
 * Provider abstraction. Implementations sign requests against the underlying
 * blob store. AwsS3Provider is the default; S3-compatible stores (R2, MinIO)
 * can supply their own implementation or reuse it with a custom endpoint.
 */
export interface IS3Provider {
  presignUpload(key: string, opts: S3RequestOptions): Promise<PresignedUpload>;
  presignDownload(key: string, opts: S3RequestOptions): Promise<PresignedDownload>;
  deleteObject(key: string, opts: S3RequestOptions): Promise<void>;
  initiateMultipart(key: string, opts: S3RequestOptions): Promise<{ uploadId: string }>;
  presignPart(key: string, uploadId: string, partNumber: number, opts: S3RequestOptions): Promise<PresignedUpload>;
  completeMultipart(key: string, uploadId: string, parts: MultipartPart[], opts: S3RequestOptions): Promise<{ etag: string }>;
  abortMultipart(key: string, uploadId: string, opts: S3RequestOptions): Promise<void>;
}

/**
 * Context passed to post-process hooks after the browser confirms upload.
 * Hooks run server-side and may perform DB inserts, virus scans, thumbnailing, etc.
 */
export interface PostProcessContext {
  bucket: string;
  key: string;
  etag?: string;
  size?: number;
  contentType?: string;
}

export type PostProcessHook = (ctx: PostProcessContext) => Promise<void> | void;

export interface S3Error {
  code?: string;
  message: string;
  status?: number;
}

export interface WcsS3CoreValues {
  url: string;
  key: string;
  etag: string;
  progress: S3Progress;
  loading: boolean;
  uploading: boolean;
  completed: boolean;
  metadata: S3ObjectMetadata | null;
  error: S3Error | Error | null;
}

export interface WcsS3Values extends WcsS3CoreValues {
  trigger: boolean;
}
