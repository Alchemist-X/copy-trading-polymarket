import pLimit from "p-limit";
import type { ClobClient } from "@polymarket/clob-client";
import type { ActivityItem, FailureCode, FollowedAddress, MonitorConfig, TradeExecution } from "../types/index.js";
import { DEFAULT_MONITOR_CONFIG } from "../types/index.js";
import {
  appendExecution,
  getCursor,
  getGlobalRiskState,
  getSourcePosition,
  isSeen,
  loadAddresses,
  loadState,
  markSeen,
  saveAddresses,
  updateCursor,
  updateServiceHeartbeat,
} from "../lib/store.js";
import { fetchActivity, fetchMarketByCondition } from "../lib/polymarket-api.js";
import { log } from "../lib/logger.js";
import { sendAlert } from "../lib/alerts.js";
import { calculateCopy, calculateSellCopy } from "./copy-logic.js";
import { executeCopyTrade } from "./executor.js";
import { applyFilters } from "./filters.js";
import { AutoRedeemer } from "./redeemer.js";
import type { RedeemEvent } from "./redeemer.js";
import { RiskManager } from "./risk-manager.js";

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

export type DashboardEvent =
  | { type: "detect"; exec: TradeExecution }
  | { type: "copy"; exec: TradeExecution }
  | { type: "skip"; exec: TradeExecution }
  | { type: "fail"; exec: TradeExecution }
  | { type: "redeem"; redeem: RedeemEvent };

export type EventCallback = (event: DashboardEvent) => void;

function makeSkipExecution(
  sourceAddress: string,
  sourceUsername: string | undefined,
  activity: ActivityItem,
  code: FailureCode,
  reason: string,
): TradeExecution {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    sourceAddress,
    sourceUsername,
    sourceTrade: {
      tokenId: activity.asset,
      conditionId: activity.conditionId ?? "",
      side: activity.side ?? "BUY",
      amount: parseFloat(activity.usdcSize ?? activity.size ?? "0"),
      price: parseFloat(activity.price ?? "0"),
      transactionHash: activity.transactionHash,
    },
    status: "skipped",
    reason,
    failureCode: code,
    failureDetail: { stage: code.startsWith("FILTER_") ? "filter" : "calc" },
    market: activity.question
      ? { slug: activity.slug ?? "", question: activity.question ?? "" }
      : undefined,
  };
}

export class TradeMonitor {
  private client: ClobClient;
  private config: MonitorConfig;
  private privateKey: string;
  private funderAddress: string;
  private abortController: AbortController | null = null;
  private seenSet = new Set<string>();
  private eventListeners: EventCallback[] = [];
  private redeemer: AutoRedeemer | null = null;
  private riskManager: RiskManager;
  private lastRiskCheckAt = 0;
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

  constructor(client: ClobClient, config?: Partial<MonitorConfig>, privateKey?: string, funderAddress?: string) {
    this.client = client;
    this.config = { ...DEFAULT_MONITOR_CONFIG, ...config };
    this.privateKey = privateKey ?? "";
    this.funderAddress = funderAddress ?? "";
    this.riskManager = new RiskManager(this.config, this.funderAddress);
  }

  onEvent(cb: EventCallback) {
    this.eventListeners.push(cb);
  }

  private emit(event: DashboardEvent) {
    for (const cb of this.eventListeners) {
      try { cb(event); } catch {}
    }
  }

