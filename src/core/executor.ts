import { OrderType, Side } from "@polymarket/clob-client";
import type { ClobClient } from "@polymarket/clob-client";
import type { CopyResult } from "./copy-logic.js";
import type { TradeExecution, ActivityItem, MonitorConfig, FailureCode, FailureDetail } from "../types/index.js";
import { appendExecution } from "../lib/store.js";
import { log } from "../lib/logger.js";
import { sendAlert } from "../lib/alerts.js";
import { fetchTokenPrice } from "../lib/polymarket-api.js";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function classifyError(err: string): FailureCode {
  const lower = err.toLowerCase();
  if (lower.includes("insufficient") || lower.includes("balance") || lower.includes("allowance"))
    return "EXEC_INSUFFICIENT_BALANCE";
  if (lower.includes("fok") || lower.includes("not filled") || lower.includes("no fill"))
    return "EXEC_FOK_NOT_FILLED";
  if (lower.includes("no match"))
    return "EXEC_FOK_NOT_FILLED";
  if (lower.includes("timeout") || lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("network"))
    return "EXEC_NETWORK_ERROR";
  return "EXEC_API_ERROR";
}

export async function executeCopyTrade(
  client: ClobClient,
  copy: CopyResult,
  sourceActivity: ActivityItem,
  sourceAddress: string,
  config: MonitorConfig,
): Promise<TradeExecution> {
  const t0 = Date.now();
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
    execution.latencyMs = Date.now() - t0;
    log("skip", `[DRY RUN] ${copy.side} $${copy.amount} on ${copy.tokenId.slice(0, 12)}...`, {
      source: sourceAddress, tokenId: copy.tokenId, amount: copy.amount, side: copy.side,
    });
    appendExecution(execution);
    return execution;
  }

  const sourcePrice = parseFloat(sourceActivity.price ?? "0");
  const currentPrice = await fetchTokenPrice(copy.tokenId);

  if (!currentPrice) {
    execution.status = "skipped";
    execution.reason = "cannot fetch current price";
    execution.failureCode = "SLIPPAGE_PRICE_UNAVAILABLE";
    execution.failureDetail = { stage: "slippage", rawError: "fetchTokenPrice returned null" };
    execution.latencyMs = Date.now() - t0;
    log("skip", `Price unavailable for ${copy.tokenId.slice(0, 12)}...`, {
      source: sourceAddress, code: "SLIPPAGE_PRICE_UNAVAILABLE",
    });
    appendExecution(execution);
    return execution;
  }

  if (sourcePrice > 0) {
    const slippagePct = Math.abs(currentPrice - sourcePrice) / sourcePrice;
    if (slippagePct > config.maxSlippagePct) {
      execution.status = "skipped";
      execution.reason = `slippage ${(slippagePct * 100).toFixed(1)}% > max ${(config.maxSlippagePct * 100).toFixed(1)}%`;
      execution.failureCode = "SLIPPAGE_TOO_HIGH";
      execution.failureDetail = {
        stage: "slippage",
        currentPrice,
        sourcePrice,
        slippagePct,
      };
      execution.latencyMs = Date.now() - t0;
      log("skip", `Slippage too high for ${copy.tokenId.slice(0, 12)}...: ${execution.reason}`, {
        source: sourceAddress, code: "SLIPPAGE_TOO_HIGH", slippage: slippagePct,
      });
      appendExecution(execution);
      return execution;
    }
  }

  const side = copy.side === "BUY" ? Side.BUY : Side.SELL;
  let lastError = "";
  let attempts = 0;

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    attempts = attempt;
    try {
      const resp = await (client as any).createAndPostMarketOrder(
        { tokenID: copy.tokenId, amount: copy.amount, side },
        undefined,
        OrderType.FOK,
      );

      if (resp.orderID || resp.success) {
        const shares = currentPrice > 0 ? copy.amount / currentPrice : undefined;
        execution.status = "success";
        execution.executedTrade = {
          tokenId: copy.tokenId,
          side: copy.side,
          amount: copy.amount,
          price: currentPrice,
          orderId: resp.orderID ?? "",
          shares,
          proceeds: copy.side === "SELL" ? copy.amount : undefined,
        };
        execution.latencyMs = Date.now() - t0;
        log("trade",
          `${copy.side} $${copy.amount} on ${(sourceActivity.question ?? copy.tokenId).slice(0, 40)}... ` +
          `(source: ${sourceAddress.slice(0, 8)}...)`,
          { source: sourceAddress, tokenId: copy.tokenId, amount: copy.amount, side: copy.side },
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

  const failureCode = classifyError(lastError);
  execution.status = "failed";
  execution.reason = lastError;
  execution.failureCode = failureCode;
  execution.failureDetail = {
    stage: "exec",
    attempts,
    currentPrice,
    sourcePrice,
    rawError: lastError,
  };
  execution.latencyMs = Date.now() - t0;
  log("error", `Failed to execute ${copy.side} $${copy.amount}: ${lastError}`, {
    source: sourceAddress, code: failureCode, attempts, rawError: lastError,
  });
  if (failureCode === "EXEC_INSUFFICIENT_BALANCE") {
    await sendAlert({
      key: "balance:insufficient",
      severity: "warn",
      title: "Trade execution failed: insufficient balance",
      body: [
        `Source: ${sourceAddress}`,
        `Trade: ${copy.side} $${copy.amount}`,
        `Attempts: ${attempts}`,
        `Error: ${lastError}`,
      ].join("\n"),
    });
  }
  appendExecution(execution);
  return execution;
}
