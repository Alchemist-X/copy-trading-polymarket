import type { ClobClient } from "@polymarket/clob-client";
import { ethers } from "ethers";
import type { MonitorConfig, RedeemRecord } from "../types/index.js";
import { loadHistory, isRedeemed, appendRedeem } from "../lib/store.js";
import { log } from "../lib/logger.js";

const POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CTF_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
];

const NOTIF_TYPE_MARKET_RESOLVED = 4;

export interface RedeemEvent {
  conditionId: string;
  question: string;
  amount: string;
  txHash: string;
}

export type RedeemCallback = (event: RedeemEvent) => void;

export class AutoRedeemer {
  private client: ClobClient;
  private config: MonitorConfig;
  private privateKey: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners: RedeemCallback[] = [];
  private running = false;

  constructor(client: ClobClient, config: MonitorConfig, privateKey: string) {
    this.client = client;
    this.config = config;
    this.privateKey = privateKey;
  }

  onRedeem(cb: RedeemCallback) { this.listeners.push(cb); }

  private emit(event: RedeemEvent) {
    for (const cb of this.listeners) { try { cb(event); } catch {} }
  }

  start() {
    if (this.running) return;
    this.running = true;
    log("info", "AutoRedeemer started");
    this.tick();
    this.timer = setInterval(() => this.tick(), this.config.redeemIntervalMs);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.running = false;
  }

  private async tick() {
    try {
      await this.checkNotifications();
      await this.scanHistory();
    } catch (err: any) {
      log("error", `AutoRedeemer tick error: ${err.message}`);
    }
  }

  private async checkNotifications() {
    let notifications: any[];
    try {
      notifications = await (this.client as any).getNotifications();
    } catch {
      return;
    }
    if (!Array.isArray(notifications)) return;

    const resolved = notifications.filter((n: any) => n.type === NOTIF_TYPE_MARKET_RESOLVED);
    const processedIds: string[] = [];

    for (const n of resolved) {
      const conditionId = n.payload?.condition_id ?? n.payload?.market ?? n.market;
      if (!conditionId) continue;
      if (isRedeemed(conditionId)) { processedIds.push(n.id); continue; }
      await this.tryRedeem(conditionId);
      processedIds.push(n.id);
    }

    if (processedIds.length > 0) {
      try { await (this.client as any).dropNotifications({ ids: processedIds }); } catch {}
    }
  }

  private async scanHistory() {
    const history = loadHistory();
    const conditionIds = new Set<string>();
    const questionMap = new Map<string, string>();

    for (const exec of history) {
      if (exec.status !== "success") continue;
      const cid = exec.sourceTrade.conditionId;
      if (!cid || isRedeemed(cid)) continue;
      conditionIds.add(cid);
      if (exec.market?.question) questionMap.set(cid, exec.market.question);
    }

    for (const cid of conditionIds) {
      const resolved = await this.isMarketResolved(cid);
      if (resolved) await this.tryRedeem(cid, questionMap.get(cid));
    }
  }

  private async isMarketResolved(conditionId: string): Promise<boolean> {
    try {
      const res = await fetch(`https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`);
      if (!res.ok) return false;
      const data: any[] = await res.json();
      if (!data.length) return false;
      return data[0].resolved === true || data[0].closed === true;
    } catch {
      return false;
    }
  }

  private async tryRedeem(conditionId: string, question?: string) {
    if (isRedeemed(conditionId)) return;

    let tokenIds: string[] = [];
    let marketQuestion = question ?? "";
    try {
      const res = await fetch(`https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`);
      if (res.ok) {
        const data: any[] = await res.json();
        if (data.length) {
          const m = data[0];
          marketQuestion = marketQuestion || m.question || "";
          const ids = m.clobTokenIds;
          if (Array.isArray(ids)) tokenIds = ids;
          else if (typeof ids === "string") { try { tokenIds = JSON.parse(ids); } catch {} }
        }
      }
    } catch {}

    let hasBalance = false;
    for (const tid of tokenIds) {
      try {
        const bal = await (this.client as any).getBalanceAllowance({
          asset_type: "CONDITIONAL",
          token_id: tid,
        });
        if (bal && parseFloat(bal.balance ?? "0") > 0) {
          hasBalance = true;
          break;
        }
      } catch {}
    }
    if (!hasBalance) {
      log("debug", `No balance for condition ${conditionId.slice(0, 10)}..., skipping redeem`);
      return;
    }

    if (this.config.dryRun) {
      log("info", `[DRY RUN] Would redeem condition ${conditionId.slice(0, 10)}... "${marketQuestion.slice(0, 40)}"`);
      const record: RedeemRecord = {
        conditionId,
        tokenId: tokenIds[0] ?? "",
        amount: "0",
        txHash: "dry-run",
        question: marketQuestion,
        timestamp: new Date().toISOString(),
      };
      appendRedeem(record);
      this.emit({ conditionId, question: marketQuestion, amount: "0", txHash: "dry-run" });
      return;
    }

    try {
      const provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);
      const signer = new ethers.Wallet(this.privateKey, provider);
      const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, signer);

      log("info", `Redeeming condition ${conditionId.slice(0, 10)}... "${marketQuestion.slice(0, 40)}"`);

      const tx = await ctf.redeemPositions(
        USDC_ADDRESS,
        ethers.constants.HashZero,
        conditionId,
        [1, 2],
      );
      const receipt = await tx.wait();
      const txHash = receipt.transactionHash;

      const record: RedeemRecord = {
        conditionId,
        tokenId: tokenIds[0] ?? "",
        amount: "redeemed",
        txHash,
        question: marketQuestion,
        timestamp: new Date().toISOString(),
      };
      appendRedeem(record);
      log("info", `Redeemed condition ${conditionId.slice(0, 10)}... tx: ${txHash}`);
      this.emit({ conditionId, question: marketQuestion, amount: "redeemed", txHash });
    } catch (err: any) {
      log("error", `Redeem failed for ${conditionId.slice(0, 10)}...: ${err.message}`);
    }
  }
}