  async start(): Promise<void> {
    if (this._stats.running) {
      log("warn", "Monitor is already running");
      return;
    }

    const globalRisk = getGlobalRiskState();
    if (globalRisk.latched) {
      updateServiceHeartbeat({
        status: "risk_latched",
        globalStopLatched: true,
        globalStopAt: globalRisk.latchedAt,
        globalStopReason: globalRisk.reason,
        note: "refusing to start while global risk latch is active",
      });
      throw new Error("GLOBAL_RISK_LATCHED");
    }

    const state = loadState();
    for (const h of state.seenHashes) this.seenSet.add(h);
    log("info", `Loaded ${this.seenSet.size} seen hashes from state`);

    this.abortController = new AbortController();
    this._stats.running = true;
    this.lastRiskCheckAt = 0;
    updateServiceHeartbeat({
      pid: process.pid,
      status: "starting",
      startedAt: new Date().toISOString(),
      note: `monitor started (concurrency=${this.config.concurrency}, dryRun=${this.config.dryRun})`,
      globalStopLatched: false,
      globalStopAt: undefined,
      globalStopReason: undefined,
    });
    await sendAlert({
      key: "process:start",
      severity: "info",
      title: "Copy trading service started",
      body: `PID ${process.pid} started at ${new Date().toISOString()}`,
    });
    log("info", `Monitor started (concurrency=${this.config.concurrency}, dryRun=${this.config.dryRun})`);

    if (this.config.autoRedeem && this.privateKey) {
      this.redeemer = new AutoRedeemer(this.client, this.config, this.privateKey);
      this.redeemer.onRedeem((ev) => this.emit({ type: "redeem", redeem: ev }));
      this.redeemer.start();
      log("info", `AutoRedeemer enabled (interval=${this.config.redeemIntervalMs}ms)`);
    }

    try {
      while (!this.abortController.signal.aborted) {
        try {
          await this.runCycle();
          if (Date.now() - this.lastRiskCheckAt >= this.config.riskCheckIntervalMs) {
            this.lastRiskCheckAt = Date.now();
            const risk = await this.riskManager.evaluate();
            if (risk.global.latched) {
              log("error", risk.global.reason ?? "global risk latch triggered");
              this.stop();
              throw new Error("GLOBAL_RISK_LATCHED");
            }
          }
        } catch (err: any) {
          updateServiceHeartbeat({
            status: err.message === "GLOBAL_RISK_LATCHED" ? "risk_latched" : "error",
            lastErrorAt: new Date().toISOString(),
            note: err.message ?? String(err),
            globalStopLatched: err.message === "GLOBAL_RISK_LATCHED",
            globalStopReason: err.message === "GLOBAL_RISK_LATCHED" ? "global risk latch triggered" : undefined,
          });
          if (err.message === "GLOBAL_RISK_LATCHED") throw err;
          log("error", `Cycle error: ${err.message}`);
          await sendAlert({
            key: "engine:cycle-error",
            severity: "warn",
            title: "Monitor cycle error",
            body: err.message ?? String(err),
          });
        }
        await this.sleep(1000);
      }
    } finally {
      this._stats.running = false;
      const globalRisk = getGlobalRiskState();
      updateServiceHeartbeat({
        status: globalRisk.latched ? "risk_latched" : this.abortController?.signal.aborted ? "stopped" : "error",
        note: "monitor stopped",
        globalStopLatched: globalRisk.latched,
        globalStopAt: globalRisk.latchedAt,
        globalStopReason: globalRisk.reason,
      });
      await sendAlert({
        key: "process:stop",
        severity: "warn",
        title: "Copy trading service stopped",
        body: `Service stopped at ${new Date().toISOString()}`,
      });
      log("info", "Monitor stopped");
    }
  }

  stop() {
    this.redeemer?.stop();
    this.abortController?.abort();
  }

  pauseAll() {
    const addresses = loadAddresses();
    for (const a of addresses) {
      a.enabled = false;
      a.pauseReason = a.pauseReason ?? "manual";
    }
    saveAddresses(addresses);
    this._stats.enabledAddresses = 0;
    this._stats.pausedAddresses = addresses.length;
  }

  resumeAll() {
    const addresses = loadAddresses();
    for (const a of addresses) {
      a.enabled = true;
      a.pauseReason = undefined;
      a.riskPausedAt = undefined;
      a.riskNote = undefined;
    }
    saveAddresses(addresses);
    this._stats.enabledAddresses = addresses.length;
    this._stats.pausedAddresses = 0;
  }

  private async runCycle(): Promise<void> {
    const t0 = Date.now();
    const addresses = loadAddresses();

    this._stats.totalAddresses = addresses.length;
    this._stats.enabledAddresses = addresses.filter((a) => a.enabled).length;
    this._stats.pausedAddresses = addresses.filter((a) => !a.enabled).length;

    const enabled = addresses.filter((a) => a.enabled);
    if (enabled.length === 0) {
      updateServiceHeartbeat({
        status: "running",
        lastCycleAt: new Date().toISOString(),
        note: "no enabled addresses",
      });
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
      updateServiceHeartbeat({
        status: "running",
        lastCycleAt: new Date().toISOString(),
      });
      return;
    }

    const limit = pLimit(this.config.concurrency);
    const tasks = due.map((addr) => limit(() => this.pollAddress(addr)));
    await Promise.allSettled(tasks);

    this._stats.cycleCount++;
    this._stats.lastCycleMs = Date.now() - t0;
    updateServiceHeartbeat({
      status: "running",
      lastCycleAt: new Date().toISOString(),
      note: `cycle ${this._stats.cycleCount} (${this._stats.lastCycleMs}ms)`,
    });
  }

