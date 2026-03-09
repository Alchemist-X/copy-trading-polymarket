import chalk from "chalk";
import ora from "ora";
import { createInterface } from "readline";
import { readFileSync, existsSync } from "fs";
import {
  clearGlobalRiskLatch,
  loadAddresses,
  saveAddresses,
  upsertAddress,
  removeAddress,
  findAddress,
  getGlobalRiskState,
  getServiceHeartbeat,
  loadHistory,
  listSourceRiskStatuses,
} from "../lib/store.js";
import { verifyAddress, searchProfiles } from "../lib/polymarket-api.js";
import { logCommand, getLogPath } from "../lib/logger.js";
import { testAlerts } from "../lib/alerts.js";
import { getConfig } from "../lib/config.js";
import type { FollowedAddress, CopyMode, Priority, SellMode } from "../types/index.js";
import { DEFAULT_FILTERS, DEFAULT_MONITOR_CONFIG } from "../types/index.js";
import { RiskManager } from "../core/risk-manager.js";

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function isValidAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

async function resolveToAddress(input: string): Promise<{ address: string; username?: string } | null> {
  if (isValidAddress(input)) {
    return { address: input };
  }

  const spinner = ora(`Searching for username "${input}"...`).start();
  const results = await searchProfiles(input);
  spinner.stop();

  if (results.length === 0) {
    console.log(chalk.red(`No Polymarket user found for "${input}"`));
    return null;
  }

  const exact = results.find((r) => r.username.toLowerCase() === input.toLowerCase());
  if (exact) {
    console.log(chalk.green(`Resolved "${input}" → ${exact.address.slice(0, 10)}...`));
    return { address: exact.address, username: exact.username };
  }

  if (results.length === 1) {
    const r = results[0];
    console.log(chalk.green(`Resolved "${input}" → ${r.username} (${r.address.slice(0, 10)}...)`));
    return { address: r.address, username: r.username };
  }

  console.log(chalk.bold(`\nMultiple profiles found for "${input}":\n`));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    console.log(`  ${i + 1}) ${r.username} ${chalk.dim(`(${r.address.slice(0, 10)}...)`)}`);
  }
  const choice = await prompt(chalk.cyan(`Select [1-${results.length}]: `));
  const idx = parseInt(choice) - 1;
  if (idx < 0 || idx >= results.length) {
    console.log(chalk.red("Invalid selection."));
    return null;
  }
  const selected = results[idx];
  return { address: selected.address, username: selected.username };
}

export async function verifyCommand(input: string) {
  const resolved = await resolveToAddress(input);
  if (!resolved) {
    logCommand("verify", [input], "error", undefined, "address not resolved");
    return;
  }

  const spinner = ora(`Verifying ${resolved.address.slice(0, 10)}...`).start();
  const profile = await verifyAddress(resolved.address);
  spinner.stop();

  printProfile(resolved.address, profile, resolved.username);
  logCommand("verify", [input], "ok", {
    address: resolved.address,
    username: resolved.username,
    valid: profile.valid,
    trades: profile.tradeCount,
  });
}

