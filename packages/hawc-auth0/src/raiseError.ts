export function raiseError(message: string): never {
  throw new Error(`[@wc-bindable/hawc-auth0] ${message}`);
}