  private async pollAddress(addr: FollowedAddress): Promise<void> {
    if (this.abortController?.signal.aborted) return;

    const cursor = getCursor(addr.address);
    const startTs = cursor?.lastSeenTimestamp;
    const addrLabel = addr.username ?? addr.nickname ?? addr.address.slice(0, 10);

    let activities: ActivityItem[];
    try {
      activities = await fetchActivity(addr.address, startTs);
      updateServiceHeartbeat({
        lastSuccessfulPollAt: new Date().toISOString(),
      });
    } catch (err: any) {
      const msg = err.message ?? String(err);
      let code: FailureCode;
      if (msg === "RATE_LIMITED") {
        code = "POLL_RATE_LIMITED";
        log("warn", `Rate limited polling ${addrLabel}...`, { source: addr.address, code });
        await this.sleep(5000);
      } else if (msg.includes("timeout") || msg.includes("Timeout")) {
        code = "POLL_TIMEOUT";
        log("error", `Timeout polling ${addrLabel}: ${msg}`, { source: addr.address, code });
      } else {
        code = "POLL_API_ERROR";
        log("error", `API error polling ${addrLabel}: ${msg}`, { source: addr.address, code, rawError: msg });
      }
      updateServiceHeartbeat({
        lastErrorAt: new Date().toISOString(),
        note: `${code}:${msg}`,
      });
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
      if (!activity.transactionHash) continue;
      if (this.seenSet.has(activity.transactionHash)) continue;
      if (isSeen(activity.transactionHash)) {
        this.seenSet.add(activity.transactionHash);
        continue;
      }

      this.seenSet.add(activity.transactionHash);
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
        const skipExec = makeSkipExecution(
          addr.address,
          addr.username,
          activity,
          filterResult.code ?? "FILTER_MIN_TRIGGER",
          filterResult.reason ?? "filtered",
        );
        appendExecution(skipExec);
        this.emit({ type: "skip", exec: skipExec });
        log(
          "skip",
          `[${addrLabel}] ${filterResult.reason} (${activity.question ?? activity.asset.slice(0, 12)}...)`,
          { source: addr.address, code: filterResult.code },
        );
        continue;
      }

      let copyOutcome;
      if (isSell) {
        const myPosition = getSourcePosition(addr.address, activity.asset);
        const currentValue = myPosition?.lastValueUsdc
          ?? ((myPosition?.netShares ?? 0) * parseFloat(activity.price ?? String(myPosition?.lastPrice ?? 0)));
        copyOutcome = calculateSellCopy(addr, activity, myPosition?.netShares ?? 0, currentValue);
      } else {
        copyOutcome = calculateCopy(addr, activity);
      }

      if (!copyOutcome.ok) {
        this._stats.tradesSkipped++;
        const skipExec = makeSkipExecution(
          addr.address,
          addr.username,
          activity,
          copyOutcome.failure.code,
          copyOutcome.failure.reason,
        );
        appendExecution(skipExec);
        this.emit({ type: "skip", exec: skipExec });
        log("skip", `[${addrLabel}] ${copyOutcome.failure.reason}`, {
          source: addr.address,
          code: copyOutcome.failure.code,
        });
        continue;
      }

      const exec = await executeCopyTrade(
        this.client,
        copyOutcome.result,
        activity,
        addr.address,
        this.config,
      );
      exec.sourceUsername = addr.username;

      if (exec.status === "success") {
        this._stats.tradesExecuted++;
        this.emit({ type: "detect", exec });
        this.emit({ type: "copy", exec });
      } else if (exec.status === "failed") {
        this._stats.tradesFailed++;
        this.emit({ type: "detect", exec });
        this.emit({ type: "fail", exec });
      } else {
        this._stats.tradesSkipped++;
        this.emit({ type: "skip", exec });
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
