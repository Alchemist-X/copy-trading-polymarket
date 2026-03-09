import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getConfig } from "./config.js";
import { getDb, withTransaction } from "./db.js";
import type {
  AddressCursor,
  AddressesStore,
  AlertEvent,
  EndpointHealth,
  FollowedAddress,
  GlobalRiskState,
  HistoryStore,
  MonitorState,
  RedeemRecord,
  RedeemsStore,
  ServiceHeartbeat,
  SourcePosition,
  SourceRiskStatus,
  TradeExecution,
} from "../types/index.js";
import { DEFAULT_FILTERS } from "../types/index.js";

const LEGACY_DATA_DIR = join(process.cwd(), "data");
const MAX_HISTORY = 10_000;
const MAX_SEEN = 50_000;
const TRIMMED_SEEN = 30_000;

function nowIso(): string {
  return new Date().toISOString();
}

function parseJSON<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function readLegacyJson<T>(file: string, fallback: T): T {
  const path = join(LEGACY_DATA_DIR, file);
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeHeartbeatFile(heartbeat: ServiceHeartbeat) {
  const file = getConfig().heartbeatFile;
  if (!file) return;
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(heartbeat, null, 2));
}

function setMeta(key: string, value: string) {
  const db = getDb();
  db.prepare(`
    INSERT INTO meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function getMeta(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

function toAddressRow(entry: FollowedAddress) {
  const ts = nowIso();
  return {
    address: entry.address.toLowerCase(),
    username: entry.username ?? null,
    nickname: entry.nickname ?? null,
    enabled: entry.enabled ? 1 : 0,
    pause_reason: entry.pauseReason ?? null,
    risk_paused_at: entry.riskPausedAt ?? null,
    risk_note: entry.riskNote ?? null,
    copy_mode: entry.copyMode,
    counter_mode: entry.counterMode ? 1 : 0,
    percentage: entry.percentage ?? null,
    fixed_amount: entry.fixedAmount ?? null,
    min_amount: entry.minAmount ?? null,
    max_amount: entry.maxAmount ?? null,
    filters_json: JSON.stringify({ ...DEFAULT_FILTERS, ...entry.filters }),
    priority: entry.priority,
    added_at: entry.addedAt,
    updated_at: ts,
  };
}

function fromAddressRow(row: any): FollowedAddress {
  return {
    address: row.address,
    username: row.username ?? undefined,
    nickname: row.nickname ?? undefined,
    enabled: Boolean(row.enabled),
    pauseReason: row.pause_reason ?? undefined,
    riskPausedAt: row.risk_paused_at ?? undefined,
    riskNote: row.risk_note ?? undefined,
    copyMode: row.copy_mode,
    counterMode: Boolean(row.counter_mode),
    percentage: row.percentage ?? undefined,
    fixedAmount: row.fixed_amount ?? undefined,
    minAmount: row.min_amount ?? undefined,
    maxAmount: row.max_amount ?? undefined,
    filters: parseJSON(row.filters_json, DEFAULT_FILTERS),
    priority: row.priority,
    addedAt: row.added_at,
  };
}

function fromExecutionRow(row: any): TradeExecution {
  const execution: TradeExecution = {
    id: row.id,
    timestamp: row.timestamp,
    sourceAddress: row.source_address,
    sourceUsername: row.source_username ?? undefined,
    sourceTrade: parseJSON(row.source_trade_json, {
      tokenId: "",
      conditionId: "",
      side: "BUY",
      amount: 0,
      price: 0,
      transactionHash: "",
    }),
    status: row.status,
    reason: row.reason ?? undefined,
    failureCode: row.failure_code ?? undefined,
    failureDetail: parseJSON(row.failure_detail_json, undefined),
    latencyMs: row.latency_ms ?? undefined,
  };

  if (row.executed_trade_json) {
    execution.executedTrade = parseJSON(row.executed_trade_json, undefined);
  }
  if (row.market_slug || row.market_question) {
    execution.market = {
      slug: row.market_slug ?? "",
      question: row.market_question ?? "",
    };
  }
  return execution;
}

function fromPositionRow(row: any): SourcePosition {
  return {
    sourceAddress: row.source_address,
    tokenId: row.token_id,
    conditionId: row.condition_id,
    marketSlug: row.market_slug ?? undefined,
    marketQuestion: row.market_question ?? undefined,
    netShares: row.net_shares,
    costBasisUsdc: row.cost_basis_usdc,
    realizedPnlUsdc: row.realized_pnl_usdc,
    lastPrice: row.last_price ?? undefined,
    lastValueUsdc: row.last_value_usdc ?? undefined,
    lastValuedAt: row.last_valued_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function ensureImported() {
  const imported = getMeta("legacy_json_imported");
  if (imported) return;

  withTransaction(() => {
    const db = getDb();
    const hasAnyAddress = db.prepare(`SELECT 1 FROM addresses LIMIT 1`).get();
    if (hasAnyAddress) {
      setMeta("legacy_json_imported", nowIso());
      return;
    }

    const addresses = readLegacyJson<AddressesStore>("addresses.json", { addresses: [] }).addresses;
    const history = readLegacyJson<HistoryStore>("history.json", { executions: [] }).executions;
    const state = readLegacyJson<MonitorState>("state.json", { cursors: {}, seenHashes: [] });
    const redeems = readLegacyJson<RedeemsStore>("redeems.json", { redeemed: [] }).redeemed;

    for (const address of addresses) {
      upsertAddress(address);
    }

    for (const [address, cursor] of Object.entries(state.cursors)) {
      db.prepare(`
        INSERT INTO monitor_state(state_key, json_value, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(state_key) DO UPDATE SET json_value = excluded.json_value, updated_at = excluded.updated_at
      `).run(
        `cursor:${address.toLowerCase()}`,
        JSON.stringify(cursor),
        nowIso(),
        nowIso(),
      );
    }

    for (const hash of state.seenHashes) {
      db.prepare(`
        INSERT OR IGNORE INTO monitor_state(state_key, json_value, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(
        `seen:${hash}`,
        JSON.stringify({ hash }),
        nowIso(),
        nowIso(),
      );
    }

    for (const execution of history) {
      appendExecution(execution);
    }

    for (const redeem of redeems) {
      appendRedeem(redeem);
    }

    if (state.startedAt) {
      setMeta("legacy_started_at", state.startedAt);
    }

    setMeta("legacy_json_imported", nowIso());
  });
}

