/**
 * Minimal structured logger surface, mirroring the shape `@wc-bindable/remote`
 * uses. The composite reference implementation routes getter-failure reports
 * (COMPOSITE.md § 12) through `reportError` where available and otherwise to
 * this injected logger at error level — see the "Reference-implementation
 * choice" note in § 12.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** Default logger that writes to the host `console`. */
export const consoleLogger: Logger = {
  debug: (message, ...args) => console.debug(message, ...args),
  warn: (message, ...args) => console.warn(message, ...args),
  error: (message, ...args) => console.error(message, ...args),
};

/** A logger that drops everything — useful for tests and quiet embeddings. */
export const silentLogger: Logger = {
  debug: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Report a non-fatal error per COMPOSITE.md § 12's priority order, adapted to
 * the reference-implementation choice: prefer the global `reportError` (so the
 * error surfaces to host error reporting exactly as core's uncaught getter
 * throw would), and otherwise fall back to the injected logger at error level.
 * The deferred-re-throw path is intentionally avoided because it can terminate
 * a Node process for a single getter bug (§ 12 note).
 *
 * This MUST NOT throw and MUST NOT abort the caller's synchronous loop — a
 * hostile `reportError` is caught and demoted to the logger.
 */
export function reportComposite(error: unknown, logger: Logger): void {
  const globalReportError = (globalThis as { reportError?: (e: unknown) => void })
    .reportError;
  if (typeof globalReportError === "function") {
    try {
      globalReportError(error);
      return;
    } catch {
      // Secondary error from a hostile reportError is best-effort: fall through
      // to the logger so the primary error is still observable (§ 12).
    }
  }
  try {
    logger.error("[wc-bindable/composite] getter/delegation error", error);
  } catch {
    // The logger itself must never break the fan-out loop.
  }
}
