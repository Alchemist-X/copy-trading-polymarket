export type CopyMode = "percentage" | "fixed" | "range";
export type SellMode = "same_pct" | "fixed" | "custom_pct" | "ignore";
export type Priority = "fast" | "normal" | "slow";
export type ExecutionStatus = "success" | "failed" | "skipped";

export interface Filters {
  minTrigger?: number;
  maxOdds?: number;
  minLiquidity?: number;
  maxPerMarket?: number;
  maxDaysOut?: number;
  sellMode: SellMode;
  sellAmount?: number;
}

export interface FollowedAddress {
  address: string;
  nickname?: string;
  enabled: boolean;
  copyMode: CopyMode;
  counterMode: boolean;
  percentage?: number;
  fixedAmount?: number;
  minAmount?: number;
  maxAmount?: number;
  filters: Filters;
  priority: Priority;
  addedAt: string;
}

export interface SourceTrade {
  tokenId: string;
  conditionId: string;
  side: string;
  amount: number;
  price: number;
  transactionHash: string;
}

export interface ExecutedTrade {
  tokenId: string;
  side: string;
  amount: number;
  price: number;
  orderId: string;
}

export interface MarketInfo {
  slug: string;
  question: string;
  conditionId: string;
  tokenYes: string;
  tokenNo: string;
  endDate?: string;
}

export interface TradeExecution {
  id: string;
  timestamp: string;
  sourceAddress: string;
  sourceTrade: SourceTrade;
  executedTrade?: ExecutedTrade;
  status: ExecutionStatus;
  reason?: string;
  market?: { slug: string; question: string };
}

export interface AddressCursor {
  lastSeenTimestamp: number;
  lastActivityAt: number;
}

export interface MonitorState {
  cursors: Record<string, AddressCursor>;
  seenHashes: string[];
  startedAt?: string;
}

export interface AddressesStore {
  addresses: FollowedAddress[];
}

export interface HistoryStore {
  executions: TradeExecution[];
}

export interface ActivityItem {
  type: string;
  side?: string;
  asset: string;
  conditionId?: string;
  size?: string;
  price?: string;
  usdcSize?: string;
  transactionHash: string;
  timestamp: number;
  title?: string;
  slug?: string;
  question?: string;
}

export interface MonitorConfig {
  concurrency: number;
  fastIntervalMs: number;
  normalIntervalMs: number;
  slowIntervalMs: number;
  maxSlippagePct: number;
  maxRetries: number;
  dryRun: boolean;
}

export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  concurrency: 15,
  fastIntervalMs: 10_000,
  normalIntervalMs: 30_000,
  slowIntervalMs: 60_000,
  maxSlippagePct: 0.05,
  maxRetries: 3,
  dryRun: false,
};

export const DEFAULT_FILTERS: Filters = {
  sellMode: "same_pct",
};
