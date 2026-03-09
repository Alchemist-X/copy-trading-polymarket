import dotenv from "dotenv";
import { Wallet } from "ethers";
import { dirname, resolve } from "path";

dotenv.config({ path: ".env" });

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function optional(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

export interface AppConfig {
  privateKey: string;
  funderAddress: string;
  signatureType: number;
  eoaAddress: string;
  clobHost: string;
  dataApiUrl: string;
  gammaApiUrl: string;
  polygonRpcUrl: string;
  databasePath: string;
  heartbeatFile?: string;
  serviceName: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  alertEmailTo?: string;
  alertEmailFrom?: string;
  smtpHost?: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser?: string;
  smtpPass?: string;
  riskSourceStopPct: number;
  riskGlobalStopPct: number;
  lowUsdcAlertThreshold: number;
  alertCooldownMs: number;
  pollTimeoutMs: number;
  pollRetries: number;
  apiTimeoutMs: number;
  apiRetries: number;
  priceTimeoutMs: number;
  priceRetries: number;
}

let cachedConfig: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  const privateKey = process.env.PRIVATE_KEY ?? "";
  const funderAddress = process.env.FUNDER_ADDRESS ?? "";
  const signatureType = num("SIGNATURE_TYPE", 1);
  const eoaAddress = privateKey ? new Wallet(privateKey).address : "";
  const databasePath = resolve(process.env.DB_PATH ?? "data/copy-trade.db");
  const heartbeatFile = optional("HEARTBEAT_FILE");

  cachedConfig = {
    privateKey,
    funderAddress,
    signatureType,
    eoaAddress,
    clobHost: process.env.CLOB_HOST ?? "https://clob.polymarket.com",
    dataApiUrl: process.env.DATA_API_URL ?? "https://data-api.polymarket.com",
    gammaApiUrl: process.env.GAMMA_API_URL ?? "https://gamma-api.polymarket.com",
    polygonRpcUrl: process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com",
    databasePath,
    heartbeatFile,
    serviceName: process.env.SERVICE_NAME ?? "copy-trade",
    telegramBotToken: optional("TG_BOT_TOKEN"),
    telegramChatId: optional("TG_CHAT_ID"),
    alertEmailTo: optional("ALERT_EMAIL_TO"),
    alertEmailFrom: optional("ALERT_EMAIL_FROM"),
    smtpHost: optional("SMTP_HOST"),
    smtpPort: num("SMTP_PORT", 587),
    smtpSecure: bool("SMTP_SECURE", false),
    smtpUser: optional("SMTP_USER"),
    smtpPass: optional("SMTP_PASS"),
    riskSourceStopPct: num("RISK_SOURCE_STOP_PCT", 0.2),
    riskGlobalStopPct: num("RISK_GLOBAL_STOP_PCT", 0.3),
    lowUsdcAlertThreshold: num("LOW_USDC_ALERT_THRESHOLD", 25),
    alertCooldownMs: num("ALERT_COOLDOWN_MS", 15 * 60 * 1000),
    pollTimeoutMs: num("POLL_TIMEOUT_MS", 5_000),
    pollRetries: num("POLL_RETRIES", 2),
    apiTimeoutMs: num("API_TIMEOUT_MS", 5_000),
    apiRetries: num("API_RETRIES", 1),
    priceTimeoutMs: num("PRICE_TIMEOUT_MS", 3_000),
    priceRetries: num("PRICE_RETRIES", 1),
  };

  return cachedConfig;
}

export function getRequiredClientConfig() {
  const cfg = getConfig();
  if (!cfg.privateKey || !cfg.funderAddress) {
    console.error("Missing PRIVATE_KEY or FUNDER_ADDRESS in .env");
    process.exit(1);
  }
  return cfg;
}

export function ensureDataDir(): string {
  return dirname(getConfig().databasePath);
}