ensureImported();

export function loadAddresses(): FollowedAddress[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM addresses
    ORDER BY datetime(added_at) ASC, address ASC
  `).all();
  return rows.map(fromAddressRow);
}

export function saveAddresses(addresses: FollowedAddress[]) {
  withTransaction(() => {
    const db = getDb();
    const keep = new Set(addresses.map((a) => a.address.toLowerCase()));
    for (const address of addresses) {
      upsertAddress(address);
    }
    if (keep.size === 0) {
      db.prepare(`DELETE FROM addresses`).run();
      return;
    }
    const placeholders = Array.from(keep, () => "?").join(", ");
    db.prepare(`DELETE FROM addresses WHERE address NOT IN (${placeholders})`).run(...Array.from(keep));
  });
}

export function findAddress(query: string): FollowedAddress | undefined {
  const db = getDb();
  const lower = query.toLowerCase();
  const row = db.prepare(`
    SELECT * FROM addresses
    WHERE lower(address) = ?
      OR lower(COALESCE(nickname, '')) = ?
      OR lower(COALESCE(username, '')) = ?
    LIMIT 1
  `).get(lower, lower, lower);
  return row ? fromAddressRow(row) : undefined;
}

export function upsertAddress(entry: FollowedAddress) {
  const db = getDb();
  const row = toAddressRow(entry);
  db.prepare(`
    INSERT INTO addresses (
      address, username, nickname, enabled, pause_reason, risk_paused_at, risk_note,
      copy_mode, counter_mode, percentage, fixed_amount, min_amount, max_amount,
      filters_json, priority, added_at, updated_at
    ) VALUES (
      @address, @username, @nickname, @enabled, @pause_reason, @risk_paused_at, @risk_note,
      @copy_mode, @counter_mode, @percentage, @fixed_amount, @min_amount, @max_amount,
      @filters_json, @priority, @added_at, @updated_at
    )
    ON CONFLICT(address) DO UPDATE SET
      username = excluded.username,
      nickname = excluded.nickname,
      enabled = excluded.enabled,
      pause_reason = excluded.pause_reason,
      risk_paused_at = excluded.risk_paused_at,
      risk_note = excluded.risk_note,
      copy_mode = excluded.copy_mode,
      counter_mode = excluded.counter_mode,
      percentage = excluded.percentage,
      fixed_amount = excluded.fixed_amount,
      min_amount = excluded.min_amount,
      max_amount = excluded.max_amount,
      filters_json = excluded.filters_json,
      priority = excluded.priority,
      added_at = excluded.added_at,
      updated_at = excluded.updated_at
  `).run(row);
}

export function removeAddress(addr: string): boolean {
  const db = getDb();
  const info = db.prepare(`DELETE FROM addresses WHERE lower(address) = ?`).run(addr.toLowerCase());
  return info.changes > 0;
}

export function pauseAddressForRisk(address: string, reason: string, note?: string) {
  const entry = findAddress(address);
  if (!entry) return false;
  entry.enabled = false;
  entry.pauseReason = reason;
  entry.riskPausedAt = nowIso();
  entry.riskNote = note;
  upsertAddress(entry);
  return true;
}

export function clearRiskPause(address: string) {
  const entry = findAddress(address);
  if (!entry) return false;
  entry.enabled = true;
  entry.pauseReason = undefined;
  entry.riskPausedAt = undefined;
  entry.riskNote = undefined;
  upsertAddress(entry);
  return true;
}

export function loadState(): MonitorState {
  const db = getDb();
  const cursorRows = db.prepare(`
    SELECT state_key, json_value FROM monitor_state
    WHERE state_key LIKE 'cursor:%'
  `).all() as Array<{ state_key: string; json_value: string }>;
  const seenRows = db.prepare(`
    SELECT state_key FROM monitor_state
    WHERE state_key LIKE 'seen:%'
    ORDER BY datetime(created_at) ASC
  `).all() as Array<{ state_key: string }>;

  const cursors: MonitorState["cursors"] = {};
  for (const row of cursorRows) {
    cursors[row.state_key.slice("cursor:".length)] = parseJSON(row.json_value, {
      lastSeenTimestamp: 0,
      lastActivityAt: 0,
    });
  }

  const heartbeat = getServiceHeartbeat();
  return {
    cursors,
    seenHashes: seenRows.map((row) => row.state_key.slice("seen:".length)),
    startedAt: heartbeat.startedAt,
    globalStopLatched: heartbeat.globalStopLatched,
    globalStopAt: heartbeat.globalStopAt,
    globalStopReason: heartbeat.globalStopReason,
  };
}

export function saveState(state: MonitorState) {
  withTransaction(() => {
    const db = getDb();
    db.prepare(`DELETE FROM monitor_state WHERE state_key LIKE 'cursor:%' OR state_key LIKE 'seen:%'`).run();
    const ts = nowIso();
    for (const [address, cursor] of Object.entries(state.cursors)) {
      db.prepare(`
        INSERT INTO monitor_state(state_key, json_value, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(`cursor:${address.toLowerCase()}`, JSON.stringify(cursor), ts, ts);
    }
    for (const hash of state.seenHashes) {
      db.prepare(`
        INSERT INTO monitor_state(state_key, json_value, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(`seen:${hash}`, JSON.stringify({ hash }), ts, ts);
    }
  });
}

export function markSeen(hash: string) {
  const db = getDb();
  const ts = nowIso();
  db.prepare(`
    INSERT OR IGNORE INTO monitor_state(state_key, json_value, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(`seen:${hash}`, JSON.stringify({ hash }), ts, ts);

  const row = db.prepare(`
    SELECT COUNT(*) as count FROM monitor_state WHERE state_key LIKE 'seen:%'
  `).get() as { count: number };
  if (row.count > MAX_SEEN) {
    db.prepare(`
      DELETE FROM monitor_state
      WHERE state_key IN (
        SELECT state_key FROM monitor_state
        WHERE state_key LIKE 'seen:%'
        ORDER BY datetime(created_at) ASC
        LIMIT ?
      )
    `).run(row.count - TRIMMED_SEEN);
  }
}

export function isSeen(hash: string): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT 1 FROM monitor_state WHERE state_key = ? LIMIT 1
  `).get(`seen:${hash}`);
  return Boolean(row);
}

export function updateCursor(address: string, timestamp: number) {
  const db = getDb();
  const ts = nowIso();
  db.prepare(`
    INSERT INTO monitor_state(state_key, json_value, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(state_key) DO UPDATE SET json_value = excluded.json_value, updated_at = excluded.updated_at
  `).run(
    `cursor:${address.toLowerCase()}`,
    JSON.stringify({
      lastSeenTimestamp: timestamp,
      lastActivityAt: Date.now(),
    }),
    ts,
    ts,
  );
}

export function getCursor(address: string): AddressCursor | undefined {
  const db = getDb();
  const row = db.prepare(`
    SELECT json_value FROM monitor_state WHERE state_key = ? LIMIT 1
  `).get(`cursor:${address.toLowerCase()}`) as { json_value: string } | undefined;
  return row
    ? parseJSON<AddressCursor | undefined>(row.json_value, undefined)
    : undefined;
}

export function loadHistory(): TradeExecution[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM executions
    ORDER BY datetime(timestamp) ASC, id ASC
  `).all();
  return rows.map(fromExecutionRow);
}

export function appendExecution(exec: TradeExecution) {
  const db = getDb();
  db.prepare(`
    INSERT INTO executions(
      id, timestamp, source_address, source_username, source_trade_json, executed_trade_json,
      status, reason, failure_code, failure_detail_json, latency_ms, market_slug, market_question
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      timestamp = excluded.timestamp,
      source_address = excluded.source_address,
      source_username = excluded.source_username,
      source_trade_json = excluded.source_trade_json,
      executed_trade_json = excluded.executed_trade_json,
      status = excluded.status,
      reason = excluded.reason,
      failure_code = excluded.failure_code,
      failure_detail_json = excluded.failure_detail_json,
      latency_ms = excluded.latency_ms,
      market_slug = excluded.market_slug,
      market_question = excluded.market_question
  `).run(
    exec.id,
    exec.timestamp,
    exec.sourceAddress.toLowerCase(),
    exec.sourceUsername ?? null,
    JSON.stringify(exec.sourceTrade),
    exec.executedTrade ? JSON.stringify(exec.executedTrade) : null,
    exec.status,
    exec.reason ?? null,
    exec.failureCode ?? null,
    exec.failureDetail ? JSON.stringify(exec.failureDetail) : null,
    exec.latencyMs ?? null,
    exec.market?.slug ?? null,
    exec.market?.question ?? null,
  );

  const row = db.prepare(`SELECT COUNT(*) as count FROM executions`).get() as { count: number };
  if (row.count > MAX_HISTORY) {
    db.prepare(`
      DELETE FROM executions
      WHERE id IN (
        SELECT id FROM executions
        ORDER BY datetime(timestamp) ASC, id ASC
        LIMIT ?
      )
    `).run(row.count - MAX_HISTORY);
  }

  applyExecutionToPosition(exec);
}

export function loadRedeems(): RedeemRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT condition_id, token_id, amount, tx_hash, question, timestamp
    FROM redeems
    ORDER BY datetime(timestamp) ASC, id ASC
  `).all() as Array<{
    condition_id: string;
    token_id: string;
    amount: string;
    tx_hash: string;
    question: string | null;
    timestamp: string;
  }>;
  return rows.map((row) => ({
    conditionId: row.condition_id,
    tokenId: row.token_id,
    amount: row.amount,
    txHash: row.tx_hash,
    question: row.question ?? undefined,
    timestamp: row.timestamp,
  }));
}

export function isRedeemed(conditionId: string): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT 1 FROM redeems WHERE condition_id = ? LIMIT 1
  `).get(conditionId);
  return Boolean(row);
}

