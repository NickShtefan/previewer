import type { RunLogger } from "../core";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger extends RunLogger {
  debug(msg: string, extra?: unknown): void;
}

/** Minimal leveled logger writing to stderr. Swap for structured logs in Phase 2. */
export function createLogger(scope: string, level: LogLevel = "info"): Logger {
  const order: LogLevel[] = ["debug", "info", "warn", "error"];
  const min = order.indexOf(level);
  const emit = (lvl: LogLevel, msg: string, extra?: unknown): void => {
    if (order.indexOf(lvl) < min) return;
    const line = `[${lvl}] ${scope}: ${msg}`;
    if (extra !== undefined) console.error(line, extra);
    else console.error(line);
  };
  return {
    debug: (m, e) => emit("debug", m, e),
    info: (m, e) => emit("info", m, e),
    warn: (m, e) => emit("warn", m, e),
    error: (m, e) => emit("error", m, e),
  };
}
