import chalk from "chalk";
import { createInterface } from "readline";
import {
  loadAddresses,
  saveAddresses,
  upsertAddress,
  removeAddress,
  findAddress,
  loadHistory,
} from "../lib/store.js";
import type { FollowedAddress, CopyMode, Priority, SellMode } from "../types/index.js";
import { DEFAULT_FILTERS } from "../types/index.js";

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

export async function addCommand(address: string) {
  if (!isValidAddress(address)) {
    console.log(chalk.red("Invalid Ethereum address format"));
    return;
  }

  const existing = findAddress(address);
  if (existing) {
    console.log(chalk.yellow(`Address already exists as "${existing.nickname ?? address.slice(0, 8)}". Use 'edit' to modify.`));
    return;
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
  console.log(chalk.green(`\n✓ Added ${nickname || address.slice(0, 10)} (${copyMode}, ${priority} priority)`));
}

export function listCommand() {
  const addresses = loadAddresses();
  if (addresses.length === 0) {
    console.log(chalk.yellow("No addresses configured. Use 'add <address>' to get started."));
    return;
  }

  console.log(chalk.bold(`\nFollowed Addresses (${addresses.length}):\n`));

  const header = [
    "Status".padEnd(8),
    "Nickname".padEnd(14),
    "Address".padEnd(14),
    "Mode".padEnd(12),
    "Amount".padEnd(10),
    "Priority".padEnd(8),
    "Counter",
  ].join(" ");

  console.log(chalk.dim(header));
  console.log(chalk.dim("─".repeat(80)));

  for (const a of addresses) {
    const status = a.enabled ? chalk.green("● ON ") : chalk.red("● OFF");
    const nick = (a.nickname ?? "—").padEnd(14).slice(0, 14);
    const addr = (a.address.slice(0, 6) + ".." + a.address.slice(-4)).padEnd(14);
    const mode = a.copyMode.padEnd(12);

    let amount = "";
    if (a.copyMode === "percentage") amount = `${((a.percentage ?? 0) * 100).toFixed(0)}%`;
    else if (a.copyMode === "fixed") amount = `$${a.fixedAmount}`;
    else amount = `${((a.percentage ?? 0) * 100).toFixed(0)}% [$${a.minAmount}-$${a.maxAmount}]`;
    amount = amount.padEnd(10);

    const prio = a.priority.padEnd(8);
    const counter = a.counterMode ? chalk.yellow("YES") : chalk.dim("no");

    console.log(`  ${status}  ${nick} ${addr} ${mode} ${amount} ${prio} ${counter}`);
  }

  console.log();
}

export async function editCommand(address: string) {
  const entry = findAddress(address);
  if (!entry) {
    console.log(chalk.red(`Address not found: ${address}`));
    return;
  }

  console.log(chalk.bold(`\nEditing: ${entry.nickname ?? entry.address}`));
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
  console.log(chalk.green(`\n✓ Updated ${entry.nickname ?? entry.address.slice(0, 10)}`));
}

export function pauseCommand(target: string) {
  if (target === "all") {
    const all = loadAddresses();
    let count = 0;
    for (const a of all) {
      if (a.enabled) { a.enabled = false; count++; }
    }
    saveAddresses(all);
    console.log(chalk.yellow(`Paused ${count} address(es)`));
    return;
  }

  const entry = findAddress(target);
  if (!entry) {
    console.log(chalk.red(`Address not found: ${target}`));
    return;
  }
  entry.enabled = false;
  upsertAddress(entry);
  console.log(chalk.yellow(`Paused ${entry.nickname ?? entry.address.slice(0, 10)}`));
}

export function resumeCommand(target: string) {
  if (target === "all") {
    const all = loadAddresses();
    let count = 0;
    for (const a of all) {
      if (!a.enabled) { a.enabled = true; count++; }
    }
    saveAddresses(all);
    console.log(chalk.green(`Resumed ${count} address(es)`));
    return;
  }

  const entry = findAddress(target);
  if (!entry) {
    console.log(chalk.red(`Address not found: ${target}`));
    return;
  }
  entry.enabled = true;
  upsertAddress(entry);
  console.log(chalk.green(`Resumed ${entry.nickname ?? entry.address.slice(0, 10)}`));
}

export function removeCommand(target: string) {
  if (removeAddress(target)) {
    console.log(chalk.green(`Removed ${target.slice(0, 10)}...`));
  } else {
    console.log(chalk.red(`Address not found: ${target}`));
  }
}

export function historyCommand(options: { limit?: string }) {
  const limit = parseInt(options.limit ?? "20") || 20;
  const history = loadHistory().slice(-limit).reverse();

  if (history.length === 0) {
    console.log(chalk.yellow("No trade history yet."));
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
    const reason = exec.reason ? chalk.dim(` (${exec.reason})`) : "";

    console.log(`  ${statusIcon} ${chalk.dim(time)} ${sideCol} $${amount.padEnd(8)} ${chalk.dim(addr)} ${market}${reason}`);
  }
  console.log();
}

export function statusCommand() {
  const addresses = loadAddresses();
  const history = loadHistory();
  const recent = history.slice(-100);

  const success = recent.filter((e) => e.status === "success").length;
  const failed = recent.filter((e) => e.status === "failed").length;
  const skipped = recent.filter((e) => e.status === "skipped").length;

  console.log(chalk.bold("\nCopy Trading Status\n"));
  console.log(`  Followed addresses: ${chalk.white(String(addresses.length))}`);
  console.log(`  Active:            ${chalk.green(String(addresses.filter((a) => a.enabled).length))}`);
  console.log(`  Paused:            ${chalk.yellow(String(addresses.filter((a) => !a.enabled).length))}`);
  console.log(`  Total executions:  ${chalk.white(String(history.length))}`);
  console.log(`  Last 100: ${chalk.green(String(success))} success, ${chalk.red(String(failed))} failed, ${chalk.gray(String(skipped))} skipped`);

  if (history.length > 0) {
    const last = history[history.length - 1];
    console.log(`  Last execution:    ${chalk.dim(last.timestamp)}`);
  }
  console.log();
}

export async function importCommand(file: string) {
  const { readFileSync, existsSync } = await import("fs");

  if (!existsSync(file)) {
    console.log(chalk.red(`File not found: ${file}`));
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
}
