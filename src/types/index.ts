export type CopyMode = "percentage" | "fixed" | "range";
export type SellMode = "same_pct" | "fixed" | "custom_pct" | "ignore";
export type Priority = "fast" | "normal" | "slow";
export type ExecutionStatus = "success" | "failed" | "skipped";

export type FailureCode =
  | "POLL_RATE_LIMITED" | "POLL_API_ERROR" | "POLL_TIMEOUT" | "POLL_PARSE_ERROR"
  | "FILTER_MIN_TRIGGER" | "FILTER_MAX_ODDS" | "FILTER_MAX_PER_MARKET"
  | "FILTER_MAX_DAYS_OUT" | "FILTER_SELL_IGNORED"
  | "CALC_AMOUNT_TOO_SMALL" | "CALC_ZERO_ORIGINAL" | "CALC_NO_POSITION"
  | "SLIPPAGE_TOO_HIGH" | "SLIPPAGE_PRICE_UNAVAILABLE"
  | "EXEC_INSUFFICIENT_BALANCE" | "EXEC_FOK_NOT_FILLED"
  | "EXEC_API_ERROR" | "EXEC_NETWORK_ERROR";

export interface FailureDetail {
  stage: "poll" | "filter" | "calc" | "slippage" | "exec";
  attempts?: number;
  currentPrice?: number;
  sourcePrice?: number;
  slippagePct?: number;
  rawError?: string;
  apiResponse?: unknown;
}

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
  username?: string;
  nickname?: string;
  enabled: boolean;
  pauseReason?: string;
  riskPausedAt?: string;
  riskNote?: string;
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
  shares?: number;
  proceeds?: number;
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
  sourceUsername?: string;
  sourceTrade: SourceTrade;
  executedTrade?: ExecutedTrade;
  status: ExecutionStatus;
  reason?: string;
  failureCode?: FailureCode;
  failureDetail?: FailureDetail;
  latencyMs?: number;
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
  globalStopLatched?: boolean;
  globalStopAt?: string;
  globalStopReason?: string;
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

export interface RedeemRecord {
  conditionId: string;
  tokenId: string;
  amount: string;
  txHash: string;
  question?: string;
  timestamp: string;
}

export interface RedeemsStore {
  redeemed: RedeemRecord[];
}

export interface MonitorConfig {
  concurrency: number;
  fastIntervalMs: number;
  normalIntervalMs: number;
  slowIntervalMs: number;
  maxSlippagePct: number;
  maxRetries: number;
  dryRun: boolean;
  autoRedeem: boolean;
  redeemIntervalMs: number;
  riskCheckIntervalMs: number;
  lowUsdcAlertThreshold: number;
}

export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  concurrency: 15,
  fastIntervalMs: 10_000,
  normalIntervalMs: 30_000,
  slowIntervalMs: 60_000,
  maxSlippagePct: 0.05,
  maxRetries: 3,
  dryRun: false,
  autoRedeem: true,
  redeemIntervalMs: 60_000,
  riskCheckIntervalMs: 60_000,
  lowUsdcAlertThreshold: 25,
};

export const DEFAULT_FILTERS: Filters = {
  sellMode: "same_pct",
};

export interface SourcePosition {
  sourceAddress: string;
  tokenId: string;
  conditionId: string;
  marketSlug?: string;
  marketQuestion?: string;
  netShares: number;
  costBasisUsdc: number;
  realizedPnlUsdc: number;
  lastPrice?: number;
  lastValueUsdc?: number;
  lastValuedAt?: string;
  updatedAt: string;
}

export interface SourceRiskStatus {
  sourceAddress: string;
  baselineCostUsdc: number;
  currentValueUsdc: number;
  realizedPnlUsdc: number;
  unrealizedPnlUsdc: number;
  totalPnlUsdc: number;
  lossPct: number;
  riskPaused: boolean;
  riskPausedAt?: string;
  note?: string;
}

export interface GlobalRiskState {
  baselineEquityUsdc: number;
  currentEquityUsdc: number;
  lossPct: number;
  latched: boolean;
  latchedAt?: string;
  reason?: string;
  lastEvaluatedAt?: string;
}

export interface ServiceHeartbeat {
  serviceName: string;
  pid?: number;
  status: "starting" | "running" | "stopped" | "error" | "risk_latched";
  startedAt?: string;
  lastCycleAt?: string;
  lastSuccessfulPollAt?: string;
  lastErrorAt?: string;
  lastRedeemAt?: string;
  lastRiskCheckAt?: string;
  lastAlertTestAt?: string;
  note?: string;
  globalStopLatched: boolean;
  globalStopAt?: string;
  globalStopReason?: string;
}

export interface AlertEvent {
  id?: number;
  alertKey: string;
  channel: "telegram" | "email";
  severity: "info" | "warn" | "critical";
  title: string;
  body: string;
  sentAt?: string;
  dedupeUntil?: string;
  status: "sent" | "skipped" | "failed";
  error?: string;
}

export interface EndpointHealth {
  endpoint: string;
  consecutiveFailures: number;
  degraded: boolean;
  lastErrorAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
}
