import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { getConfig, ensureDataDir } from "./config.js";

let db: Database.Database | null = null;

function initSchema(conn: Database.Database) {
  conn.pragma("journal_mode = WAL");
  conn.pragma("synchronous = NORMAL");
  conn.pragma("foreign_keys = ON");

  conn.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS addresses (
      address TEXT PRIMARY KEY,
      username TEXT,
      nickname TEXT,
      enabled INTEGER NOT NULL,
      pause_reason TEXT,
      risk_paused_at TEXT,
      risk_note TEXT,
      copy_mode TEXT NOT NULL,
      counter_mode INTEGER NOT NULL,
      percentage REAL,
      fixed_amount REAL,
      min_amount REAL,
      max_amount REAL,
      filters_json TEXT NOT NULL,
      priority TEXT NOT NULL,
      added_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS monitor_state (
      state_key TEXT PRIMARY KEY,
      json_value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      source_address TEXT NOT NULL,
      source_username TEXT,
      source_trade_json TEXT NOT NULL,
      executed_trade_json TEXT,
      status TEXT NOT NULL,
      reason TEXT,
      failure_code TEXT,
      failure_detail_json TEXT,
      latency_ms INTEGER,
      market_slug TEXT,
      market_question TEXT
    );

    CREATE TABLE IF NOT EXISTS redeems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      condition_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      amount TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      question TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_positions (
      source_address TEXT NOT NULL,
      token_id TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      market_slug TEXT,
      market_question TEXT,
      net_shares REAL NOT NULL,
      cost_basis_usdc REAL NOT NULL,
      realized_pnl_usdc REAL NOT NULL,
      last_price REAL,
      last_value_usdc REAL,
      last_valued_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source_address, token_id)
    );

    CREATE TABLE IF NOT EXISTS risk_baselines (
      scope TEXT NOT NULL,
      ref TEXT NOT NULL,
      baseline_value REAL NOT NULL,
      current_value REAL NOT NULL,
      loss_pct REAL NOT NULL,
      latched INTEGER NOT NULL,
      note TEXT,
      data_json TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope, ref)
    );

    CREATE TABLE IF NOT EXISTS service_heartbeat (
      service_name TEXT PRIMARY KEY,
      pid INTEGER,
      status TEXT NOT NULL,
      started_at TEXT,
      last_cycle_at TEXT,
      last_successful_poll_at TEXT,
      last_error_at TEXT,
      last_redeem_at TEXT,
      last_risk_check_at TEXT,
      last_alert_test_at TEXT,
      note TEXT,
      global_stop_latched INTEGER NOT NULL,
      global_stop_at TEXT,
      global_stop_reason TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      dedupe_until TEXT,
      status TEXT NOT NULL,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_monitor_state_created_at ON monitor_state(created_at);
    CREATE INDEX IF NOT EXISTS idx_executions_timestamp ON executions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_executions_source ON executions(source_address, timestamp);
    CREATE INDEX IF NOT EXISTS idx_redeems_condition ON redeems(condition_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_source_positions_source ON source_positions(source_address);
    CREATE INDEX IF NOT EXISTS idx_alert_events_lookup ON alert_events(alert_key, channel, sent_at);
  `);
}

export function getDb(): Database.Database {
  if (db) return db;

  const cfg = getConfig();
  const dir = ensureDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new Database(cfg.databasePath);
  initSchema(db);
  return db;
}

export function withTransaction<T>(fn: () => T): T {
  const conn = getDb();
  return conn.transaction(fn)();
}
