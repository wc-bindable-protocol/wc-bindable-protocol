export function raiseError(message: string): never {
  throw new Error(`[@wc-bindable/s3] ${message}`);
}
