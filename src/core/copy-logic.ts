import type { FollowedAddress, ActivityItem, FailureCode } from "../types/index.js";

export interface CopyResult {
  side: "BUY" | "SELL";
  amount: number;
  tokenId: string;
}

export interface CopyFailure {
  code: FailureCode;
  reason: string;
}

export type CopyOutcome =
  | { ok: true; result: CopyResult }
  | { ok: false; failure: CopyFailure };

export function calculateCopy(
  config: FollowedAddress,
  activity: ActivityItem,
): CopyOutcome {
  const originalAmount = parseFloat(activity.usdcSize ?? activity.size ?? "0");
  if (originalAmount <= 0) {
    return { ok: false, failure: { code: "CALC_ZERO_ORIGINAL", reason: `original amount ${originalAmount} <= 0` } };
  }

  let side = (activity.side ?? "BUY").toUpperCase() as "BUY" | "SELL";
  if (config.counterMode) {
    side = side === "BUY" ? "SELL" : "BUY";
  }

  let amount: number;

  switch (config.copyMode) {
    case "percentage": {
      const pct = config.percentage ?? 0.1;
      amount = originalAmount * pct;
      break;
    }
    case "fixed": {
      amount = config.fixedAmount ?? 5;
      break;
    }
    case "range": {
      const pct = config.percentage ?? 0.1;
      const min = config.minAmount ?? 1;
      const max = config.maxAmount ?? 100;
      amount = Math.max(min, Math.min(max, originalAmount * pct));
      break;
    }
    default:
      return { ok: false, failure: { code: "CALC_ZERO_ORIGINAL", reason: `unknown copy mode` } };
  }

  amount = Math.round(amount * 100) / 100;
  if (amount < 0.1) {
    return { ok: false, failure: { code: "CALC_AMOUNT_TOO_SMALL", reason: `calculated amount $${amount} < $0.1` } };
  }

  return { ok: true, result: { side, amount, tokenId: activity.asset } };
}

export function calculateSellCopy(
  config: FollowedAddress,
  activity: ActivityItem,
  myPositionSize: number,
): CopyOutcome {
  const { sellMode, sellAmount } = config.filters;
  if (sellMode === "ignore") {
    return { ok: false, failure: { code: "FILTER_SELL_IGNORED", reason: "sell mode set to ignore" } };
  }

  const originalAmount = parseFloat(activity.usdcSize ?? activity.size ?? "0");
  if (originalAmount <= 0) {
    return { ok: false, failure: { code: "CALC_ZERO_ORIGINAL", reason: `original sell amount ${originalAmount} <= 0` } };
  }

  if (myPositionSize <= 0) {
    return { ok: false, failure: { code: "CALC_NO_POSITION", reason: `no position to sell (size=${myPositionSize})` } };
  }

  let amount: number;

  switch (sellMode) {
    case "same_pct": {
      const originalSize = parseFloat(activity.size ?? "0");
      if (originalSize <= 0) {
        return { ok: false, failure: { code: "CALC_ZERO_ORIGINAL", reason: `original size is 0 for same_pct` } };
      }
      const pct = originalAmount / originalSize;
      amount = myPositionSize * Math.min(pct, 1);
      break;
    }
    case "fixed": {
      amount = sellAmount ?? 5;
      break;
    }
    case "custom_pct": {
      const pct = sellAmount ?? 0.25;
      amount = myPositionSize * pct;
      break;
    }
    default:
      return { ok: false, failure: { code: "CALC_ZERO_ORIGINAL", reason: `unknown sell mode` } };
  }

  amount = Math.round(amount * 100) / 100;
  if (amount < 0.1) {
    return { ok: false, failure: { code: "CALC_AMOUNT_TOO_SMALL", reason: `sell amount $${amount} < $0.1` } };
  }

  let side: "BUY" | "SELL" = "SELL";
  if (config.counterMode) side = "BUY";

  return { ok: true, result: { side, amount, tokenId: activity.asset } };
}