function printProfile(address: string, profile: Awaited<ReturnType<typeof verifyAddress>>, username?: string) {
  const label = username ? `${username} (${address})` : address;
  console.log(chalk.bold(`\n  Address Verification: ${label}\n`));

  if (!profile.valid) {
    console.log(chalk.red("  ✗ Invalid address format\n"));
    return;
  }

  if (!profile.hasActivity) {
    console.log(chalk.yellow("  ⚠ No trade activity found on Polymarket"));
    console.log(chalk.dim("    This address has never traded, or uses a different proxy wallet.\n"));
    return;
  }

  console.log(chalk.green("  ✓ Valid Polymarket trader\n"));
  console.log(`  Trades found:    ${chalk.white(String(profile.tradeCount))} (last 100)`);
  console.log(`  First trade:     ${chalk.dim(profile.firstTradeAt ?? "—")}`);
  console.log(`  Last trade:      ${chalk.dim(profile.lastTradeAt ?? "—")}`);
  console.log(`  Open positions:  ${chalk.white(String(profile.positionCount))}`);

  if (profile.positions.length > 0) {
    console.log(chalk.bold("\n  Current Positions:"));
    for (const p of profile.positions.slice(0, 8)) {
      const size = `$${p.size.toFixed(2)}`.padEnd(10);
      const title = p.title.slice(0, 45);
      console.log(`    ${size} ${chalk.dim(p.outcome.padEnd(5))} ${title}`);
    }
    if (profile.positionCount > 8) {
      console.log(chalk.dim(`    ... and ${profile.positionCount - 8} more`));
    }
  }

  if (profile.recentTrades.length > 0) {
    console.log(chalk.bold("\n  Recent Trades:"));
    for (const t of profile.recentTrades.slice(0, 8)) {
      const side = t.side === "BUY" ? chalk.green("BUY ") : chalk.red("SELL");
      const amt = `$${parseFloat(t.amount || "0").toFixed(2)}`.padEnd(10);
      const q = t.question.slice(0, 38);
      console.log(`    ${chalk.dim(t.time)} ${side} ${amt} ${q}`);
    }
    if (profile.recentTrades.length > 8) {
      console.log(chalk.dim(`    ... and ${profile.recentTrades.length - 8} more`));
    }
  }

  console.log();
}