export function appendRedeem(record: RedeemRecord) {
  const db = getDb();
  db.prepare(`
    INSERT INTO redeems(condition_id, token_id, amount, tx_hash, question, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    record.conditionId,
    record.tokenId,
    record.amount,
    record.txHash,
    record.question ?? null,
    record.timestamp,
  );
}

export function getLogicallyExecutedSpendForMarket(sourceAddress: string, conditionId: string): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(SUM(CAST(json_extract(executed_trade_json, '$.amount') AS REAL)), 0) as spent
    FROM executions
    WHERE lower(source_address) = ?
      AND json_extract(source_trade_json, '$.conditionId') = ?
      AND status = 'success'
  `).get(sourceAddress.toLowerCase(), conditionId) as { spent: number };
  return row.spent;
}

export function listSourcePositions(sourceAddress?: string): SourcePosition[] {
  const db = getDb();
  const rows = sourceAddress
    ? db.prepare(`
        SELECT * FROM source_positions
        WHERE lower(source_address) = ?
        ORDER BY lower(source_address), token_id
      `).all(sourceAddress.toLowerCase())
    : db.prepare(`
        SELECT * FROM source_positions
        ORDER BY lower(source_address), token_id
      `).all();
  return rows.map(fromPositionRow);
}

export function getSourcePosition(sourceAddress: string, tokenId: string): SourcePosition | undefined {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM source_positions
    WHERE lower(source_address) = ? AND token_id = ?
    LIMIT 1
  `).get(sourceAddress.toLowerCase(), tokenId);
  return row ? fromPositionRow(row) : undefined;
}

export function upsertSourcePosition(position: SourcePosition) {
  const db = getDb();
  db.prepare(`
    INSERT INTO source_positions(
      source_address, token_id, condition_id, market_slug, market_question,
      net_shares, cost_basis_usdc, realized_pnl_usdc, last_price, last_value_usdc,
      last_valued_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_address, token_id) DO UPDATE SET
      condition_id = excluded.condition_id,
      market_slug = excluded.market_slug,
      market_question = excluded.market_question,
      net_shares = excluded.net_shares,
      cost_basis_usdc = excluded.cost_basis_usdc,
      realized_pnl_usdc = excluded.realized_pnl_usdc,
      last_price = excluded.last_price,
      last_value_usdc = excluded.last_value_usdc,
      last_valued_at = excluded.last_valued_at,
      updated_at = excluded.updated_at
  `).run(
    position.sourceAddress.toLowerCase(),
    position.tokenId,
    position.conditionId,
    position.marketSlug ?? null,
    position.marketQuestion ?? null,
    position.netShares,
    position.costBasisUsdc,
    position.realizedPnlUsdc,
    position.lastPrice ?? null,
    position.lastValueUsdc ?? null,
    position.lastValuedAt ?? null,
    position.updatedAt,
  );
}

export function applyExecutionToPosition(exec: TradeExecution) {
  if (exec.status !== "success" || !exec.executedTrade) return;

  const price = exec.executedTrade.price || exec.sourceTrade.price || 0;
  const amount = exec.executedTrade.amount ?? 0;
  const side = exec.executedTrade.side.toUpperCase();
  const shares = exec.executedTrade.shares ?? (price > 0 ? amount / price : 0);
  if (shares <= 0) return;

  const current = getSourcePosition(exec.sourceAddress, exec.executedTrade.tokenId) ?? {
    sourceAddress: exec.sourceAddress,
    tokenId: exec.executedTrade.tokenId,
    conditionId: exec.sourceTrade.conditionId,
    marketSlug: exec.market?.slug,
    marketQuestion: exec.market?.question,
    netShares: 0,
    costBasisUsdc: 0,
    realizedPnlUsdc: 0,
    updatedAt: exec.timestamp,
  };

  let nextShares = current.netShares;
  let nextCost = current.costBasisUsdc;
  let nextRealized = current.realizedPnlUsdc;

  if (side === "BUY") {
    nextShares += shares;
    nextCost += amount;
  } else if (side === "SELL") {
    const sellShares = Math.min(current.netShares, shares);
    if (sellShares <= 0) return;
    const avgCostPerShare = current.netShares > 0 ? current.costBasisUsdc / current.netShares : 0;
    const removedCost = avgCostPerShare * sellShares;
    const proceeds = exec.executedTrade.proceeds ?? amount;
    nextShares = current.netShares - sellShares;
    nextCost = Math.max(0, current.costBasisUsdc - removedCost);
    nextRealized += proceeds - removedCost;
  }

  upsertSourcePosition({
    ...current,
    conditionId: exec.sourceTrade.conditionId,
    marketSlug: exec.market?.slug ?? current.marketSlug,
    marketQuestion: exec.market?.question ?? current.marketQuestion,
    netShares: nextShares,
    costBasisUsdc: nextCost,
    realizedPnlUsdc: nextRealized,
    lastPrice: price || current.lastPrice,
    lastValueUsdc: price && nextShares > 0 ? nextShares * price : current.lastValueUsdc,
    lastValuedAt: price ? nowIso() : current.lastValuedAt,
    updatedAt: nowIso(),
  });
}

export function updatePositionValuation(sourceAddress: string, tokenId: string, price: number, valueUsdc: number) {
  const current = getSourcePosition(sourceAddress, tokenId);
  if (!current) return;
  upsertSourcePosition({
    ...current,
    lastPrice: price,
    lastValueUsdc: valueUsdc,
    lastValuedAt: nowIso(),
    updatedAt: nowIso(),
  });
}

export function setSourceRiskStatus(status: SourceRiskStatus) {
  const db = getDb();
  db.prepare(`
    INSERT INTO risk_baselines(scope, ref, baseline_value, current_value, loss_pct, latched, note, data_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, ref) DO UPDATE SET
      baseline_value = excluded.baseline_value,
      current_value = excluded.current_value,
      loss_pct = excluded.loss_pct,
      latched = excluded.latched,
      note = excluded.note,
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `).run(
    "source",
    status.sourceAddress.toLowerCase(),
    status.baselineCostUsdc,
    status.currentValueUsdc,
    status.lossPct,
    status.riskPaused ? 1 : 0,
    status.note ?? null,
    JSON.stringify(status),
    nowIso(),
  );
}

export function getSourceRiskStatus(sourceAddress: string): SourceRiskStatus | undefined {
  const db = getDb();
  const row = db.prepare(`
    SELECT data_json FROM risk_baselines WHERE scope = 'source' AND ref = ?
  `).get(sourceAddress.toLowerCase()) as { data_json: string } | undefined;
  return row ? parseJSON(row.data_json, undefined) : undefined;
}

export function listSourceRiskStatuses(): SourceRiskStatus[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT data_json FROM risk_baselines WHERE scope = 'source' ORDER BY ref ASC
  `).all() as Array<{ data_json: string }>;
  return rows
    .map((row) => parseJSON<SourceRiskStatus | undefined>(row.data_json, undefined))
    .filter((row): row is SourceRiskStatus => Boolean(row));
}

