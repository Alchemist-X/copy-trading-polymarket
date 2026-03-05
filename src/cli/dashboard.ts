import chalk from "chalk";
import type { TradeMonitor, DashboardEvent } from "../core/monitor.js";
import { loadAddresses, getCursor, upsertAddress } from "../lib/store.js";
import { pingLatency, fetchUsdcBalance } from "../lib/polymarket-api.js";
import { setDashboardMode } from "../lib/logger.js";
import type { FollowedAddress } from "../types/index.js";

const MAX_LOG = 200;

type Tab = "activity" | "monitor";
type InputMode = "normal" | "selectAddr" | "editPercent" | "editMinTrigger" | "editMaxPerMarket";

export class Dashboard {
  private monitor: TradeMonitor;
  private timer: ReturnType<typeof setInterval> | null = null;
  private latencyTimer: ReturnType<typeof setInterval> | null = null;
  private balanceTimer: ReturnType<typeof setInterval> | null = null;

  private balance = "—";
  private latencyMs = -1;
  private funderAddress: string;

  private tab: Tab = "activity";
  private eventLog: string[] = [];
  private inputMode: InputMode = "normal";
  private inputBuf = "";
  private selectedAddrIdx = -1;
  private promptText = "";

  constructor(monitor: TradeMonitor, funderAddress: string) {
    this.monitor = monitor;
    this.funderAddress = funderAddress;

    this.monitor.onEvent((ev) => this.handleEvent(ev));
  }

