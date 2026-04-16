export function raiseError(message: string): never {
  throw new Error(`[@wc-bindable/hawc-s3] ${message}`);
}
