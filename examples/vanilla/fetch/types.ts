export interface MyFetchValues {
  value: unknown;
  loading: boolean;
  error: { status: number; statusText: string; body: string } | null;
  status: number;
}

export interface MyFetchElement extends HTMLElement {
  url: string;
  method: string;
  manual: boolean;
  fetch(): Promise<unknown>;
  abort(): void;
}