  async start() {
    setDashboardMode(true);

    this.refreshLatency();
    this.latencyTimer = setInterval(() => this.refreshLatency(), 5000);

    this.refreshBalance();
    this.balanceTimer = setInterval(() => this.refreshBalance(), 30_000);

    this.render();
    this.timer = setInterval(() => this.render(), 2000);

    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key: string) => this.handleKey(key));
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.latencyTimer) { clearInterval(this.latencyTimer); this.latencyTimer = null; }
    if (this.balanceTimer) { clearInterval(this.balanceTimer); this.balanceTimer = null; }
    setDashboardMode(false);
    process.stdin.setRawMode?.(false);
  }

  private async refreshLatency() {
    this.latencyMs = await pingLatency();
  }

  private async refreshBalance() {
    const bal = await fetchUsdcBalance(this.funderAddress);
    if (bal !== "—") {
      this.balance = `$${parseFloat(bal).toFixed(2)}`;
    }
  }

  private handleEvent(ev: DashboardEvent) {
    const exec = ev.exec;
    const who = exec.sourceUsername ?? exec.sourceAddress.slice(0, 8) + "..";
    const side = exec.sourceTrade.side;
    const amt = exec.sourceTrade.amount.toFixed(2);
    const market = (exec.market?.question ?? exec.sourceTrade.tokenId).slice(0, 30);
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });

    switch (ev.type) {
      case "detect":
        this.pushLog(
          `${chalk.dim(time)} ${chalk.cyan("DETECT")} ${chalk.dim(`[${who}]`)} ${side} $${amt}  ${chalk.dim(market)}`
        );
        break;
      case "copy": {
        const copyAmt = exec.executedTrade?.amount?.toFixed(2) ?? "?";
        const copyPrice = exec.executedTrade?.price?.toFixed(2) ?? "?";
        this.pushLog(
          `${chalk.dim(time)} ${chalk.green.bold("COPY  ")} ${side} $${copyAmt} @ ${copyPrice}  ${chalk.dim(market)}`
        );
        break;
      }
      case "skip":
        this.pushLog(
          `${chalk.dim(time)} ${chalk.yellow("SKIP  ")} ${chalk.dim(`[${who}]`)} ${side} $${amt} ${chalk.dim("→")} ${chalk.yellow(exec.reason ?? "filtered")}  ${chalk.dim(market)}`
        );
        break;
      case "fail":
        this.pushLog(
          `${chalk.dim(time)} ${chalk.red("FAIL  ")} ${chalk.dim(`[${who}]`)} ${side} $${amt} ${chalk.dim("→")} ${chalk.red(exec.reason?.slice(0, 40) ?? "error")}  ${chalk.dim(market)}`
        );
        break;
    }
  }

  private pushLog(line: string) {
    this.eventLog.push(line);
    if (this.eventLog.length > MAX_LOG) {
      this.eventLog = this.eventLog.slice(-MAX_LOG);
    }
  }

  private handleKey(key: string) {
    if (this.inputMode !== "normal") {
      this.handleInputKey(key);
      return;
    }

    switch (key) {
      case "q":
      case "\u0003":
        this.stop();
        this.monitor.stop();
        process.exit(0);
        break;
      case "1":
        this.tab = "activity";
        this.render();
        break;
      case "2":
        this.tab = "monitor";
        this.render();
        break;
      case " ": {
        const s = this.monitor.stats;
        if (s.enabledAddresses > 0) {
          this.monitor.pauseAll();
          this.pushLog(`${chalk.dim(timeNow())} ${chalk.yellow("PAUSED")} all addresses`);
        } else {
          this.monitor.resumeAll();
          this.pushLog(`${chalk.dim(timeNow())} ${chalk.green("RESUMED")} all addresses`);
        }
        this.render();
        break;
      }
      case "p":
      case "%":
        this.beginSelectAddr("editPercent");
        break;
      case "l":
      case "L":
        this.beginSelectAddr("editMinTrigger");
        break;
    }
  }

  private beginSelectAddr(nextMode: InputMode) {
    const addrs = loadAddresses();
    if (addrs.length === 0) {
      this.promptText = "No addresses to edit";
      this.render();
      setTimeout(() => { this.promptText = ""; this.render(); }, 2000);
      return;
    }
    if (addrs.length === 1) {
      this.selectedAddrIdx = 0;
      this.inputMode = nextMode;
      this.inputBuf = "";
      this.promptText = this.getPromptForMode(nextMode, addrs[0]);
      this.render();
      return;
    }
    this.inputMode = "selectAddr";
    this.inputBuf = "";
    (this as any)._nextMode = nextMode;
    this.promptText = `Select address # (1-${addrs.length}): `;
    this.render();
  }

  private getPromptForMode(mode: InputMode, addr: FollowedAddress): string {
    const label = addr.username ?? addr.nickname ?? addr.address.slice(0, 10);
    switch (mode) {
      case "editPercent": return `Copy % for [${label}] (current: ${((addr.percentage ?? 0) * 100).toFixed(0)}%): `;
      case "editMinTrigger": return `Min trigger $ for [${label}] (current: ${addr.filters.minTrigger ?? 0}): `;
      case "editMaxPerMarket": return `Max per market $ for [${label}] (current: ${addr.filters.maxPerMarket ?? "none"}): `;
      default: return "";
    }
  }

  private handleInputKey(key: string) {
    if (key === "\u0003" || key === "\x1b") {
      this.inputMode = "normal";
      this.inputBuf = "";
      this.promptText = "";
      this.render();
      return;
    }

    if (key === "\r" || key === "\n") {
      this.commitInput();
      return;
    }

    if (key === "\x7f") {
      this.inputBuf = this.inputBuf.slice(0, -1);
      this.render();
      return;
    }

    if (key.length === 1 && key >= " ") {
      this.inputBuf += key;
      this.render();
    }
  }

  private commitInput() {
    const addrs = loadAddresses();

    if (this.inputMode === "selectAddr") {
      const n = parseInt(this.inputBuf);
      if (n >= 1 && n <= addrs.length) {
        this.selectedAddrIdx = n - 1;
        const nextMode = (this as any)._nextMode as InputMode;
        this.inputMode = nextMode;
        this.inputBuf = "";
        this.promptText = this.getPromptForMode(nextMode, addrs[this.selectedAddrIdx]);
        this.render();
      } else {
        this.promptText = `Invalid. Select 1-${addrs.length}: `;
        this.inputBuf = "";
        this.render();
      }
      return;
    }

    const addr = addrs[this.selectedAddrIdx];
    if (!addr) {
      this.inputMode = "normal";
      this.inputBuf = "";
      this.promptText = "";
      this.render();
      return;
    }

    const val = parseFloat(this.inputBuf);

    if (this.inputMode === "editPercent") {
      if (!isNaN(val) && val > 0 && val <= 100) {
        const pct = val > 1 ? val / 100 : val;
        addr.percentage = pct;
        upsertAddress(addr);
        const label = addr.username ?? addr.address.slice(0, 10);
        this.pushLog(`${chalk.dim(timeNow())} ${chalk.magenta("EDIT")}  [${label}] copy% → ${(pct * 100).toFixed(0)}%`);
      }
      this.inputMode = "normal";
      this.inputBuf = "";
      this.promptText = "";
      this.render();
      return;
    }

    if (this.inputMode === "editMinTrigger") {
      if (!isNaN(val) && val >= 0) {
        addr.filters.minTrigger = val;
        upsertAddress(addr);
        const label = addr.username ?? addr.address.slice(0, 10);
        this.pushLog(`${chalk.dim(timeNow())} ${chalk.magenta("EDIT")}  [${label}] minTrigger → $${val}`);
      }
      this.inputMode = "editMaxPerMarket";
      this.inputBuf = "";
      this.promptText = this.getPromptForMode("editMaxPerMarket", addr);
      this.render();
      return;
    }

    if (this.inputMode === "editMaxPerMarket") {
      if (!isNaN(val) && val > 0) {
        addr.filters.maxPerMarket = val;
        upsertAddress(addr);
        const label = addr.username ?? addr.address.slice(0, 10);
        this.pushLog(`${chalk.dim(timeNow())} ${chalk.magenta("EDIT")}  [${label}] maxPerMarket → $${val}`);
      }
      this.inputMode = "normal";
      this.inputBuf = "";
      this.promptText = "";
      this.render();
      return;
    }

    this.inputMode = "normal";
    this.inputBuf = "";
    this.promptText = "";
    this.render();
  }

  private render() {
    const W = Math.min(process.stdout.columns ?? 80, 80);
    const H = process.stdout.rows ?? 24;
    const lines: string[] = [];

    lines.push(...this.renderHeader(W));
    lines.push(this.renderTabBar(W));

    const footerLines = this.renderFooter(W);
    const contentH = Math.max(1, H - lines.length - footerLines.length);

    if (this.tab === "activity") {
      lines.push(...this.renderActivityTab(W, contentH));
    } else {
      lines.push(...this.renderMonitorTab(W, contentH));
    }

    lines.push(...footerLines);

    process.stdout.write("\x1b[H\x1b[2J");
    process.stdout.write(lines.join("\n") + "\n");
  }

  private renderHeader(W: number): string[] {
    const s = this.monitor.stats;
    const status = s.running ? chalk.green.bold("● RUNNING") : chalk.red.bold("● STOPPED");

    let latStr: string;
    if (this.latencyMs < 0) latStr = chalk.dim("—");
    else if (this.latencyMs < 100) latStr = chalk.green(`${this.latencyMs}ms`);
    else if (this.latencyMs < 500) latStr = chalk.yellow(`${this.latencyMs}ms`);
    else latStr = chalk.red(`${this.latencyMs}ms`);

    const line1 = ` ${status}  USDC: ${chalk.yellow(this.balance)}  Latency: ${latStr}  Cycle: ${chalk.white(String(s.cycleCount))}/${chalk.white(s.lastCycleMs + "ms")}`;
    const line2 = ` Addr: ${chalk.green(String(s.enabledAddresses))} active ${chalk.yellow(String(s.pausedAddresses))} paused  |  Trades: ${chalk.blue(String(s.tradesDetected))} det ${chalk.green(String(s.tradesExecuted))} exec ${chalk.gray(String(s.tradesSkipped))} skip ${chalk.red(String(s.tradesFailed))} fail`;

    return [
      chalk.cyan("═".repeat(W)),
      line1,
      line2,
      chalk.cyan("═".repeat(W)),
    ];
  }

  private renderTabBar(W: number): string {
    const t1 = this.tab === "activity"
      ? chalk.bold.white.bgCyan(" 1 Activity ")
      : chalk.dim(" 1 Activity ");
    const t2 = this.tab === "monitor"
      ? chalk.bold.white.bgCyan(" 2 Monitor ")
      : chalk.dim(" 2 Monitor ");
    return ` ${t1}  ${t2}` + " ".repeat(Math.max(0, W - 30));
  }

  private renderActivityTab(W: number, contentH: number): string[] {
    const lines: string[] = [];
    const visible = this.eventLog.slice(-contentH);

    if (visible.length === 0) {
      lines.push(chalk.dim("  Waiting for trades..."));
      for (let i = 1; i < contentH; i++) lines.push("");
    } else {
      const pad = contentH - visible.length;
      for (let i = 0; i < pad; i++) lines.push("");
      for (const l of visible) lines.push(" " + l);
    }

    return lines;
  }

  private renderMonitorTab(W: number, contentH: number): string[] {
    const lines: string[] = [];
    const addrs = loadAddresses();

    const hdr = chalk.bold(
      `  ${"#".padEnd(3)} ${"Username/Address".padEnd(30)} ${"Status".padEnd(8)} ${"Copy%".padEnd(7)} ${"Mode".padEnd(12)} ${"Last Active".padEnd(12)}`
    );
    lines.push(hdr);
    lines.push(chalk.dim("  " + "─".repeat(W - 4)));

    for (let i = 0; i < addrs.length; i++) {
      const a = addrs[i];
      const num = String(i + 1).padEnd(3);
      const name = a.username
        ? `@${a.username} (${a.address.slice(0, 6)}..)`.padEnd(30)
        : `${a.address.slice(0, 16)}..`.padEnd(30);
      const st = a.enabled
        ? chalk.green("active".padEnd(8))
        : chalk.yellow("paused".padEnd(8));

      let pct = "—";
      if (a.copyMode === "percentage" && a.percentage != null) {
        pct = `${(a.percentage * 100).toFixed(0)}%`;
      } else if (a.copyMode === "fixed" && a.fixedAmount != null) {
        pct = `$${a.fixedAmount}`;
      }

      const mode = a.copyMode.padEnd(12);
      const cursor = getCursor(a.address);
      let lastActive = "—";
      if (cursor) {
        const ago = Date.now() - cursor.lastActivityAt;
        if (ago < 60_000) lastActive = `${Math.floor(ago / 1000)}s ago`;
        else if (ago < 3600_000) lastActive = `${Math.floor(ago / 60_000)}m ago`;
        else lastActive = `${Math.floor(ago / 3600_000)}h ago`;
      }

      lines.push(`  ${num} ${name} ${st} ${pct.padEnd(7)} ${mode} ${lastActive.padEnd(12)}`);
    }

    while (lines.length < contentH) lines.push("");
    return lines.slice(0, contentH);
  }

  private renderFooter(W: number): string[] {
    const lines: string[] = [];
    lines.push(chalk.cyan("═".repeat(W)));

    if (this.inputMode !== "normal") {
      lines.push(chalk.yellow(` ${this.promptText}${this.inputBuf}█`));
    } else {
      const paused = this.monitor.stats.enabledAddresses === 0 && this.monitor.stats.totalAddresses > 0;
      const spaceLabel = paused ? "Resume" : "Pause";
      lines.push(
        chalk.dim(` [q]Quit  [1]Activity  [2]Monitor  [%]Edit Copy%  [L]Limits  [Space]${spaceLabel}`)
      );
    }

    return lines;
  }
}

function timeNow(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}
