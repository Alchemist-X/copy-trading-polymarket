import { getConfig } from "../lib/config.js";
import { sendAlert } from "../lib/alerts.js";
import { estimateSellValueFromOrderBook, fetchUsdcBalance } from "../lib/polymarket-api.js";
import {
  clearRiskPause,
  getGlobalRiskState,
  listSourcePositions,
  loadAddresses,
  pauseAddressForRisk,
  setGlobalRiskLatch,
  setGlobalRiskState,
  setSourceRiskStatus,
  updatePositionValuation,
  updateServiceHeartbeat,
} from "../lib/store.js";
import type { GlobalRiskState, MonitorConfig, SourcePosition, SourceRiskStatus } from "../types/index.js";

export interface RiskSnapshot {
  usdcBalance: number;
  global: GlobalRiskState;
  sources: SourceRiskStatus[];
  positions: SourcePosition[];
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export class RiskManager {
  private config: MonitorConfig;
  private funderAddress: string;

  constructor(config: MonitorConfig, funderAddress: string) {
    this.config = config;
    this.funderAddress = funderAddress;
  }

  private async valuePosition(position: SourcePosition) {
    if (position.netShares <= 0) {
      return {
        valueUsdc: 0,
        note: "flat",
      };
    }

    const valuation = await estimateSellValueFromOrderBook(position.tokenId, position.netShares);
    if (!valuation) {
      return {
        valueUsdc: position.lastValueUsdc ?? 0,
        note: "book unavailable; using last value",
      };
    }

    const price = valuation.pricedShares > 0 ? valuation.valueUsdc / valuation.pricedShares : (valuation.bestBid ?? 0);
    updatePositionValuation(position.sourceAddress, position.tokenId, price, valuation.valueUsdc);
    return {
      valueUsdc: valuation.valueUsdc,
      note: valuation.pricedShares < position.netShares
        ? `partial depth ${valuation.pricedShares.toFixed(2)}/${position.netShares.toFixed(2)}`
        : undefined,
    };
  }

  async snapshot(): Promise<RiskSnapshot> {
    const positions = listSourcePositions();
    const addressMap = new Map(loadAddresses().map((addr) => [addr.address.toLowerCase(), addr]));
    const balanceRaw = await fetchUsdcBalance(this.funderAddress);
    const usdcBalance = balanceRaw === "—" ? 0 : parseFloat(balanceRaw);

    const sourceMap = new Map<string, SourceRiskStatus>();

    for (const position of positions) {
      const valuation = await this.valuePosition(position);
      const current = sourceMap.get(position.sourceAddress) ?? {
        sourceAddress: position.sourceAddress,
        baselineCostUsdc: 0,
        currentValueUsdc: 0,
        realizedPnlUsdc: 0,
        unrealizedPnlUsdc: 0,
        totalPnlUsdc: 0,
        lossPct: 0,
        riskPaused: false,
      };

      current.baselineCostUsdc += position.costBasisUsdc;
      current.currentValueUsdc += valuation.valueUsdc;
      current.realizedPnlUsdc += position.realizedPnlUsdc;
      current.unrealizedPnlUsdc += valuation.valueUsdc - position.costBasisUsdc;
      current.totalPnlUsdc = current.realizedPnlUsdc + current.unrealizedPnlUsdc;
      if (current.baselineCostUsdc > 0) {
        current.lossPct = Math.max(
          0,
          (current.baselineCostUsdc - (current.currentValueUsdc + current.realizedPnlUsdc)) / current.baselineCostUsdc,
        );
      }
      if (valuation.note) current.note = valuation.note;
      sourceMap.set(position.sourceAddress, current);
    }

    const currentEquityUsdc = round2(usdcBalance + Array.from(sourceMap.values()).reduce((sum, source) => sum + source.currentValueUsdc, 0));
    const existingGlobal = getGlobalRiskState();
    const baseline = existingGlobal.baselineEquityUsdc > 0 ? existingGlobal.baselineEquityUsdc : currentEquityUsdc;
    const global: GlobalRiskState = {
      baselineEquityUsdc: baseline,
      currentEquityUsdc,
      lossPct: baseline > 0 ? Math.max(0, (baseline - currentEquityUsdc) / baseline) : 0,
      latched: existingGlobal.latched,
      latchedAt: existingGlobal.latchedAt,
      reason: existingGlobal.reason,
      lastEvaluatedAt: new Date().toISOString(),
    };

    return {
      usdcBalance: round2(usdcBalance),
      global,
      sources: Array.from(sourceMap.values())
        .map((source) => ({
          ...source,
          baselineCostUsdc: round2(source.baselineCostUsdc),
          currentValueUsdc: round2(source.currentValueUsdc),
          realizedPnlUsdc: round2(source.realizedPnlUsdc),
          unrealizedPnlUsdc: round2(source.unrealizedPnlUsdc),
          totalPnlUsdc: round2(source.totalPnlUsdc),
          lossPct: round2(source.lossPct),
          riskPaused: Boolean(addressMap.get(source.sourceAddress.toLowerCase())?.riskPausedAt || addressMap.get(source.sourceAddress.toLowerCase())?.pauseReason === "risk"),
          riskPausedAt: addressMap.get(source.sourceAddress.toLowerCase())?.riskPausedAt,
          note: addressMap.get(source.sourceAddress.toLowerCase())?.riskNote ?? source.note,
        }))
        .sort((a, b) => b.lossPct - a.lossPct),
      positions,
    };
  }

  async evaluate(): Promise<RiskSnapshot> {
    const snapshot = await this.snapshot();
    const addresses = new Map(loadAddresses().map((addr) => [addr.address.toLowerCase(), addr]));
    const cfg = getConfig();

    if (snapshot.usdcBalance > 0 && snapshot.usdcBalance < this.config.lowUsdcAlertThreshold) {
      await sendAlert({
        key: "balance:low-usdc",
        severity: "warn",
        title: "USDC balance low",
        body: `Available USDC is $${snapshot.usdcBalance.toFixed(2)} which is below $${this.config.lowUsdcAlertThreshold.toFixed(2)}.`,
      });
    }

    for (const source of snapshot.sources) {
      const address = addresses.get(source.sourceAddress.toLowerCase());
      source.riskPaused = Boolean(address?.riskPausedAt || address?.pauseReason === "risk");
      source.riskPausedAt = address?.riskPausedAt;
      source.note = address?.riskNote ?? source.note;
      setSourceRiskStatus(source);

      if (source.baselineCostUsdc <= 0) continue;
      if (source.lossPct < cfg.riskSourceStopPct) continue;
      if (source.riskPaused) continue;

      const note = `source loss ${(source.lossPct * 100).toFixed(1)}% >= ${(cfg.riskSourceStopPct * 100).toFixed(1)}%`;
      pauseAddressForRisk(source.sourceAddress, "risk", note);
      setSourceRiskStatus({
        ...source,
        riskPaused: true,
        riskPausedAt: new Date().toISOString(),
        note,
      });
      await sendAlert({
        key: `risk:source:${source.sourceAddress}`,
        severity: "critical",
        title: "Source copy paused by risk rule",
        body: [
          `Source: ${source.sourceAddress}`,
          `Cost basis: $${source.baselineCostUsdc.toFixed(2)}`,
          `Current value: $${source.currentValueUsdc.toFixed(2)}`,
          `Realized PnL: $${source.realizedPnlUsdc.toFixed(2)}`,
          `Loss: ${(source.lossPct * 100).toFixed(2)}%`,
          note,
        ].join("\n"),
      });
    }

    setGlobalRiskState(snapshot.global);
    if (!snapshot.global.latched && snapshot.global.lossPct >= cfg.riskGlobalStopPct) {
      const reason = `global loss ${(snapshot.global.lossPct * 100).toFixed(1)}% >= ${(cfg.riskGlobalStopPct * 100).toFixed(1)}%`;
      setGlobalRiskLatch(reason, snapshot.global.currentEquityUsdc, snapshot.global.baselineEquityUsdc);
      await sendAlert({
        key: "risk:global-stop",
        severity: "critical",
        title: "Global risk stop latched",
        body: [
          `Baseline equity: $${snapshot.global.baselineEquityUsdc.toFixed(2)}`,
          `Current equity: $${snapshot.global.currentEquityUsdc.toFixed(2)}`,
          `Loss: ${(snapshot.global.lossPct * 100).toFixed(2)}%`,
          reason,
          "Manual risk reset is required before restart.",
        ].join("\n"),
      });
      snapshot.global.latched = true;
      snapshot.global.reason = reason;
      snapshot.global.latchedAt = new Date().toISOString();
    }

    updateServiceHeartbeat({
      lastRiskCheckAt: new Date().toISOString(),
      globalStopLatched: snapshot.global.latched,
      globalStopAt: snapshot.global.latchedAt,
      globalStopReason: snapshot.global.reason,
    });

    return snapshot;
  }

  async clearRiskPause(address: string) {
    return clearRiskPause(address);
  }
}
