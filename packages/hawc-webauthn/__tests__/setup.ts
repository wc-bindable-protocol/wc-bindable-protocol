// happy-dom does not ship navigator.credentials; tests that need it install
// per-case mocks via `(navigator as any).credentials = ...`.

if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(cb, 0)) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame;
}
