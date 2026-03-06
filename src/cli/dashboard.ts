import chalk from "chalk";
import type { TradeMonitor, DashboardEvent } from "../core/monitor.js";
import { loadAddresses, getCursor, upsertAddress, loadHistory } from "../lib/store.js";
import { pingLatency, fetchUsdcBalance } from "../lib/polymarket-api.js";
import { setDashboardMode } from "../lib/logger.js";
import type { FollowedAddress } from "../types/index.js";

const MAX_LOG = 200;
const INNER = 66;
const W = INNER + 2;

type Tab = "activity" | "monitor";
type InputMode = "normal" | "selectAddr" | "editPercent" | "editMinTrigger" | "editMaxPerMarket";

function fmtAddr(address: string): string {
  return `0x${address.slice(2, 6)}...${address.slice(-4)}`;
}

function fmtWho(username: string | undefined, address: string): string {
  const short = fmtAddr(address);
  if (username) return `${username.slice(0, 6)} (${short})`;
  return short;
}

function boxTop(): string { return chalk.cyan("╔" + "═".repeat(INNER) + "╗"); }
function boxMid(): string { return chalk.cyan("╠" + "═".repeat(INNER) + "╣"); }
function boxBot(): string { return chalk.cyan("╚" + "═".repeat(INNER) + "╝"); }

