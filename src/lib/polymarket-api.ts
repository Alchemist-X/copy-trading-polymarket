import { ethers } from "ethers";
import { getConfig } from "./config.js";
import { HttpError, apiPolicy, pollPolicy, pricePolicy, requestJson } from "./http.js";
import type { ActivityItem, MarketInfo } from "../types/index.js";

const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

let provider: ethers.providers.JsonRpcProvider | null = null;

function getProvider() {
  if (!provider) {
    provider = new ethers.providers.JsonRpcProvider(getConfig().polygonRpcUrl);
  }
  return provider;
}

function toMs(ts: unknown): number {
  if (!ts) return 0;
  if (typeof ts === "string") return new Date(ts).getTime();
  const n = Number(ts);
  return n < 1e12 ? n * 1000 : n;
}

function mapActivity(item: any): ActivityItem {
  return {
    type: item.type ?? "TRADE",
    side: item.side,
    asset: item.asset ?? item.asset_id ?? "",
    conditionId: item.conditionId ?? item.condition_id ?? item.market ?? "",
    size: item.size ?? item.tokens,
    price: item.price,
    usdcSize: item.usdcSize ?? item.cash,
    transactionHash: item.transactionHash ?? item.transaction_hash ?? "",
    timestamp: toMs(item.timestamp),
    title: item.title ?? item.question,
    slug: item.slug,
    question: item.question ?? item.title,
  };
}

export async function fetchUsdcBalance(walletAddress: string): Promise<string> {
  try {
    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, getProvider());
    const balance = await usdc.balanceOf(walletAddress);
    return ethers.utils.formatUnits(balance, 6);
  } catch {
    return "—";
  }
}

export async function fetchActivity(
  userAddress: string,
  startTimestamp?: number,
  limit = 100,
): Promise<ActivityItem[]> {
  const cfg = getConfig();
  const params = new URLSearchParams({
    user: userAddress,
    limit: String(limit),
    type: "TRADE",
    sortBy: "TIMESTAMP",
  });
  if (startTimestamp) {
    const startSec = startTimestamp > 1e12 ? Math.floor(startTimestamp / 1000) : startTimestamp;
    params.set("start", String(startSec));
  }

  try {
    const data = await requestJson<any[]>(
      `${cfg.dataApiUrl}/activity?${params}`,
      pollPolicy("data-api:activity"),
    );
    return data.map(mapActivity);
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) throw new Error("RATE_LIMITED");
    throw err;
  }
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

