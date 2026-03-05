import chalk from "chalk";
import type { TradeMonitor } from "../core/monitor.js";
import { loadHistory, loadAddresses } from "../lib/store.js";
import type { TradeExecution } from "../types/index.js";

const REFRESH_MS = 2000;

export class Dashboard {
  private monitor: TradeMonitor;
  private timer: ReturnType<typeof setInterval> | null = null;
  private balance: string = "—";

  constructor(monitor: TradeMonitor) {
    this.monitor = monitor;
  }

  start() {
    this.render();
    this.timer = setInterval(() => this.render(), REFRESH_MS);

    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key: string) => {
      if (key === "q" || key === "\u0003") {
        this.stop();
        this.monitor.stop();
        process.exit(0);
      }
    });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    process.stdin.setRawMode?.(false);
  }

  setBalance(bal: string) {
    this.balance = bal;
  }

  private render() {
    const s = this.monitor.stats;
    const history = loadHistory().slice(-15).reverse();

    console.clear();
    console.log(chalk.bold.cyan("╔══════════════════════════════════════════════════════════════════╗"));
    console.log(chalk.bold.cyan("║") + chalk.bold("        Polymarket Copy Trading Monitor") + chalk.bold.cyan("                         ║"));
    console.log(chalk.bold.cyan("╠══════════════════════════════════════════════════════════════════╣"));
    console.log(chalk.bold.cyan("║") + ` Status: ${s.running ? chalk.green.bold("● RUNNING") : chalk.red.bold("● STOPPED")}` + pad(54 - (s.running ? 9 : 9)) + chalk.bold.cyan("║"));
    console.log(chalk.bold.cyan("║") + ` USDC Balance: ${chalk.yellow(this.balance)}` + pad(49 - this.balance.length) + chalk.bold.cyan("║"));
    console.log(chalk.bold.cyan("║") + ` Cycle: ${chalk.white(String(s.cycleCount))}  Last: ${chalk.white(s.lastCycleMs + "ms")}` + pad(42 - String(s.cycleCount).length - String(s.lastCycleMs).length) + chalk.bold.cyan("║"));
    console.log(chalk.bold.cyan("╠══════════════════════════════════════════════════════════════════╣"));
    console.log(chalk.bold.cyan("║") + ` Addresses: ${chalk.white(String(s.totalAddresses))} total  ${chalk.green(String(s.enabledAddresses))} active  ${chalk.yellow(String(s.pausedAddresses))} paused` + pad(25 - String(s.totalAddresses).length - String(s.enabledAddresses).length - String(s.pausedAddresses).length) + chalk.bold.cyan("║"));
    console.log(chalk.bold.cyan("║") + ` Trades: ${chalk.blue(String(s.tradesDetected))} detected  ${chalk.green(String(s.tradesExecuted))} executed  ${chalk.gray(String(s.tradesSkipped))} skipped  ${chalk.red(String(s.tradesFailed))} failed` + pad(6 - String(s.tradesDetected).length - String(s.tradesExecuted).length - String(s.tradesSkipped).length - String(s.tradesFailed).length) + chalk.bold.cyan("║"));
    console.log(chalk.bold.cyan("╠══════════════════════════════════════════════════════════════════╣"));
    console.log(chalk.bold.cyan("║") + chalk.bold(" Recent Executions") + pad(46) + chalk.bold.cyan("║"));
    console.log(chalk.bold.cyan("╠══════════════════════════════════════════════════════════════════╣"));

    if (history.length === 0) {
      console.log(chalk.bold.cyan("║") + chalk.dim("  No trades yet...") + pad(46) + chalk.bold.cyan("║"));
    } else {
      for (const exec of history.slice(0, 10)) {
        const line = formatExecution(exec);
        const visible = stripAnsi(line).length;
        const padLen = Math.max(0, 64 - visible);
        console.log(chalk.bold.cyan("║") + line + " ".repeat(padLen) + chalk.bold.cyan("║"));
      }
    }

    console.log(chalk.bold.cyan("╠══════════════════════════════════════════════════════════════════╣"));
    console.log(chalk.bold.cyan("║") + chalk.dim("  [q] quit") + pad(54) + chalk.bold.cyan("║"));
    console.log(chalk.bold.cyan("╚══════════════════════════════════════════════════════════════════╝"));
  }
}

function formatExecution(exec: TradeExecution): string {
  const time = exec.timestamp.slice(11, 19);
  const addr = exec.sourceAddress.slice(0, 6) + "..";
  const statusIcon = exec.status === "success"
    ? chalk.green("✓")
    : exec.status === "skipped"
      ? chalk.gray("○")
      : chalk.red("✗");

  const side = exec.executedTrade?.side ?? exec.sourceTrade.side;
  const sideCol = side === "BUY" ? chalk.green(side) : chalk.red(side);
  const amount = exec.executedTrade?.amount ?? exec.sourceTrade.amount;
  const market = (exec.market?.question ?? exec.sourceTrade.tokenId).slice(0, 22);

  return `  ${chalk.dim(time)} ${statusIcon} ${sideCol} $${amount.toFixed(1).padEnd(6)} ${chalk.dim(addr)} ${market}`;
}

function pad(n: number): string {
  return " ".repeat(Math.max(0, n));
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}