export function setGlobalRiskState(state: GlobalRiskState) {
  const db = getDb();
  db.prepare(`
    INSERT INTO risk_baselines(scope, ref, baseline_value, current_value, loss_pct, latched, note, data_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, ref) DO UPDATE SET
      baseline_value = excluded.baseline_value,
      current_value = excluded.current_value,
      loss_pct = excluded.loss_pct,
      latched = excluded.latched,
      note = excluded.note,
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `).run(
    "global",
    "service",
    state.baselineEquityUsdc,
    state.currentEquityUsdc,
    state.lossPct,
    state.latched ? 1 : 0,
    state.reason ?? null,
    JSON.stringify(state),
    nowIso(),
  );
}

export function getGlobalRiskState(): GlobalRiskState {
  const db = getDb();
  const row = db.prepare(`
    SELECT data_json FROM risk_baselines WHERE scope = 'global' AND ref = 'service'
  `).get() as { data_json: string } | undefined;
  return row
    ? parseJSON(row.data_json, {
        baselineEquityUsdc: 0,
        currentEquityUsdc: 0,
        lossPct: 0,
        latched: false,
      })
    : {
        baselineEquityUsdc: 0,
        currentEquityUsdc: 0,
        lossPct: 0,
        latched: false,
      };
}

export function clearGlobalRiskLatch() {
  setGlobalRiskState({
    baselineEquityUsdc: 0,
    currentEquityUsdc: 0,
    lossPct: 0,
    latched: false,
    latchedAt: undefined,
    reason: undefined,
    lastEvaluatedAt: nowIso(),
  });
  updateServiceHeartbeat({
    status: "stopped",
    globalStopLatched: false,
    globalStopAt: undefined,
    globalStopReason: undefined,
    note: "global risk latch cleared",
  });
}

