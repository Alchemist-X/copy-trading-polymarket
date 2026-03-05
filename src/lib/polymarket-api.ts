import type { ActivityItem, MarketInfo } from "../types/index.js";
import { ethers } from "ethers";

const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";
const POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

export async function fetchUsdcBalance(walletAddress: string): Promise<string> {
  try {
    const provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);
    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
    const balance = await usdc.balanceOf(walletAddress);
    return ethers.utils.formatUnits(balance, 6);
  } catch {
    return "—";
  }
}

function toMs(ts: unknown): number {
  if (!ts) return 0;
  if (typeof ts === "string") return new Date(ts).getTime();
  const n = Number(ts);
  return n < 1e12 ? n * 1000 : n;
}

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
    const startSec = startTimestamp > 1e12 ? Math.floor(startTimestamp / 1000) : startTimestamp;
    params.set("start", String(startSec));
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
    timestamp: toMs(item.timestamp),
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
  try {
    const params = new URLSearchParams({
      user: address,
      limit: "100",
      type: "TRADE",
      sortBy: "TIMESTAMP",
    });
    const res = await fetch(`${DATA_API}/activity?${params}`);
    if (!res.ok) return [];
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
      timestamp: toMs(item.timestamp),
      title: item.title ?? item.question,
      slug: item.slug,
      question: item.question ?? item.title,
    }));
  } catch {
    return [];
  }
}

async function fetchPositions(address: string): Promise<Array<{ title: string; size: number; outcome: string }>> {
  try {
    const res = await fetch(`${DATA_API}/positions?user=${address}&sizeThreshold=0.1`);
    if (!res.ok) return [];
    const data: any[] = await res.json();
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
  try {
    const params = new URLSearchParams({
      q: query,
      search_profiles: "true",
      limit_per_type: "5",
    });
    const res = await fetch(`${GAMMA_API}/public-search?${params}`);
    if (!res.ok) return [];
    const data = await res.json();
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
  try {
    const res = await fetch(`${GAMMA_API}/public-profile?address=${address}`);
    if (!res.ok) return null;
    const data = await res.json();
    return { name: data.name, pseudonym: data.pseudonym };
  } catch {
    return null;
  }
}

export async function pingLatency(): Promise<number> {
  const t0 = Date.now();
  try {
    await fetch("https://clob.polymarket.com/time");
  } catch {
    return -1;
  }
  return Date.now() - t0;
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
