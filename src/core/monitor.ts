import type { ClobClient } from "@polymarket/clob-client";
import type { FollowedAddress, MonitorConfig, ActivityItem } from "../types/index.js";
import { DEFAULT_MONITOR_CONFIG } from "../types/index.js";
import { loadAddresses, isSeen, markSeen, updateCursor, getCursor } from "../lib/store.js";
import { fetchActivity, fetchMarketByCondition } from "../lib/polymarket-api.js";
import { log } from "../lib/logger.js";
import { calculateCopy, calculateSellCopy } from "./copy-logic.js";
import { applyFilters } from "./filters.js";
import { executeCopyTrade } from "./executor.js";
import pLimit from "p-limit";

export interface MonitorStats {
  totalAddresses: number;
  enabledAddresses: number;
  pausedAddresses: number;
  cycleCount: number;
  lastCycleMs: number;
  tradesDetected: number;
  tradesExecuted: number;
  tradesSkipped: number;
  tradesFailed: number;
  running: boolean;
}

export class TradeMonitor {
  private client: ClobClient;
  private config: MonitorConfig;
  private abortController: AbortController | null = null;
  private _stats: MonitorStats = {
    totalAddresses: 0,
    enabledAddresses: 0,
    pausedAddresses: 0,
    cycleCount: 0,
    lastCycleMs: 0,
    tradesDetected: 0,
    tradesExecuted: 0,
    tradesSkipped: 0,
    tradesFailed: 0,
    running: false,
  };

  get stats(): Readonly<MonitorStats> {
    return this._stats;
  }

  constructor(client: ClobClient, config?: Partial<MonitorConfig>) {
    this.client = client;
    this.config = { ...DEFAULT_MONITOR_CONFIG, ...config };
  }

  async start(): Promise<void> {
    if (this._stats.running) {
      log("warn", "Monitor is already running");
      return;
    }

    this.abortController = new AbortController();
    this._stats.running = true;
    log("info", `Monitor started (concurrency=${this.config.concurrency}, dryRun=${this.config.dryRun})`);

    while (!this.abortController.signal.aborted) {
      try {
        await this.runCycle();
      } catch (err: any) {
        log("error", `Cycle error: ${err.message}`);
      }
      await this.sleep(1000);
    }

    this._stats.running = false;
    log("info", "Monitor stopped");
  }

  stop() {
    this.abortController?.abort();
  }

  private async runCycle(): Promise<void> {
    const t0 = Date.now();
    const addresses = loadAddresses();

    this._stats.totalAddresses = addresses.length;
    this._stats.enabledAddresses = addresses.filter((a) => a.enabled).length;
    this._stats.pausedAddresses = addresses.filter((a) => !a.enabled).length;

    const enabled = addresses.filter((a) => a.enabled);
    if (enabled.length === 0) {
      await this.sleep(5000);
      return;
    }

    const now = Date.now();
    const due = enabled.filter((addr) => {
      const cursor = getCursor(addr.address);
      if (!cursor) return true;
      const interval = this.getInterval(addr.priority);
      return now - cursor.lastActivityAt >= interval;
    });

    if (due.length === 0) {
      return;
    }

    const limit = pLimit(this.config.concurrency);
    const tasks = due.map((addr) =>
      limit(() => this.pollAddress(addr)),
    );

    await Promise.allSettled(tasks);

    this._stats.cycleCount++;
    this._stats.lastCycleMs = Date.now() - t0;
  }

  private async pollAddress(addr: FollowedAddress): Promise<void> {
    if (this.abortController?.signal.aborted) return;

    const cursor = getCursor(addr.address);
    const startTs = cursor?.lastSeenTimestamp;

    let activities: ActivityItem[];
    try {
      activities = await fetchActivity(addr.address, startTs);
    } catch (err: any) {
      if (err.message === "RATE_LIMITED") {
        log("warn", `Rate limited polling ${addr.nickname ?? addr.address.slice(0, 10)}...`);
        await this.sleep(5000);
      }
      return;
    }

    if (activities.length === 0) {
      updateCursor(addr.address, startTs ?? Date.now());
      return;
    }

    let maxTs = startTs ?? 0;

    for (const activity of activities) {
      if (this.abortController?.signal.aborted) break;

      if (activity.timestamp > maxTs) maxTs = activity.timestamp;

      if (!activity.transactionHash || isSeen(activity.transactionHash)) continue;
      markSeen(activity.transactionHash);

      this._stats.tradesDetected++;

      const side = (activity.side ?? "").toUpperCase();
      const isSell = side === "SELL";

      let market = null;
      if (activity.conditionId) {
        market = await fetchMarketByCondition(activity.conditionId);
      }

      const filterResult = applyFilters(addr, activity, market);
      if (!filterResult.pass) {
        this._stats.tradesSkipped++;
        log("skip",
          `[${addr.nickname ?? addr.address.slice(0, 8)}] ${filterResult.reason} ` +
          `(${activity.question ?? activity.asset.slice(0, 12)}...)`,
        );
        continue;
      }

      let copy;
      if (isSell) {
        copy = calculateSellCopy(addr, activity, 0);
      } else {
        copy = calculateCopy(addr, activity);
      }

      if (!copy) {
        this._stats.tradesSkipped++;
        log("skip", `[${addr.nickname ?? addr.address.slice(0, 8)}] amount too small to copy`);
        continue;
      }

      const exec = await executeCopyTrade(
        this.client,
        copy,
        activity,
        addr.address,
        this.config,
      );

      if (exec.status === "success") {
        this._stats.tradesExecuted++;
      } else if (exec.status === "failed") {
        this._stats.tradesFailed++;
      } else {
        this._stats.tradesSkipped++;
      }
    }

    updateCursor(addr.address, maxTs);
  }

  private getInterval(priority: string): number {
    switch (priority) {
      case "fast": return this.config.fastIntervalMs;
      case "slow": return this.config.slowIntervalMs;
      default: return this.config.normalIntervalMs;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      this.abortController?.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
