import type { ActivityItem, MarketInfo } from "../types/index.js";

const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

export async function fetchActivity(
  userAddress: string,
  startTimestamp?: number,
  limit = 100,
): Promise<ActivityItem[]> {
  const params = new URLSearchParams({
    user: userAddress,
    limit: String(limit),
    type: "TRADE",
    sortBy: "TIMESTAMP",
  });
  if (startTimestamp) {
    params.set("start", String(startTimestamp));
  }

  const res = await fetch(`${DATA_API}/activity?${params}`);
  if (!res.ok) {
    if (res.status === 429) throw new Error("RATE_LIMITED");
    throw new Error(`Activity API ${res.status}: ${res.statusText}`);
  }

  const data: any[] = await res.json();
  return data.map((item) => ({
    type: item.type ?? "TRADE",
    side: item.side,
    asset: item.asset ?? item.asset_id ?? "",
    conditionId: item.conditionId ?? item.condition_id ?? item.market ?? "",
    size: item.size ?? item.tokens,
    price: item.price,
    usdcSize: item.usdcSize ?? item.cash,
    transactionHash: item.transactionHash ?? item.transaction_hash ?? "",
    timestamp: item.timestamp
      ? typeof item.timestamp === "number"
        ? item.timestamp
        : new Date(item.timestamp).getTime()
      : 0,
    title: item.title ?? item.question,
    slug: item.slug,
    question: item.question ?? item.title,
  }));
}

export async function fetchMarketByCondition(conditionId: string): Promise<MarketInfo | null> {
  try {
    const res = await fetch(`${GAMMA_API}/markets?condition_id=${conditionId}`);
    if (!res.ok) return null;
    const data: any[] = await res.json();
    if (!data.length) return null;

    const m = data[0];
    const tokenIds = parseTokenIds(m.clobTokenIds);
    return {
      slug: m.slug ?? m.market_slug ?? "",
      question: m.question ?? "",
      conditionId: m.conditionId ?? conditionId,
      tokenYes: tokenIds[0] ?? "",
      tokenNo: tokenIds[1] ?? "",
      endDate: m.endDate ?? m.end_date_iso,
    };
  } catch {
    return null;
  }
}

export async function fetchMarketByToken(tokenId: string): Promise<MarketInfo | null> {
  try {
    const res = await fetch(`${GAMMA_API}/markets?clob_token_ids=${tokenId}`);
    if (!res.ok) return null;
    const data: any[] = await res.json();
    if (!data.length) return null;

    const m = data[0];
    const tokenIds = parseTokenIds(m.clobTokenIds);
    return {
      slug: m.slug ?? m.market_slug ?? "",
      question: m.question ?? "",
      conditionId: m.conditionId ?? "",
      tokenYes: tokenIds[0] ?? "",
      tokenNo: tokenIds[1] ?? "",
      endDate: m.endDate ?? m.end_date_iso,
    };
  } catch {
    return null;
  }
}

export async function fetchTokenPrice(tokenId: string): Promise<number | null> {
  try {
    const res = await fetch(`https://clob.polymarket.com/price?token_id=${tokenId}&side=buy`);
    if (!res.ok) return null;
    const data = await res.json();
    return parseFloat(data.price ?? "0") || null;
  } catch {
    return null;
  }
}

export async function fetchOrderBook(tokenId: string) {
  const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
  if (!res.ok) return null;
  return res.json();
}

function parseTokenIds(ids: string[] | string | undefined): string[] {
  if (!ids) return [];
  if (Array.isArray(ids)) return ids;
  try {
    const parsed = JSON.parse(ids);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