export async function fetchMarketByCondition(conditionId: string): Promise<MarketInfo | null> {
  const cfg = getConfig();
  try {
    const data = await requestJson<any[]>(
      `${cfg.gammaApiUrl}/markets?condition_id=${conditionId}`,
      apiPolicy("gamma:markets"),
    );
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
  const cfg = getConfig();
  try {
    const data = await requestJson<any[]>(
      `${cfg.gammaApiUrl}/markets?clob_token_ids=${tokenId}`,
      apiPolicy("gamma:markets"),
    );
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
  const cfg = getConfig();
  try {
    const data = await requestJson<{ price?: string }>(
      `${cfg.clobHost}/price?token_id=${tokenId}&side=buy`,
      pricePolicy("clob:price"),
    );
    return parseFloat(data.price ?? "0") || null;
  } catch {
    return null;
  }
}

export async function fetchOrderBook(tokenId: string) {
  const cfg = getConfig();
  try {
    return await requestJson<any>(
      `${cfg.clobHost}/book?token_id=${tokenId}`,
      pricePolicy("clob:book"),
    );
  } catch {
    return null;
  }
}

export async function estimateSellValueFromOrderBook(tokenId: string, shares: number): Promise<{ valueUsdc: number; pricedShares: number; bestBid?: number } | null> {
  const book = await fetchOrderBook(tokenId);
  if (!book || shares <= 0) return null;

  const bids: Array<{ price: number; size: number }> = [];
  const rawBids = Array.isArray(book.bids) ? book.bids : [];
  for (const bid of rawBids) {
    if (Array.isArray(bid) && bid.length >= 2) {
      bids.push({ price: Number(bid[0]), size: Number(bid[1]) });
      continue;
    }
    bids.push({
      price: Number(bid.price ?? bid[0] ?? 0),
      size: Number(bid.size ?? bid.amount ?? bid[1] ?? 0),
    });
  }

  bids.sort((a, b) => b.price - a.price);
  let remaining = shares;
  let valueUsdc = 0;
  let pricedShares = 0;

  for (const bid of bids) {
    if (remaining <= 0) break;
    if (!(bid.price > 0) || !(bid.size > 0)) continue;
    const matched = Math.min(remaining, bid.size);
    valueUsdc += matched * bid.price;
    pricedShares += matched;
    remaining -= matched;
  }

  return {
    valueUsdc,
    pricedShares,
    bestBid: bids[0]?.price,
  };
}

export interface AddressProfile {
  valid: boolean;
  hasActivity: boolean;
  tradeCount: number;
  firstTradeAt?: string;
  lastTradeAt?: string;
  positionCount: number;
  positions: Array<{ title: string; size: number; outcome: string }>;
  recentTrades: Array<{ side: string; amount: string; question: string; time: string }>;
}

export async function verifyAddress(address: string): Promise<AddressProfile> {
  const profile: AddressProfile = {
    valid: false,
    hasActivity: false,
    tradeCount: 0,
    positionCount: 0,
    positions: [],
    recentTrades: [],
  };

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return profile;
  profile.valid = true;

  const [activities, positions] = await Promise.all([
    fetchRecentTrades(address),
    fetchPositions(address),
  ]);

  profile.tradeCount = activities.length;
  profile.hasActivity = activities.length > 0;

  if (activities.length > 0) {
    const sorted = [...activities].sort((a, b) => a.timestamp - b.timestamp);
    profile.firstTradeAt = new Date(sorted[0].timestamp).toISOString().slice(0, 10);
    profile.lastTradeAt = new Date(sorted[sorted.length - 1].timestamp).toISOString().slice(0, 10);
    profile.recentTrades = activities.slice(0, 10).map((t) => ({
      side: t.side ?? "?",
      amount: t.usdcSize ?? t.size ?? "?",
      question: t.question ?? t.title ?? t.asset?.slice(0, 16) ?? "?",
      time: new Date(t.timestamp).toISOString().slice(0, 16).replace("T", " "),
    }));
  }

  profile.positionCount = positions.length;
  profile.positions = positions.slice(0, 10);
  return profile;
}

async function fetchRecentTrades(address: string): Promise<ActivityItem[]> {
  const cfg = getConfig();
  try {
    const params = new URLSearchParams({
      user: address,
      limit: "100",
      type: "TRADE",
      sortBy: "TIMESTAMP",
    });
    const data = await requestJson<any[]>(
      `${cfg.dataApiUrl}/activity?${params}`,
      apiPolicy("data-api:recent-trades"),
    );
    return data.map(mapActivity);
  } catch {
    return [];
  }
}

async function fetchPositions(address: string): Promise<Array<{ title: string; size: number; outcome: string }>> {
  const cfg = getConfig();
  try {
    const data = await requestJson<any[]>(
      `${cfg.dataApiUrl}/positions?user=${address}&sizeThreshold=0.1`,
      apiPolicy("data-api:positions"),
    );
    return data
      .map((p) => ({
        title: p.title ?? p.question ?? p.market ?? "?",
        size: parseFloat(p.size ?? p.currentValue ?? "0"),
        outcome: p.outcome ?? "?",
      }))
      .filter((p) => p.size > 0)
      .sort((a, b) => b.size - a.size);
  } catch {
    return [];
  }
}

export interface ResolvedUser {
  address: string;
  username: string;
  pseudonym?: string;
}

export async function resolveInput(input: string): Promise<{ address: string; username?: string } | null> {
  if (/^0x[a-fA-F0-9]{40}$/.test(input)) {
    const profile = await fetchProfile(input);
    return { address: input, username: profile?.name };
  }
  const results = await searchProfiles(input);
  if (results.length === 0) return null;
  const exact = results.find((r) => r.username.toLowerCase() === input.toLowerCase());
  if (exact) return { address: exact.address, username: exact.username };
  return { address: results[0].address, username: results[0].username };
}

export async function searchProfiles(query: string): Promise<ResolvedUser[]> {
  const cfg = getConfig();
  try {
    const params = new URLSearchParams({
      q: query,
      search_profiles: "true",
      limit_per_type: "5",
    });
    const data = await requestJson<any>(
      `${cfg.gammaApiUrl}/public-search?${params}`,
      apiPolicy("gamma:public-search"),
    );
    const profiles: any[] = data.profiles ?? [];
    return profiles
      .filter((p: any) => p.proxyWallet)
      .map((p: any) => ({
        address: p.proxyWallet,
        username: p.name ?? "",
        pseudonym: p.pseudonym,
      }));
  } catch {
    return [];
  }
}

export async function fetchProfile(address: string): Promise<{ name?: string; pseudonym?: string } | null> {
  const cfg = getConfig();
  try {
    const data = await requestJson<any>(
      `${cfg.gammaApiUrl}/public-profile?address=${address}`,
      apiPolicy("gamma:public-profile"),
    );
    return { name: data.name, pseudonym: data.pseudonym };
  } catch {
    return null;
  }
}

export async function pingLatency(): Promise<number> {
  const cfg = getConfig();
  const t0 = Date.now();
  try {
    await requestJson(
      `${cfg.clobHost}/time`,
      pricePolicy("clob:time"),
    );
    return Date.now() - t0;
  } catch {
    return -1;
  }
}
