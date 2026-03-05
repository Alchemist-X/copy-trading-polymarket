import { OrderType, Side } from "@polymarket/clob-client";
import type { ClobClient } from "@polymarket/clob-client";
import type { CopyResult } from "./copy-logic.js";
import type { TradeExecution, ActivityItem, MonitorConfig } from "../types/index.js";
import { appendExecution } from "../lib/store.js";
import { log } from "../lib/logger.js";
import { fetchTokenPrice } from "../lib/polymarket-api.js";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function executeCopyTrade(
  client: ClobClient,
  copy: CopyResult,
  sourceActivity: ActivityItem,
  sourceAddress: string,
  config: MonitorConfig,
): Promise<TradeExecution> {
  const execId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = new Date().toISOString();

  const execution: TradeExecution = {
    id: execId,
    timestamp,
    sourceAddress,
    sourceTrade: {
      tokenId: sourceActivity.asset,
      conditionId: sourceActivity.conditionId ?? "",
      side: sourceActivity.side ?? "BUY",
      amount: parseFloat(sourceActivity.usdcSize ?? sourceActivity.size ?? "0"),
      price: parseFloat(sourceActivity.price ?? "0"),
      transactionHash: sourceActivity.transactionHash,
    },
    status: "failed",
    market: sourceActivity.question
      ? { slug: sourceActivity.slug ?? "", question: sourceActivity.question ?? "" }
      : undefined,
  };

  if (config.dryRun) {
    execution.status = "skipped";
    execution.reason = "dry run";
    log("skip", `[DRY RUN] ${copy.side} $${copy.amount} on ${copy.tokenId.slice(0, 12)}...`);
    appendExecution(execution);
    return execution;
  }

  const currentPrice = await fetchTokenPrice(copy.tokenId);
  if (currentPrice) {
    const sourcePrice = parseFloat(sourceActivity.price ?? "0");
    if (sourcePrice > 0) {
      const slippage = Math.abs(currentPrice - sourcePrice) / sourcePrice;
      if (slippage > config.maxSlippagePct) {
        execution.status = "skipped";
        execution.reason = `slippage ${(slippage * 100).toFixed(1)}% > max ${(config.maxSlippagePct * 100).toFixed(1)}%`;
        log("skip", `Slippage too high for ${copy.tokenId.slice(0, 12)}...: ${execution.reason}`);
        appendExecution(execution);
        return execution;
      }
    }
  }

  const side = copy.side === "BUY" ? Side.BUY : Side.SELL;
  let lastError = "";

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      const resp = await (client as any).createAndPostMarketOrder(
        { tokenID: copy.tokenId, amount: copy.amount, side },
        undefined,
        OrderType.FOK,
      );

      if (resp.orderID || resp.success) {
        execution.status = "success";
        execution.executedTrade = {
          tokenId: copy.tokenId,
          side: copy.side,
          amount: copy.amount,
          price: currentPrice ?? 0,
          orderId: resp.orderID ?? "",
        };
        log("trade",
          `${copy.side} $${copy.amount} on ${(sourceActivity.question ?? copy.tokenId).slice(0, 40)}... ` +
          `(source: ${sourceAddress.slice(0, 8)}...)`,
        );
        appendExecution(execution);
        return execution;
      }

      lastError = JSON.stringify(resp);
    } catch (err: any) {
      lastError = err.message ?? String(err);
    }

    if (attempt < config.maxRetries) {
      log("warn", `Attempt ${attempt}/${config.maxRetries} failed, retrying in 2s...`);
      await sleep(2000);
    }
  }

  execution.status = "failed";
  execution.reason = lastError;
  log("error", `Failed to execute ${copy.side} $${copy.amount}: ${lastError}`);
  appendExecution(execution);
  return execution;
}