function boxLine(content: string): string {
  const raw = stripAnsi(content);
  const pad = Math.max(0, INNER - raw.length);
  return chalk.cyan("║") + content + " ".repeat(pad) + chalk.cyan("║");
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

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

  private async refreshLatency() { this.latencyMs = await pingLatency(); }

  private async refreshBalance() {
    const bal = await fetchUsdcBalance(this.funderAddress);
    if (bal !== "—") this.balance = `$${parseFloat(bal).toFixed(2)}`;
  }

  private handleEvent(ev: DashboardEvent) {
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });

    if (ev.type === "redeem") {
      const r = ev.redeem;
      const market = (r.question ?? r.conditionId).slice(0, 30);
      this.pushLog(
        `${chalk.dim(time)} ${chalk.green.bold("REDEEM")} ${chalk.dim(market)}  tx:${r.txHash.slice(0, 10)}..`
      );
      return;
    }

    const exec = ev.exec;
    const who = fmtWho(exec.sourceUsername, exec.sourceAddress);
    const side = exec.sourceTrade.side;
    const amt = exec.sourceTrade.amount.toFixed(2);
    const market = (exec.market?.question ?? exec.sourceTrade.tokenId).slice(0, 24);

    switch (ev.type) {
      case "detect":
        this.pushLog(
          `${chalk.dim(time)} ${chalk.cyan("DETECT")} ${chalk.dim(who)} ${side} $${amt}  ${chalk.dim(market)}`
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
          `${chalk.dim(time)} ${chalk.yellow("SKIP  ")} ${chalk.dim(who)} ${side} $${amt} ${chalk.dim("→")} ${chalk.yellow(exec.reason ?? "filtered")}`
        );
        break;
      case "fail":
        this.pushLog(
          `${chalk.dim(time)} ${chalk.red("FAIL  ")} ${chalk.dim(who)} ${side} $${amt} ${chalk.dim("→")} ${chalk.red(exec.reason?.slice(0, 30) ?? "error")}`
        );
        break;
    }
  }

  private pushLog(line: string) {
    this.eventLog.push(line);
    if (this.eventLog.length > MAX_LOG) this.eventLog = this.eventLog.slice(-MAX_LOG);
  }

  // ─── Keyboard ───

  private handleKey(key: string) {
    if (this.inputMode !== "normal") { this.handleInputKey(key); return; }
    switch (key) {
      case "q": case "\u0003":
        this.stop(); this.monitor.stop(); process.exit(0); break;
      case "1": this.tab = "activity"; this.render(); break;
      case "2": this.tab = "monitor"; this.render(); break;
      case " ": {
        const s = this.monitor.stats;
        if (s.enabledAddresses > 0) {
          this.monitor.pauseAll();
          this.pushLog(`${chalk.dim(timeNow())} ${chalk.yellow("PAUSED")} all addresses`);
        } else {
          this.monitor.resumeAll();
          this.pushLog(`${chalk.dim(timeNow())} ${chalk.green("RESUMED")} all addresses`);
        }
        this.render(); break;
      }
      case "p": case "%": this.beginSelectAddr("editPercent"); break;
      case "l": case "L": this.beginSelectAddr("editMinTrigger"); break;
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
    const label = fmtWho(addr.username, addr.address);
    switch (mode) {
      case "editPercent": return `Copy % for ${label} (now ${((addr.percentage ?? 0) * 100).toFixed(0)}%): `;
      case "editMinTrigger": return `Min trigger $ for ${label} (now ${addr.filters.minTrigger ?? 0}): `;
      case "editMaxPerMarket": return `Max/market $ for ${label} (now ${addr.filters.maxPerMarket ?? "none"}): `;
      default: return "";
    }
  }

  private handleInputKey(key: string) {
    if (key === "\u0003" || key === "\x1b") {
      this.inputMode = "normal"; this.inputBuf = ""; this.promptText = ""; this.render(); return;
    }
    if (key === "\r" || key === "\n") { this.commitInput(); return; }
    if (key === "\x7f") { this.inputBuf = this.inputBuf.slice(0, -1); this.render(); return; }
    if (key.length === 1 && key >= " ") { this.inputBuf += key; this.render(); }
  }

  private commitInput() {
    const addrs = loadAddresses();
    if (this.inputMode === "selectAddr") {
      const n = parseInt(this.inputBuf);
      if (n >= 1 && n <= addrs.length) {
        this.selectedAddrIdx = n - 1;
        const nextMode = (this as any)._nextMode as InputMode;
        this.inputMode = nextMode; this.inputBuf = "";
        this.promptText = this.getPromptForMode(nextMode, addrs[this.selectedAddrIdx]);
        this.render();
      } else {
        this.promptText = `Invalid. Select 1-${addrs.length}: `; this.inputBuf = ""; this.render();
      }
      return;
    }
    const addr = addrs[this.selectedAddrIdx];
    if (!addr) { this.inputMode = "normal"; this.inputBuf = ""; this.promptText = ""; this.render(); return; }
    const val = parseFloat(this.inputBuf);
    const label = fmtWho(addr.username, addr.address);

    if (this.inputMode === "editPercent") {
      if (!isNaN(val) && val > 0 && val <= 100) {
        const pct = val > 1 ? val / 100 : val;
        addr.percentage = pct; upsertAddress(addr);
        this.pushLog(`${chalk.dim(timeNow())} ${chalk.magenta("EDIT")}  ${label} copy% → ${(pct * 100).toFixed(0)}%`);
      }
      this.inputMode = "normal"; this.inputBuf = ""; this.promptText = ""; this.render(); return;
    }
    if (this.inputMode === "editMinTrigger") {
      if (!isNaN(val) && val >= 0) {
        addr.filters.minTrigger = val; upsertAddress(addr);
        this.pushLog(`${chalk.dim(timeNow())} ${chalk.magenta("EDIT")}  ${label} minTrigger → $${val}`);
      }
      this.inputMode = "editMaxPerMarket"; this.inputBuf = "";
      this.promptText = this.getPromptForMode("editMaxPerMarket", addr); this.render(); return;
    }
    if (this.inputMode === "editMaxPerMarket") {
      if (!isNaN(val) && val > 0) {
        addr.filters.maxPerMarket = val; upsertAddress(addr);
        this.pushLog(`${chalk.dim(timeNow())} ${chalk.magenta("EDIT")}  ${label} maxPerMarket → $${val}`);
      }
      this.inputMode = "normal"; this.inputBuf = ""; this.promptText = ""; this.render(); return;
    }
    this.inputMode = "normal"; this.inputBuf = ""; this.promptText = ""; this.render();
  }

  // ─── Render ───

  private render() {
    const H = process.stdout.rows ?? 24;
    const lines: string[] = [];

    lines.push(...this.renderHeader());
    lines.push(...this.renderTabBar());

    const footerLines = this.renderFooter();
    const contentH = Math.max(1, H - lines.length - footerLines.length);

    if (this.tab === "activity") {
      lines.push(...this.renderActivityTab(contentH));
    } else {
      lines.push(...this.renderMonitorTab(contentH));
    }

    lines.push(...footerLines);

    process.stdout.write("\x1b[H\x1b[2J");
    process.stdout.write(lines.join("\n") + "\n");
  }

  private renderHeader(): string[] {
    const s = this.monitor.stats;
    const status = s.running ? chalk.green.bold("● RUNNING") : chalk.red.bold("● STOPPED");

    let latStr: string;
    if (this.latencyMs < 0) latStr = chalk.dim("—");
    else if (this.latencyMs < 100) latStr = chalk.green(`${this.latencyMs}ms`);
    else if (this.latencyMs < 500) latStr = chalk.yellow(`${this.latencyMs}ms`);
    else latStr = chalk.red(`${this.latencyMs}ms`);

    const titleRight = chalk.dim(`Cycle #${s.cycleCount}`);
    const titleText = chalk.bold("  Polymarket Copy Trading Monitor");
    const titleRaw = stripAnsi(titleText).length + stripAnsi(titleRight).length;
    const titlePad = Math.max(1, INNER - titleRaw);
    const titleLine = titleText + " ".repeat(titlePad) + titleRight;

    const line1 = `  ${status}    USDC: ${chalk.yellow(this.balance)}    Latency: ${latStr}`;
    const line2 = `  Addresses: ${chalk.green(String(s.enabledAddresses))} active / ${chalk.yellow(String(s.pausedAddresses))} paused`;
    const line3 = `  Trades: ${chalk.blue(String(s.tradesDetected))} detected  ${chalk.green(String(s.tradesExecuted))} executed  ${chalk.gray(String(s.tradesSkipped))} skipped  ${chalk.red(String(s.tradesFailed))} failed`;

    return [
      boxTop(),
      boxLine(titleLine),
      boxMid(),
      boxLine(line1),
      boxLine(line2),
      boxLine(line3),
    ];
  }

  private renderTabBar(): string[] {
    const t1 = this.tab === "activity"
      ? chalk.bold.white.bgCyan(" 1 Activity ")
      : chalk.dim(" 1 Activity ");
    const t2 = this.tab === "monitor"
      ? chalk.bold.white.bgCyan(" 2 Monitor ")
      : chalk.dim(" 2 Monitor ");
    const tabContent = `══${stripAnsi(t1).length > 0 ? "" : ""}${t1}══${t2}`;
    const tabRaw = 2 + stripAnsi(t1).length + 2 + stripAnsi(t2).length;
    const remaining = Math.max(0, INNER - tabRaw);
    const tabLine = chalk.cyan("╠") + chalk.cyan("══") + t1 + chalk.cyan("══") + t2 + chalk.cyan("═".repeat(remaining)) + chalk.cyan("╣");
    return [tabLine];
  }

  private renderActivityTab(contentH: number): string[] {
    const lines: string[] = [];
    const visible = this.eventLog.slice(-contentH);

    if (visible.length === 0) {
      const history = loadHistory().slice(-20).reverse();
      const addrs = loadAddresses();
      const addrMap = new Map(addrs.map(a => [a.address.toLowerCase(), a]));

      if (history.length === 0) {
        lines.push(boxLine(chalk.dim("  Waiting for trades...")));
        for (let i = 1; i < contentH; i++) lines.push(boxLine(""));
      } else {
        lines.push(boxLine(chalk.dim("  Recent trades from tracked addresses:")));
        lines.push(boxLine(""));
        const maxItems = Math.min(history.length, contentH - 2);
        for (let i = 0; i < maxItems; i++) {
          const h = history[i];
          const addr = addrMap.get(h.sourceAddress.toLowerCase());
          const who = fmtWho(h.sourceUsername ?? addr?.username, h.sourceAddress);
          const side = h.sourceTrade.side;
          const amt = h.sourceTrade.amount.toFixed(2);
          const market = (h.market?.question ?? "").slice(0, 20);
          const pct = addr?.percentage != null ? `${(addr.percentage * 100).toFixed(0)}%` : "";
          const statusIcon = h.status === "success" ? chalk.green("✓") : h.status === "skipped" ? chalk.gray("○") : chalk.red("✗");
          const line = `  ${statusIcon} ${chalk.dim(who)}  ${side} $${amt}  ${chalk.dim(market)}  ${chalk.cyan(pct)}`;
          lines.push(boxLine(line));
        }
        for (let i = maxItems + 2; i < contentH; i++) lines.push(boxLine(""));
      }
    } else {
      const pad = contentH - visible.length;
      for (let i = 0; i < pad; i++) lines.push(boxLine(""));
      for (const l of visible) lines.push(boxLine(" " + l));
    }

    return lines;
  }

  private renderMonitorTab(contentH: number): string[] {
    const lines: string[] = [];
    const addrs = loadAddresses();

    const hdr = chalk.bold(
      `  ${"#".padEnd(3)} ${"Address".padEnd(28)} ${"Status".padEnd(8)} ${"Copy".padEnd(6)} ${"Mode".padEnd(11)} ${"Last"}`
    );
    lines.push(boxLine(hdr));
    lines.push(boxLine(chalk.dim("  " + "─".repeat(INNER - 4))));

    for (let i = 0; i < addrs.length; i++) {
      const a = addrs[i];
      const num = String(i + 1).padEnd(3);
      const name = fmtWho(a.username, a.address).padEnd(28);
      const st = a.enabled ? chalk.green("active".padEnd(8)) : chalk.yellow("paused".padEnd(8));

      let pct = "—";
      if (a.copyMode === "percentage" && a.percentage != null) pct = `${(a.percentage * 100).toFixed(0)}%`;
      else if (a.copyMode === "fixed" && a.fixedAmount != null) pct = `$${a.fixedAmount}`;

      const mode = a.copyMode.padEnd(11);
      const cursor = getCursor(a.address);
      let lastActive = "—";
      if (cursor) {
        const ago = Date.now() - cursor.lastActivityAt;
        if (ago < 60_000) lastActive = `${Math.floor(ago / 1000)}s ago`;
        else if (ago < 3600_000) lastActive = `${Math.floor(ago / 60_000)}m ago`;
        else lastActive = `${Math.floor(ago / 3600_000)}h ago`;
      }

      lines.push(boxLine(`  ${num} ${name} ${st} ${pct.padEnd(6)} ${mode} ${lastActive}`));
    }

    while (lines.length < contentH) lines.push(boxLine(""));
    return lines.slice(0, contentH);
  }

  private renderFooter(): string[] {
    const lines: string[] = [];
    lines.push(boxMid());

    if (this.inputMode !== "normal") {
      lines.push(boxLine(chalk.yellow(` ${this.promptText}${this.inputBuf}█`)));
    } else {
      const paused = this.monitor.stats.enabledAddresses === 0 && this.monitor.stats.totalAddresses > 0;
      const spaceLabel = paused ? "Resume" : "Pause";
      lines.push(boxLine(
        chalk.dim(` [q]Quit [1/2]Tab [%]Copy% [L]Limits [Space]${spaceLabel}`)
      ));
    }

    lines.push(boxBot());
    return lines;
  }
}

function timeNow(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}
