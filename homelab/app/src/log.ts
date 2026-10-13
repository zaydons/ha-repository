// Line logger for the HA app log (stdout/stderr). Every line is redacted with
// the currently registered secrets before it is written.
import type { LogFields, Logger, LogLevel } from "./types.ts";
import { redact } from "./redact.ts";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warning: 30, error: 40 };
const LABEL: Record<LogLevel, string> = { debug: "DEBUG", info: "INFO", warning: "WARNING", error: "ERROR" };

export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warning", "error"];

export type LogSink = (level: LogLevel, line: string) => void;

const defaultSink: LogSink = (level, line) => {
  if (level === "error" || level === "warning") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
};

interface LoggerState {
  level: LogLevel;
  secrets: string[];
  sink: LogSink;
}

const state: LoggerState = { level: "info", secrets: [], sink: defaultSink };

/** WS1 calls this after every config load with NormalisedConfig.secrets. */
export function setLogSecrets(values: Iterable<string>): void {
  state.secrets = [...new Set(values)];
}

export function setLogLevel(level: LogLevel): void {
  if (level in ORDER) state.level = level;
}

/** Tests only. */
export function setLogSink(sink: LogSink | null): void {
  state.sink = sink ?? defaultSink;
}

function formatFields(fields: LogFields | undefined): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    let s: string;
    if (v instanceof Error) s = v.message;
    else if (typeof v === "string") s = v;
    else {
      try {
        s = JSON.stringify(v) ?? String(v);
      } catch {
        s = "[unserialisable]";
      }
    }
    parts.push(`${k}=${/[\s"=]/.test(s) ? JSON.stringify(s) : s}`);
  }
  return parts.length ? " " + parts.join(" ") : "";
}

function write(level: LogLevel, scope: string, msg: string, fields?: LogFields): void {
  if (ORDER[level] < ORDER[state.level]) return;
  const prefix = scope ? `[${scope}] ` : "";
  const body = redact(`${prefix}${msg}${formatFields(fields)}`, state.secrets).replace(/[\r\n]+/g, " ");
  state.sink(level, `${new Date().toISOString()} ${LABEL[level]} ${body}`);
}

export function createLogger(scope = ""): Logger {
  return {
    debug: (m, f) => write("debug", scope, m, f),
    info: (m, f) => write("info", scope, m, f),
    warn: (m, f) => write("warning", scope, m, f),
    error: (m, f) => write("error", scope, m, f),
    child: (s) => createLogger(scope ? `${scope}:${s}` : s),
  };
}
