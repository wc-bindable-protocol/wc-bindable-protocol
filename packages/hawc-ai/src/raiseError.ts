export function raiseError(message: string): never {
  throw new Error(`[@wc-bindable/hawc-ai] ${message}`);
}