export function setGlobalRiskLatch(reason: string, currentEquityUsdc: number, baselineEquityUsdc: number) {
  const lossPct = baselineEquityUsdc > 0 ? (baselineEquityUsdc - currentEquityUsdc) / baselineEquityUsdc : 0;
  setGlobalRiskState({
    baselineEquityUsdc,
    currentEquityUsdc,
    lossPct,
    latched: true,
    latchedAt: nowIso(),
    reason,
    lastEvaluatedAt: nowIso(),
  });
  updateServiceHeartbeat({
    status: "risk_latched",
    globalStopLatched: true,
    globalStopAt: nowIso(),
    globalStopReason: reason,
    note: reason,
  });
}

export function getServiceHeartbeat(): ServiceHeartbeat {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM service_heartbeat WHERE service_name = ?
  `).get(getConfig().serviceName) as any | undefined;
  if (!row) {
    return {
      serviceName: getConfig().serviceName,
      status: "stopped",
      globalStopLatched: false,
    };
  }
  return {
    serviceName: row.service_name,
    pid: row.pid ?? undefined,
    status: row.status,
    startedAt: row.started_at ?? undefined,
    lastCycleAt: row.last_cycle_at ?? undefined,
    lastSuccessfulPollAt: row.last_successful_poll_at ?? undefined,
    lastErrorAt: row.last_error_at ?? undefined,
    lastRedeemAt: row.last_redeem_at ?? undefined,
    lastRiskCheckAt: row.last_risk_check_at ?? undefined,
    lastAlertTestAt: row.last_alert_test_at ?? undefined,
    note: row.note ?? undefined,
    globalStopLatched: Boolean(row.global_stop_latched),
    globalStopAt: row.global_stop_at ?? undefined,
    globalStopReason: row.global_stop_reason ?? undefined,
  };
}

export function updateServiceHeartbeat(patch: Partial<ServiceHeartbeat>) {
  const db = getDb();
  const current = getServiceHeartbeat();
  const next: ServiceHeartbeat = {
    ...current,
    ...patch,
    serviceName: getConfig().serviceName,
    status: patch.status ?? current.status ?? "stopped",
    globalStopLatched: patch.globalStopLatched ?? current.globalStopLatched ?? false,
  };

  db.prepare(`
    INSERT INTO service_heartbeat(
      service_name, pid, status, started_at, last_cycle_at, last_successful_poll_at,
      last_error_at, last_redeem_at, last_risk_check_at, last_alert_test_at,
      note, global_stop_latched, global_stop_at, global_stop_reason, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(service_name) DO UPDATE SET
      pid = excluded.pid,
      status = excluded.status,
      started_at = excluded.started_at,
      last_cycle_at = excluded.last_cycle_at,
      last_successful_poll_at = excluded.last_successful_poll_at,
      last_error_at = excluded.last_error_at,
      last_redeem_at = excluded.last_redeem_at,
      last_risk_check_at = excluded.last_risk_check_at,
      last_alert_test_at = excluded.last_alert_test_at,
      note = excluded.note,
      global_stop_latched = excluded.global_stop_latched,
      global_stop_at = excluded.global_stop_at,
      global_stop_reason = excluded.global_stop_reason,
      updated_at = excluded.updated_at
  `).run(
    next.serviceName,
    next.pid ?? null,
    next.status,
    next.startedAt ?? null,
    next.lastCycleAt ?? null,
    next.lastSuccessfulPollAt ?? null,
    next.lastErrorAt ?? null,
    next.lastRedeemAt ?? null,
    next.lastRiskCheckAt ?? null,
    next.lastAlertTestAt ?? null,
    next.note ?? null,
    next.globalStopLatched ? 1 : 0,
    next.globalStopAt ?? null,
    next.globalStopReason ?? null,
    nowIso(),
  );

  writeHeartbeatFile(next);
}

export function getRecentAlertEvent(alertKey: string, channel: AlertEvent["channel"]): AlertEvent | undefined {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM alert_events
    WHERE alert_key = ? AND channel = ?
    ORDER BY datetime(sent_at) DESC, id DESC
    LIMIT 1
  `).get(alertKey, channel) as any | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    alertKey: row.alert_key,
    channel: row.channel,
    severity: row.severity,
    title: row.title,
    body: row.body,
    sentAt: row.sent_at,
    dedupeUntil: row.dedupe_until ?? undefined,
    status: row.status,
    error: row.error ?? undefined,
  };
}

