import { Command } from "commander";
import chalk from "chalk";
import { loadEnv, initClient } from "./lib/client.js";
import { setVerbose, setDashboardMode, log } from "./lib/logger.js";
import { TradeMonitor } from "./core/monitor.js";
import { Dashboard } from "./cli/dashboard.js";
import { sendAlert } from "./lib/alerts.js";
import { updateServiceHeartbeat } from "./lib/store.js";
import {
  addCommand,
  alertsTestCommand,
  listCommand,
  editCommand,
  pauseCommand,
  riskResetGlobalCommand,
  riskStatusCommand,
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
    }, env.privateKey, env.funderAddress);

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

    process.on("unhandledRejection", async (reason: any) => {
      const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
      log("error", `Unhandled rejection: ${msg}`);
      updateServiceHeartbeat({
        status: "error",
        lastErrorAt: new Date().toISOString(),
        note: `unhandledRejection: ${msg}`,
      });
      await sendAlert({
        key: "process:unhandled-rejection",
        severity: "critical",
        title: "Unhandled rejection",
        body: msg,
      });
    });

    process.on("uncaughtException", async (err: Error) => {
      const msg = err.stack ?? err.message;
      log("error", `Uncaught exception: ${msg}`);
      updateServiceHeartbeat({
        status: "error",
        lastErrorAt: new Date().toISOString(),
        note: `uncaughtException: ${err.message}`,
      });
      await sendAlert({
        key: "process:uncaught-exception",
        severity: "critical",
        title: "Uncaught exception",
        body: msg,
      });
      process.exit(1);
    });

    if (opts.dashboard !== false) {
      const dashboard = new Dashboard(monitor, env.funderAddress);
      dashboard.start();
    }

    try {
      await monitor.start();
    } catch (err: any) {
      if (err.message === "GLOBAL_RISK_LATCHED") {
        console.error(chalk.red("Global risk latch is active. Run `copy-trade risk reset global` before restarting."));
        process.exit(78);
      }
      throw err;
    }
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

const risk = program
  .command("risk")
  .description("Risk management commands");

risk
  .command("status")
  .description("Show current risk snapshot")
  .action(riskStatusCommand);

risk
  .command("reset <scope>")
  .description("Reset risk latch (currently supports: global)")
  .action(riskResetGlobalCommand);

const alerts = program
  .command("alerts")
  .description("Alert channel commands");

alerts
  .command("test")
  .description("Send a test alert to configured channels")
  .action(alertsTestCommand);

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
