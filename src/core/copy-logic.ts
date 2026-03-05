import type { FollowedAddress, ActivityItem } from "../types/index.js";

export interface CopyResult {
  side: "BUY" | "SELL";
  amount: number;
  tokenId: string;
}

export function calculateCopy(
  config: FollowedAddress,
  activity: ActivityItem,
): CopyResult | null {
  const originalAmount = parseFloat(activity.usdcSize ?? activity.size ?? "0");
  if (originalAmount <= 0) return null;

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
      return null;
  }

  amount = Math.round(amount * 100) / 100;
  if (amount < 0.5) return null;

  return { side, amount, tokenId: activity.asset };
}

export function calculateSellCopy(
  config: FollowedAddress,
  activity: ActivityItem,
  myPositionSize: number,
): CopyResult | null {
  const { sellMode, sellAmount } = config.filters;
  if (sellMode === "ignore") return null;

  const originalAmount = parseFloat(activity.usdcSize ?? activity.size ?? "0");
  if (originalAmount <= 0 || myPositionSize <= 0) return null;

  let amount: number;

  switch (sellMode) {
    case "same_pct": {
      const originalSize = parseFloat(activity.size ?? "0");
      if (originalSize <= 0) return null;
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
      return null;
  }

  amount = Math.round(amount * 100) / 100;
  if (amount < 0.5) return null;

  let side: "BUY" | "SELL" = "SELL";
  if (config.counterMode) side = "BUY";

  return { side, amount, tokenId: activity.asset };
}
