import chalk from "chalk";
import { mkdirSync, appendFileSync, readdirSync, unlinkSync } from "fs";
import { join, resolve } from "path";

export type LogLevel = "info" | "warn" | "error" | "trade" | "skip" | "debug";

const LEVEL_STYLE: Record<LogLevel, (s: string) => string> = {
  info: chalk.blue,
  warn: chalk.yellow,
  error: chalk.red,
  trade: chalk.green,
  skip: chalk.gray,
  debug: chalk.dim,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
  trade: "TRADE",
  skip: "SKIP ",
  debug: "DEBUG",
};

let verboseMode = false;
let dashboardMode = false;

const LOGS_DIR = resolve("logs");
const MAX_LOG_DAYS = 30;

function ensureLogsDir() {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
  } catch { /* already exists */ }
}

function todayTag(): string {
  return new Date().toISOString().slice(0, 10);
}

function engineLogPath(date?: string): string {
  return join(LOGS_DIR, `engine-${date ?? todayTag()}.log`);
}

function errorsLogPath(): string {
  return join(LOGS_DIR, "errors.log");
}

function commandsLogPath(): string {
  return join(LOGS_DIR, "commands.log");
}

function appendJsonl(filePath: string, obj: Record<string, unknown>) {
  ensureLogsDir();
  appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf-8");
}

function cleanOldLogs() {
  try {
    const files = readdirSync(LOGS_DIR);
    const cutoff = Date.now() - MAX_LOG_DAYS * 24 * 60 * 60 * 1000;
    for (const f of files) {
      const match = f.match(/^engine-(\d{4}-\d{2}-\d{2})\.log$/);
      if (match) {
        const fileDate = new Date(match[1]).getTime();
        if (fileDate < cutoff) {
          try { unlinkSync(join(LOGS_DIR, f)); } catch { /* ignore */ }
        }
      }
    }
  } catch { /* ignore */ }
}

let lastCleanup = 0;

export function setVerbose(v: boolean) {
  verboseMode = v;
}

export function setDashboardMode(v: boolean) {
  dashboardMode = v;
}

export function log(level: LogLevel, msg: string, ctx?: Record<string, unknown>) {
  if (level === "debug" && !verboseMode) return;

  const ts = new Date().toISOString();
  const tsShort = ts.slice(11, 23);
  const style = LEVEL_STYLE[level];
  const label = LEVEL_LABEL[level];
  if (!dashboardMode) {
    const prefix = chalk.dim(tsShort) + " " + style(`[${label}]`);
    console.log(`${prefix} ${msg}`);
    if (ctx !== undefined && verboseMode) {
      console.log(chalk.dim(JSON.stringify(ctx, null, 2)));
    }
  }

  const entry: Record<string, unknown> = { ts, level, msg };
  if (ctx) entry.ctx = ctx;
  appendJsonl(engineLogPath(), entry);

  if (level === "error") {
    appendJsonl(errorsLogPath(), entry);
  }

  if (Date.now() - lastCleanup > 3600_000) {
    lastCleanup = Date.now();
    cleanOldLogs();
  }
}

export interface CommandLogEntry {
  ts: string;
  cmd: string;
  args: string[];
  result: "ok" | "error";
  detail?: Record<string, unknown>;
  error?: string;
}

export function logCommand(
  cmd: string,
  args: string[],
  result: "ok" | "error",
  detail?: Record<string, unknown>,
  error?: string,
) {
  const entry: CommandLogEntry = {
    ts: new Date().toISOString(),
    cmd,
    args,
    result,
  };
  if (detail) entry.detail = detail;
  if (error) entry.error = error;
  appendJsonl(commandsLogPath(), entry as unknown as Record<string, unknown>);
}

export function getLogPath(type: "engine" | "errors" | "commands", date?: string): string {
  ensureLogsDir();
  switch (type) {
    case "engine": return engineLogPath(date);
    case "errors": return errorsLogPath();
    case "commands": return commandsLogPath();
  }
}
