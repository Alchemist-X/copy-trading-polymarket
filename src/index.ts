import { Command } from "commander";
import chalk from "chalk";
import { loadEnv, initClient } from "./lib/client.js";
import { setVerbose, setDashboardMode, log } from "./lib/logger.js";
import { TradeMonitor } from "./core/monitor.js";
import { Dashboard } from "./cli/dashboard.js";
import {
  addCommand,
  listCommand,
  editCommand,
  pauseCommand,
  resumeCommand,
  removeCommand,
  historyCommand,
  statusCommand,
  importCommand,
  verifyCommand,
  logsCommand,
} from "./cli/commands.js";

const program = new Command();

program
  .name("copy-trade")
  .description("Polymarket copy trading bot")
  .version("1.0.0");

program
  .command("start")
  .description("Start the copy trading engine")
  .option("--dry-run", "Run without executing real trades", false)
  .option("--concurrency <n>", "Max concurrent API requests", "15")
  .option("--verbose", "Enable verbose logging", false)
  .option("--no-dashboard", "Disable live dashboard")
  .option("--no-auto-redeem", "Disable auto-redeem of resolved markets")
  .action(async (opts) => {
    setVerbose(opts.verbose);
    if (opts.dashboard !== false) setDashboardMode(true);

    console.log(chalk.bold.cyan("\n  Polymarket Copy Trading Engine\n"));
    log("info", "Initializing CLOB client...");

    const env = loadEnv();
    const client = await initClient(env);
    log("info", `Wallet: ${env.eoaAddress}`);
    log("info", `Funder: ${env.funderAddress}`);

    const monitor = new TradeMonitor(client, {
      dryRun: opts.dryRun,
      concurrency: parseInt(opts.concurrency),
      autoRedeem: opts.autoRedeem !== false,
    }, env.privateKey);

    if (opts.dryRun) {
      log("warn", "DRY RUN mode - no real trades will be executed");
    }

    process.on("SIGINT", () => {
      log("info", "Shutting down...");
      monitor.stop();
    });

    process.on("SIGTERM", () => {
      monitor.stop();
    });

    if (opts.dashboard !== false) {
      const dashboard = new Dashboard(monitor, env.funderAddress);
      dashboard.start();
    }

    await monitor.start();
  });

program
  .command("add <address>")
  .description("Add an address or username to follow")
  .action(addCommand);

program
  .command("list")
  .description("List all followed addresses")
  .action(listCommand);

program
  .command("edit <address>")
  .description("Edit follow configuration for an address")
  .action(editCommand);

program
  .command("pause <target>")
  .description("Pause an address or 'all'")
  .action(pauseCommand);

program
  .command("resume <target>")
  .description("Resume an address or 'all'")
  .action(resumeCommand);

program
  .command("remove <address>")
  .description("Remove a followed address")
  .action(removeCommand);

program
  .command("history")
  .description("Show trade execution history")
  .option("-l, --limit <n>", "Number of records", "20")
  .action(historyCommand);

program
  .command("status")
  .description("Show current engine status")
  .action(statusCommand);

program
  .command("import <file>")
  .description("Import addresses from CSV or JSON file")
  .action(importCommand);

program
  .command("verify <address>")
  .description("Check if an address/username is a valid Polymarket trader with trade history")
  .action(verifyCommand);

program
  .command("logs")
  .description("View log files")
  .option("--errors", "Show only error logs")
  .option("--commands", "Show only command logs")
  .option("--date <date>", "Show engine logs for a specific date (YYYY-MM-DD)")
  .action(logsCommand);

program.parse();
