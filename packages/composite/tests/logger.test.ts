import { describe, it, expect, vi, afterEach } from "vitest";
import { consoleLogger, silentLogger, type Logger } from "../src/index.js";
import { reportComposite } from "../src/logger.js";

/**
 * A logger that records every call so tests can assert which level fired.
 */
function recordingLogger(): Logger & { errors: unknown[][]; warns: unknown[][]; debugs: unknown[][] } {
  const errors: unknown[][] = [];
  const warns: unknown[][] = [];
  const debugs: unknown[][] = [];
  return {
    errors,
    warns,
    debugs,
    debug: (...args: unknown[]) => debugs.push(args),
    warn: (...args: unknown[]) => warns.push(args),
    error: (...args: unknown[]) => errors.push(args),
  };
}

afterEach(() => {
  delete (globalThis as { reportError?: unknown }).reportError;
  vi.restoreAllMocks();
});

describe("reportComposite", () => {
  it("routes to the global reportError when one is present (§ 12 priority order)", () => {
    const reportError = vi.fn();
    (globalThis as { reportError?: unknown }).reportError = reportError;
    const logger = recordingLogger();
    const err = new Error("getter boom");

    reportComposite(err, logger);

    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(err);
    // The logger fallback must NOT also fire when reportError handled it.
    expect(logger.errors).toHaveLength(0);
  });

  it("falls back to logger.error when no global reportError exists (51-52)", () => {
    expect((globalThis as { reportError?: unknown }).reportError).toBeUndefined();
    const logger = recordingLogger();
    const err = new Error("getter boom");

    reportComposite(err, logger);

    expect(logger.errors).toHaveLength(1);
    // The original error is forwarded as a trailing argument.
    expect(logger.errors[0]).toContain(err);
  });

  it("demotes to logger.error when reportError is hostile and throws (§ 12)", () => {
    const reportError = vi.fn(() => {
      throw new Error("hostile reportError");
    });
    (globalThis as { reportError?: unknown }).reportError = reportError;
    const logger = recordingLogger();
    const err = new Error("primary");

    expect(() => reportComposite(err, logger)).not.toThrow();

    expect(reportError).toHaveBeenCalledOnce();
    // The primary error is still observable through the logger fallback.
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]).toContain(err);
  });

  it("never throws even when the logger itself throws (must not break fan-out)", () => {
    const hostileLogger: Logger = {
      debug: () => {},
      warn: () => {},
      error: () => {
        throw new Error("hostile logger");
      },
    };
    expect(() => reportComposite(new Error("primary"), hostileLogger)).not.toThrow();
  });

  it("never throws when both reportError and the logger are hostile", () => {
    (globalThis as { reportError?: unknown }).reportError = () => {
      throw new Error("hostile reportError");
    };
    const hostileLogger: Logger = {
      debug: () => {},
      warn: () => {},
      error: () => {
        throw new Error("hostile logger");
      },
    };
    expect(() => reportComposite(new Error("primary"), hostileLogger)).not.toThrow();
  });
});

describe("consoleLogger", () => {
  it("forwards debug/warn/error to the matching console method", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    consoleLogger.debug("d", 1);
    consoleLogger.warn("w", 2);
    consoleLogger.error("e", 3);

    expect(debugSpy).toHaveBeenCalledWith("d", 1);
    expect(warnSpy).toHaveBeenCalledWith("w", 2);
    expect(errorSpy).toHaveBeenCalledWith("e", 3);
  });
});

describe("silentLogger", () => {
  it("drops everything without throwing", () => {
    expect(() => {
      silentLogger.debug("d");
      silentLogger.warn("w");
      silentLogger.error("e");
    }).not.toThrow();
  });
});
