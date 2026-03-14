export interface MyFetchValues {
  value: unknown;
  loading: boolean;
  error: { status: number; statusText: string; body: string } | null;
  status: number;
}
