import type { FollowedAddress, ActivityItem, MarketInfo } from "../types/index.js";
import { loadHistory } from "../lib/store.js";

export interface FilterResult {
  pass: boolean;
  reason?: string;
}

export function applyFilters(
  config: FollowedAddress,
  activity: ActivityItem,
  market?: MarketInfo | null,
): FilterResult {
  const { filters } = config;
  const usdcAmount = parseFloat(activity.usdcSize ?? activity.size ?? "0");

  if (filters.minTrigger && usdcAmount < filters.minTrigger) {
    return { pass: false, reason: `amount $${usdcAmount} < minTrigger $${filters.minTrigger}` };
  }

  if (filters.maxOdds) {
    const price = parseFloat(activity.price ?? "0");
    if (price > 0 && price > filters.maxOdds) {
      return { pass: false, reason: `odds ${price} > maxOdds ${filters.maxOdds}` };
    }
  }

  if (filters.maxPerMarket && activity.conditionId) {
    const history = loadHistory();
    const spent = history
      .filter(
        (e) =>
          e.sourceAddress.toLowerCase() === config.address.toLowerCase() &&
          e.sourceTrade.conditionId === activity.conditionId &&
          e.status === "success",
      )
      .reduce((sum, e) => sum + (e.executedTrade?.amount ?? 0), 0);

    if (spent >= filters.maxPerMarket) {
      return { pass: false, reason: `market cap reached: $${spent} >= $${filters.maxPerMarket}` };
    }
  }

  if (filters.maxDaysOut && market?.endDate) {
    const endMs = new Date(market.endDate).getTime();
    const daysOut = (endMs - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysOut > filters.maxDaysOut) {
      return { pass: false, reason: `market ends in ${Math.round(daysOut)}d > ${filters.maxDaysOut}d` };
    }
  }

  return { pass: true };
}
