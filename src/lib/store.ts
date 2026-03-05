import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type {
  AddressesStore,
  HistoryStore,
  MonitorState,
  FollowedAddress,
  TradeExecution,
} from "../types/index.js";

const DATA_DIR = join(process.cwd(), "data");

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function readJSON<T>(file: string, fallback: T): T {
  const path = join(DATA_DIR, file);
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJSON<T>(file: string, data: T) {
  ensureDir();
  writeFileSync(join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// ---------- Addresses ----------

export function loadAddresses(): FollowedAddress[] {
  return readJSON<AddressesStore>("addresses.json", { addresses: [] }).addresses;
}

export function saveAddresses(addresses: FollowedAddress[]) {
  writeJSON<AddressesStore>("addresses.json", { addresses });
}

export function findAddress(query: string): FollowedAddress | undefined {
  const all = loadAddresses();
  const lower = query.toLowerCase();
  return all.find(
    (a) =>
      a.address.toLowerCase() === lower ||
      a.nickname?.toLowerCase() === lower ||
      a.username?.toLowerCase() === lower,
  );
}

export function upsertAddress(entry: FollowedAddress) {
  const all = loadAddresses();
  const idx = all.findIndex(
    (a) => a.address.toLowerCase() === entry.address.toLowerCase(),
  );
  if (idx >= 0) all[idx] = entry;
  else all.push(entry);
  saveAddresses(all);
}

export function removeAddress(addr: string): boolean {
  const all = loadAddresses();
  const lower = addr.toLowerCase();
  const filtered = all.filter((a) => a.address.toLowerCase() !== lower);
  if (filtered.length === all.length) return false;
  saveAddresses(filtered);
  return true;
}

// ---------- State ----------

export function loadState(): MonitorState {
  return readJSON<MonitorState>("state.json", {
    cursors: {},
    seenHashes: [],
  });
}

export function saveState(state: MonitorState) {
  writeJSON("state.json", state);
}

export function markSeen(hash: string) {
  const state = loadState();
  if (!state.seenHashes.includes(hash)) {
    state.seenHashes.push(hash);
    if (state.seenHashes.length > 50_000) {
      state.seenHashes = state.seenHashes.slice(-30_000);
    }
    saveState(state);
  }
}

export function isSeen(hash: string): boolean {
  return loadState().seenHashes.includes(hash);
}

export function updateCursor(address: string, timestamp: number) {
  const state = loadState();
  state.cursors[address.toLowerCase()] = {
    lastSeenTimestamp: timestamp,
    lastActivityAt: Date.now(),
  };
  saveState(state);
}

export function getCursor(address: string) {
  return loadState().cursors[address.toLowerCase()];
}

// ---------- History ----------

const MAX_HISTORY = 10_000;

export function loadHistory(): TradeExecution[] {
  return readJSON<HistoryStore>("history.json", { executions: [] }).executions;
}

export function appendExecution(exec: TradeExecution) {
  const store = readJSON<HistoryStore>("history.json", { executions: [] });
  store.executions.push(exec);
  if (store.executions.length > MAX_HISTORY) {
    store.executions = store.executions.slice(-MAX_HISTORY);
  }
  writeJSON("history.json", store);
}