export function recordAlertEvent(event: AlertEvent) {
  const db = getDb();
  db.prepare(`
    INSERT INTO alert_events(
      alert_key, channel, severity, title, body, sent_at, dedupe_until, status, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.alertKey,
    event.channel,
    event.severity,
    event.title,
    event.body,
    event.sentAt ?? nowIso(),
    event.dedupeUntil ?? null,
    event.status,
    event.error ?? null,
  );
}

export function getEndpointHealth(endpoint: string): EndpointHealth {
  const db = getDb();
  const row = db.prepare(`
    SELECT json_value FROM monitor_state WHERE state_key = ? LIMIT 1
  `).get(`endpoint:${endpoint}`) as { json_value: string } | undefined;
  return row
    ? parseJSON(row.json_value, {
        endpoint,
        consecutiveFailures: 0,
        degraded: false,
      })
    : {
        endpoint,
        consecutiveFailures: 0,
        degraded: false,
      };
}

export function setEndpointHealth(health: EndpointHealth) {
  const db = getDb();
  const ts = nowIso();
  db.prepare(`
    INSERT INTO monitor_state(state_key, json_value, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(state_key) DO UPDATE SET json_value = excluded.json_value, updated_at = excluded.updated_at
  `).run(`endpoint:${health.endpoint}`, JSON.stringify(health), ts, ts);
}
