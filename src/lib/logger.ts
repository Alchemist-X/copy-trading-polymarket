import chalk from "chalk";

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

export function setVerbose(v: boolean) {
  verboseMode = v;
}

export function log(level: LogLevel, msg: string, extra?: unknown) {
  if (level === "debug" && !verboseMode) return;
  const ts = new Date().toISOString().slice(11, 23);
  const style = LEVEL_STYLE[level];
  const label = LEVEL_LABEL[level];
  const prefix = chalk.dim(ts) + " " + style(`[${label}]`);
  console.log(`${prefix} ${msg}`);
  if (extra !== undefined && verboseMode) {
    console.log(chalk.dim(JSON.stringify(extra, null, 2)));
  }
}