function fmtAgo(iso?: string): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.max(0, Math.floor(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export async function addCommand(input: string) {
  const resolved = await resolveToAddress(input);
  if (!resolved) {
    logCommand("add", [input], "error", undefined, "address not resolved");
    return;
  }
  const { address, username } = resolved;

  const existing = findAddress(address);
  if (existing) {
    console.log(chalk.yellow(`Address already exists as "${existing.nickname ?? existing.username ?? address.slice(0, 8)}". Use 'edit' to modify.`));
    logCommand("add", [input], "error", { address }, "already exists");
    return;
  }

  const spinner = ora("Checking address on Polymarket...").start();
  const profile = await verifyAddress(address);
  spinner.stop();

  printProfile(address, profile, username);

  if (!profile.hasActivity) {
    const proceed = await prompt(chalk.yellow("No trade history found. Add anyway? [y/N]: "));
    if (proceed.toLowerCase() !== "y") {
      console.log(chalk.dim("Cancelled."));
      logCommand("add", [input], "error", { address }, "cancelled by user");
      return;
    }
  }

  const nickname = await prompt(chalk.cyan("Nickname (optional): "));

  console.log(chalk.bold("\nCopy Mode:"));
  console.log("  1) percentage - Copy X% of their trade amount");
  console.log("  2) fixed      - Always copy with fixed $amount");
  console.log("  3) range      - Percentage with min/max bounds");
  const modeChoice = await prompt(chalk.cyan("Select mode [1/2/3]: "));

  let copyMode: CopyMode = "percentage";
  let percentage: number | undefined;
  let fixedAmount: number | undefined;
  let minAmount: number | undefined;
  let maxAmount: number | undefined;

  switch (modeChoice) {
    case "2":
      copyMode = "fixed";
      fixedAmount = parseFloat(await prompt(chalk.cyan("Fixed amount ($): "))) || 5;
      break;
    case "3":
      copyMode = "range";
      percentage = parseFloat(await prompt(chalk.cyan("Percentage (e.g. 0.1 for 10%): "))) || 0.1;
      minAmount = parseFloat(await prompt(chalk.cyan("Min amount ($): "))) || 1;
      maxAmount = parseFloat(await prompt(chalk.cyan("Max amount ($): "))) || 100;
      break;
    default:
      copyMode = "percentage";
      percentage = parseFloat(await prompt(chalk.cyan("Percentage (e.g. 0.1 for 10%): "))) || 0.1;
  }

  const counterInput = await prompt(chalk.cyan("Counter mode? (bet against) [y/N]: "));
  const counterMode = counterInput.toLowerCase() === "y";

  console.log(chalk.bold("\nPriority (polling frequency):"));
  console.log("  1) fast   - 10s interval");
  console.log("  2) normal - 30s interval (default)");
  console.log("  3) slow   - 60s interval");
  const prioChoice = await prompt(chalk.cyan("Select [1/2/3]: "));
  const priority: Priority = prioChoice === "1" ? "fast" : prioChoice === "3" ? "slow" : "normal";

  console.log(chalk.bold("\nAdvanced Filters (press Enter to skip):"));
  const minTrigger = parseFloat(await prompt(chalk.cyan("Min trigger amount ($): "))) || undefined;
  const maxOdds = parseFloat(await prompt(chalk.cyan("Max odds (e.g. 0.8): "))) || undefined;
  const maxPerMarket = parseFloat(await prompt(chalk.cyan("Max per market ($): "))) || undefined;
  const maxDaysOut = parseInt(await prompt(chalk.cyan("Max days out: "))) || undefined;

  console.log(chalk.bold("\nSell Mode:"));
  console.log("  1) same_pct    - Sell same % as trader (default)");
  console.log("  2) fixed       - Sell fixed amount");
  console.log("  3) custom_pct  - Sell custom % of your position");
  console.log("  4) ignore      - Don't copy sells");
  const sellChoice = await prompt(chalk.cyan("Select [1/2/3/4]: "));

  let sellMode: SellMode = "same_pct";
  let sellAmount: number | undefined;
  switch (sellChoice) {
    case "2":
      sellMode = "fixed";
      sellAmount = parseFloat(await prompt(chalk.cyan("Sell amount ($): "))) || 5;
      break;
    case "3":
      sellMode = "custom_pct";
      sellAmount = parseFloat(await prompt(chalk.cyan("Sell percentage (e.g. 0.25): "))) || 0.25;
      break;
    case "4":
      sellMode = "ignore";
      break;
    default:
      sellMode = "same_pct";
  }

  const entry: FollowedAddress = {
    address,
    username: username || undefined,
    nickname: nickname || undefined,
    enabled: true,
    copyMode,
    counterMode,
    percentage,
    fixedAmount,
    minAmount,
    maxAmount,
    filters: {
      ...DEFAULT_FILTERS,
      minTrigger,
      maxOdds,
      maxPerMarket,
      maxDaysOut,
      sellMode,
      sellAmount,
    },
    priority,
    addedAt: new Date().toISOString(),
  };

  upsertAddress(entry);
  const displayName = nickname || username || address.slice(0, 10);
  console.log(chalk.green(`\n✓ Added ${displayName} (${copyMode}, ${priority} priority)`));
  logCommand("add", [input], "ok", { address, username, nickname: nickname || undefined, mode: copyMode, priority });
}

export function listCommand() {
  const addresses = loadAddresses();
  if (addresses.length === 0) {
    console.log(chalk.yellow("No addresses configured. Use 'add <address>' to get started."));
    logCommand("list", [], "ok", { count: 0 });
    return;
  }

  console.log(chalk.bold(`\nFollowed Addresses (${addresses.length}):\n`));

  const header = [
    "Status".padEnd(8),
    "Name".padEnd(18),
    "Address".padEnd(14),
    "Mode".padEnd(12),
    "Amount".padEnd(10),
    "Priority".padEnd(8),
    "Counter",
  ].join(" ");

  console.log(chalk.dim(header));
  console.log(chalk.dim("─".repeat(90)));

  for (const a of addresses) {
    const status = a.enabled ? chalk.green("● ON ") : chalk.red("● OFF");
    const name = (a.username ?? a.nickname ?? "—").slice(0, 18).padEnd(18);
    const addr = (a.address.slice(0, 6) + ".." + a.address.slice(-4)).padEnd(14);
    const mode = a.copyMode.padEnd(12);

    let amount = "";
    if (a.copyMode === "percentage") amount = `${((a.percentage ?? 0) * 100).toFixed(0)}%`;
    else if (a.copyMode === "fixed") amount = `$${a.fixedAmount}`;
    else amount = `${((a.percentage ?? 0) * 100).toFixed(0)}% [$${a.minAmount}-$${a.maxAmount}]`;
    amount = amount.padEnd(10);

    const prio = a.priority.padEnd(8);
    const counter = a.counterMode ? chalk.yellow("YES") : chalk.dim("no");

    console.log(`  ${status}  ${name} ${addr} ${mode} ${amount} ${prio} ${counter}`);
  }

  console.log();
  logCommand("list", [], "ok", { count: addresses.length });
}

export async function editCommand(input: string) {
  let entry = findAddress(input);
  if (!entry && !isValidAddress(input)) {
    const resolved = await resolveToAddress(input);
    if (resolved) entry = findAddress(resolved.address);
  }
  if (!entry) {
    console.log(chalk.red(`Address not found: ${input}`));
    logCommand("edit", [input], "error", undefined, "not found");
    return;
  }

  console.log(chalk.bold(`\nEditing: ${entry.username ?? entry.nickname ?? entry.address}`));
  console.log(chalk.dim("Press Enter to keep current value\n"));

  const nick = await prompt(`Nickname [${entry.nickname ?? "—"}]: `);
  if (nick) entry.nickname = nick;

  console.log(`\nCopy Mode [${entry.copyMode}]:`);
  console.log("  1) percentage  2) fixed  3) range  Enter) keep");
  const modeChoice = await prompt("Select: ");
  if (modeChoice === "1") {
    entry.copyMode = "percentage";
    entry.percentage = parseFloat(await prompt(`Percentage [${entry.percentage}]: `)) || entry.percentage;
  } else if (modeChoice === "2") {
    entry.copyMode = "fixed";
    entry.fixedAmount = parseFloat(await prompt(`Fixed amount [${entry.fixedAmount}]: `)) || entry.fixedAmount;
  } else if (modeChoice === "3") {
    entry.copyMode = "range";
    entry.percentage = parseFloat(await prompt(`Percentage [${entry.percentage}]: `)) || entry.percentage;
    entry.minAmount = parseFloat(await prompt(`Min [${entry.minAmount}]: `)) || entry.minAmount;
    entry.maxAmount = parseFloat(await prompt(`Max [${entry.maxAmount}]: `)) || entry.maxAmount;
  }

  const counterInput = await prompt(`Counter mode [${entry.counterMode ? "y" : "n"}]: `);
  if (counterInput) entry.counterMode = counterInput.toLowerCase() === "y";

  console.log(`\nPriority [${entry.priority}]:`);
  console.log("  1) fast  2) normal  3) slow  Enter) keep");
  const prioChoice = await prompt("Select: ");
  if (prioChoice === "1") entry.priority = "fast";
  else if (prioChoice === "2") entry.priority = "normal";
  else if (prioChoice === "3") entry.priority = "slow";

  upsertAddress(entry);
  console.log(chalk.green(`\n✓ Updated ${entry.nickname ?? entry.username ?? entry.address.slice(0, 10)}`));
  logCommand("edit", [input], "ok", { address: entry.address, mode: entry.copyMode, priority: entry.priority });
}

export function pauseCommand(target: string) {
  if (target === "all") {
    const all = loadAddresses();
    let count = 0;
    for (const a of all) {
      if (a.enabled) {
        a.enabled = false;
        a.pauseReason = "manual";
        count++;
      }
    }
    saveAddresses(all);
    console.log(chalk.yellow(`Paused ${count} address(es)`));
    logCommand("pause", [target], "ok", { count });
    return;
  }

  const entry = findAddress(target);
  if (!entry) {
    console.log(chalk.red(`Address not found: ${target}`));
    logCommand("pause", [target], "error", undefined, "not found");
    return;
  }
  entry.enabled = false;
  entry.pauseReason = "manual";
  upsertAddress(entry);
  console.log(chalk.yellow(`Paused ${entry.nickname ?? entry.username ?? entry.address.slice(0, 10)}`));
  logCommand("pause", [target], "ok", { address: entry.address });
}

export function resumeCommand(target: string) {
  if (target === "all") {
    const all = loadAddresses();
    let count = 0;
    for (const a of all) {
      if (!a.enabled) {
        a.enabled = true;
        a.pauseReason = undefined;
        a.riskPausedAt = undefined;
        a.riskNote = undefined;
        count++;
      }
    }
    saveAddresses(all);
    console.log(chalk.green(`Resumed ${count} address(es)`));
    logCommand("resume", [target], "ok", { count });
    return;
  }

  const entry = findAddress(target);
  if (!entry) {
    console.log(chalk.red(`Address not found: ${target}`));
    logCommand("resume", [target], "error", undefined, "not found");
    return;
  }
  entry.enabled = true;
  entry.pauseReason = undefined;
  entry.riskPausedAt = undefined;
  entry.riskNote = undefined;
  upsertAddress(entry);
  console.log(chalk.green(`Resumed ${entry.nickname ?? entry.username ?? entry.address.slice(0, 10)}`));
  logCommand("resume", [target], "ok", { address: entry.address });
}

export function removeCommand(target: string) {
  if (removeAddress(target)) {
    console.log(chalk.green(`Removed ${target.slice(0, 10)}...`));
    logCommand("remove", [target], "ok");
  } else {
    console.log(chalk.red(`Address not found: ${target}`));
    logCommand("remove", [target], "error", undefined, "not found");
  }
}

export function historyCommand(options: { limit?: string }) {
  const limit = parseInt(options.limit ?? "20") || 20;
  const history = loadHistory().slice(-limit).reverse();

  if (history.length === 0) {
    console.log(chalk.yellow("No trade history yet."));
    logCommand("history", [], "ok", { count: 0 });
    return;
  }

  console.log(chalk.bold(`\nRecent Executions (last ${limit}):\n`));

  for (const exec of history) {
    const time = exec.timestamp.slice(0, 19).replace("T", " ");
    const addr = exec.sourceAddress.slice(0, 8) + "..";
    const side = exec.executedTrade?.side ?? exec.sourceTrade.side;

    const statusIcon = exec.status === "success"
      ? chalk.green("✓")
      : exec.status === "skipped"
        ? chalk.gray("○")
        : chalk.red("✗");

    const sideCol = side === "BUY" ? chalk.green(side) : chalk.red(side);
    const amount = (exec.executedTrade?.amount ?? exec.sourceTrade.amount).toFixed(2);
    const market = (exec.market?.question ?? exec.sourceTrade.tokenId).slice(0, 35);

    let detail = "";
    if (exec.failureCode) {
      detail = chalk.dim(` [${exec.failureCode}]`);
    } else if (exec.reason) {
      detail = chalk.dim(` (${exec.reason})`);
    }

    console.log(`  ${statusIcon} ${chalk.dim(time)} ${sideCol} $${amount.padEnd(8)} ${chalk.dim(addr)} ${market}${detail}`);
  }
  console.log();
  logCommand("history", [`--limit=${limit}`], "ok", { shown: history.length });
}

export function statusCommand() {
  const addresses = loadAddresses();
  const history = loadHistory();
  const recent = history.slice(-100);
  const heartbeat = getServiceHeartbeat();
  const globalRisk = getGlobalRiskState();
  const sourceRisks = listSourceRiskStatuses().filter((risk) => risk.riskPaused || risk.lossPct > 0);

  const success = recent.filter((e) => e.status === "success").length;
  const failed = recent.filter((e) => e.status === "failed").length;
  const skipped = recent.filter((e) => e.status === "skipped").length;

  console.log(chalk.bold("\nCopy Trading Status\n"));
  console.log(`  Followed addresses: ${chalk.white(String(addresses.length))}`);
  console.log(`  Active:            ${chalk.green(String(addresses.filter((a) => a.enabled).length))}`);
  console.log(`  Paused:            ${chalk.yellow(String(addresses.filter((a) => !a.enabled).length))}`);
  console.log(`  Service status:    ${heartbeat.status}`);
  console.log(`  Last cycle:        ${chalk.dim(fmtAgo(heartbeat.lastCycleAt))}`);
  console.log(`  Last good poll:    ${chalk.dim(fmtAgo(heartbeat.lastSuccessfulPollAt))}`);
  console.log(`  Total executions:  ${chalk.white(String(history.length))}`);
  console.log(`  Last 100: ${chalk.green(String(success))} success, ${chalk.red(String(failed))} failed, ${chalk.gray(String(skipped))} skipped`);
  console.log(`  Global risk stop:  ${globalRisk.latched ? chalk.red("LATCHED") : chalk.green("clear")}`);
  console.log(`  Source risk hits:  ${chalk.white(String(sourceRisks.filter((risk) => risk.riskPaused).length))}`);

  if (history.length > 0) {
    const last = history[history.length - 1];
    console.log(`  Last execution:    ${chalk.dim(last.timestamp)}`);
  }
  if (heartbeat.lastErrorAt) {
    console.log(`  Last error:        ${chalk.dim(fmtAgo(heartbeat.lastErrorAt))} ${heartbeat.note ? chalk.dim(`(${heartbeat.note})`) : ""}`);
  }
  console.log();
  logCommand("status", [], "ok", { total: addresses.length, executions: history.length });
}

export async function riskStatusCommand() {
  const cfg = getConfig();
  if (!cfg.funderAddress) {
    console.log(chalk.red("Missing FUNDER_ADDRESS in .env"));
    logCommand("risk status", [], "error", undefined, "missing funder address");
    return;
  }
  const manager = new RiskManager(DEFAULT_MONITOR_CONFIG, cfg.funderAddress);
  const snapshot = await manager.snapshot();

  console.log(chalk.bold("\nRisk Status\n"));
  console.log(`  USDC balance:      ${chalk.white(`$${snapshot.usdcBalance.toFixed(2)}`)}`);
  console.log(`  Global baseline:   ${chalk.white(`$${snapshot.global.baselineEquityUsdc.toFixed(2)}`)}`);
  console.log(`  Current equity:    ${chalk.white(`$${snapshot.global.currentEquityUsdc.toFixed(2)}`)}`);
  console.log(`  Global loss:       ${snapshot.global.lossPct >= cfg.riskGlobalStopPct ? chalk.red(`${(snapshot.global.lossPct * 100).toFixed(2)}%`) : chalk.yellow(`${(snapshot.global.lossPct * 100).toFixed(2)}%`)}`);
  console.log(`  Global stop:       ${snapshot.global.latched ? chalk.red("LATCHED") : chalk.green("clear")}`);

  if (snapshot.sources.length === 0) {
    console.log(chalk.dim("\n  No tracked source positions yet.\n"));
    logCommand("risk status", [], "ok", { sources: 0, globalLossPct: snapshot.global.lossPct });
    return;
  }

  console.log(chalk.bold("\n  Source Risk\n"));
  for (const source of snapshot.sources.slice(0, 20)) {
    const lossText = `${(source.lossPct * 100).toFixed(2)}%`;
    const styledLoss = source.lossPct >= cfg.riskSourceStopPct ? chalk.red(lossText) : chalk.yellow(lossText);
    const state = source.riskPaused ? chalk.red("paused") : chalk.green("active");
    console.log(
      `  ${source.sourceAddress.slice(0, 10)}..  basis $${source.baselineCostUsdc.toFixed(2)}  value $${source.currentValueUsdc.toFixed(2)}  pnl $${source.totalPnlUsdc.toFixed(2)}  loss ${styledLoss}  ${state}`
    );
  }
  console.log();
  logCommand("risk status", [], "ok", {
    sources: snapshot.sources.length,
    globalLossPct: snapshot.global.lossPct,
    latched: snapshot.global.latched,
  });
}

export function riskResetGlobalCommand(scope: string) {
  if (scope !== "global") {
    console.log(chalk.red("Only 'global' reset is supported."));
    logCommand("risk reset", [scope], "error", undefined, "unsupported scope");
    return;
  }
  clearGlobalRiskLatch();
  console.log(chalk.green("Global risk latch cleared."));
  logCommand("risk reset", [scope], "ok");
}

export async function alertsTestCommand() {
  const results = await testAlerts();
  console.log(chalk.bold("\nAlert Test\n"));
  for (const result of results) {
    const status = result.status === "sent"
      ? chalk.green(result.status)
      : result.status === "failed"
        ? chalk.red(result.status)
        : chalk.yellow(result.status);
    console.log(`  ${result.channel.padEnd(8)} ${status}${"error" in result && result.error ? ` ${chalk.dim(result.error)}` : ""}`);
  }
  console.log();
  logCommand("alerts test", [], "ok", { results });
}

export async function importCommand(file: string) {
  if (!existsSync(file)) {
    console.log(chalk.red(`File not found: ${file}`));
    logCommand("import", [file], "error", undefined, "file not found");
    return;
  }

  const content = readFileSync(file, "utf-8").trim();
  let entries: Array<{ address: string; nickname?: string }> = [];

  if (file.endsWith(".json")) {
    const parsed = JSON.parse(content);
    entries = Array.isArray(parsed) ? parsed : parsed.addresses ?? [];
  } else {
    const lines = content.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      const parts = line.split(",").map((p) => p.trim());
      const addr = parts[0];
      if (isValidAddress(addr)) {
        entries.push({ address: addr, nickname: parts[1] || undefined });
      }
    }
  }

  if (entries.length === 0) {
    console.log(chalk.yellow("No valid addresses found in file."));
    logCommand("import", [file], "error", undefined, "no valid addresses");
    return;
  }

  console.log(chalk.bold(`\nImporting ${entries.length} addresses...`));
  console.log(chalk.dim("Using defaults: percentage 10%, normal priority, no filters\n"));

  let added = 0;
  let skipped = 0;

  for (const { address, nickname } of entries) {
    if (!isValidAddress(address)) { skipped++; continue; }
    if (findAddress(address)) { skipped++; continue; }

    const entry: FollowedAddress = {
      address,
      nickname,
      enabled: true,
      copyMode: "percentage",
      counterMode: false,
      percentage: 0.1,
      filters: { ...DEFAULT_FILTERS },
      priority: "normal",
      addedAt: new Date().toISOString(),
    };

    upsertAddress(entry);
    added++;
  }

  console.log(chalk.green(`✓ Imported ${added} addresses (${skipped} skipped/duplicates)`));
  logCommand("import", [file], "ok", { added, skipped });
}

export function logsCommand(options: { errors?: boolean; commands?: boolean; date?: string }) {
  let logPath: string;
  let label: string;

  if (options.commands) {
    logPath = getLogPath("commands");
    label = "Command Logs";
  } else if (options.errors) {
    logPath = getLogPath("errors");
    label = "Error Logs";
  } else {
    logPath = getLogPath("engine", options.date);
    label = `Engine Logs (${options.date ?? new Date().toISOString().slice(0, 10)})`;
  }

  if (!existsSync(logPath)) {
    console.log(chalk.yellow(`No log file found: ${logPath}`));
    return;
  }

  const content = readFileSync(logPath, "utf-8").trim();
  if (!content) {
    console.log(chalk.yellow("Log file is empty."));
    return;
  }

  console.log(chalk.bold(`\n  ${label}\n`));

  const lines = content.split("\n").slice(-50);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const ts = chalk.dim((entry.ts ?? "").slice(11, 23));
      const level = entry.level ?? entry.cmd ?? "?";

      const levelStyle: Record<string, (s: string) => string> = {
        trade: chalk.green,
        error: chalk.red,
        warn: chalk.yellow,
        skip: chalk.gray,
        info: chalk.blue,
      };
      const style = levelStyle[level] ?? chalk.white;
      const levelStr = style(`[${(level as string).toUpperCase().padEnd(5)}]`);

      const msg = entry.msg ?? `${entry.cmd} ${(entry.args ?? []).join(" ")}`;
      console.log(`  ${ts} ${levelStr} ${msg}`);
    } catch {
      console.log(chalk.dim(`  ${line}`));
    }
  }
  console.log();
}
