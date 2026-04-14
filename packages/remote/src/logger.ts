/**
 * Minimal logger contract injected into `RemoteCoreProxy`,
 * `RemoteShellProxy`, `WebSocketClientTransport`, and
 * `WebSocketServerTransport`.
 *
 * Only `warn` and `error` are used by this package. Structured logging
 * (pino, winston, bunyan, etc.) can be adapted by wrapping the logger:
 *
 *   const logger = {
 *     warn: (message, ...extras) => pinoInstance.warn({ extras }, message),
 *     error: (message, ...extras) => pinoInstance.error({ extras }, message),
 *   };
 */
export interface Logger {
  warn(message: string, ...extras: unknown[]): void;
  error(message: string, ...extras: unknown[]): void;
}

/**
 * Default logger that forwards to `console.warn` / `console.error`. Used
 * when no `logger` option is supplied, preserving prior behavior.
 */
export const consoleLogger: Logger = {
  warn: (message, ...extras) => console.warn(message, ...extras),
  error: (message, ...extras) => console.error(message, ...extras),
};

export function resolveLogger(logger: Logger | undefined): Logger {
  return logger ?? consoleLogger;
}
