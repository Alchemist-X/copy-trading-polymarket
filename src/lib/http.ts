import { sendAlert } from "./alerts.js";
import { getConfig } from "./config.js";
import { getEndpointHealth, setEndpointHealth } from "./store.js";

export class HttpError extends Error {
  status?: number;
  body?: string;
  endpoint: string;

  constructor(endpoint: string, message: string, status?: number, body?: string) {
    super(message);
    this.name = "HttpError";
    this.endpoint = endpoint;
    this.status = status;
    this.body = body;
  }
}

export interface RequestPolicy {
  endpoint: string;
  timeoutMs: number;
  retries: number;
}

function isRetryableStatus(status: number) {
  return status === 429 || status >= 500;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function recordFailure(endpoint: string, error: string) {
  const health = getEndpointHealth(endpoint);
  const next = {
    endpoint,
    consecutiveFailures: health.consecutiveFailures + 1,
    degraded: health.degraded || health.consecutiveFailures + 1 >= 3,
    lastErrorAt: new Date().toISOString(),
    lastSuccessAt: health.lastSuccessAt,
    lastError: error,
  };
  setEndpointHealth(next);

  if (!health.degraded && next.degraded) {
    await sendAlert({
      key: `endpoint:degraded:${endpoint}`,
      severity: "warn",
      title: `Endpoint degraded: ${endpoint}`,
      body: `Consecutive failures: ${next.consecutiveFailures}\nLast error: ${error}`,
    });
  }
}

async function recordSuccess(endpoint: string) {
  const health = getEndpointHealth(endpoint);
  setEndpointHealth({
    endpoint,
    consecutiveFailures: 0,
    degraded: false,
    lastErrorAt: health.lastErrorAt,
    lastSuccessAt: new Date().toISOString(),
    lastError: health.lastError,
  });

  if (health.degraded) {
    await sendAlert({
      key: `endpoint:recovered:${endpoint}`,
      severity: "info",
      title: `Endpoint recovered: ${endpoint}`,
      body: `Requests to ${endpoint} recovered at ${new Date().toISOString()}`,
    });
  }
}

async function fetchWithTimeout(url: string, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function requestJson<T>(url: string, policy: RequestPolicy, init?: RequestInit): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= policy.retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, init, policy.timeoutMs);
      if (!res.ok) {
        const body = await res.text();
        const err = new HttpError(policy.endpoint, `${policy.endpoint} ${res.status}: ${res.statusText}`, res.status, body);
        if (!isRetryableStatus(res.status) || attempt === policy.retries) throw err;
        lastError = err;
      } else {
        const data = await res.json() as T;
        await recordSuccess(policy.endpoint);
        return data;
      }
    } catch (err: any) {
      lastError = err;
      const status = err instanceof HttpError ? err.status : undefined;
      if (status && !isRetryableStatus(status)) {
        await recordFailure(policy.endpoint, err.message ?? String(err));
        throw err;
      }
      if (attempt === policy.retries) {
        await recordFailure(policy.endpoint, err.message ?? String(err));
        throw err;
      }
    }

    const jitter = Math.floor(Math.random() * 250);
    await sleep(250 * (attempt + 1) + jitter);
  }

  await recordFailure(policy.endpoint, String(lastError));
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function requestOk(url: string, policy: RequestPolicy, init?: RequestInit): Promise<void> {
  await requestJson(url, policy, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

export function pollPolicy(endpoint: string): RequestPolicy {
  const cfg = getConfig();
  return {
    endpoint,
    timeoutMs: cfg.pollTimeoutMs,
    retries: cfg.pollRetries,
  };
}

export function apiPolicy(endpoint: string): RequestPolicy {
  const cfg = getConfig();
  return {
    endpoint,
    timeoutMs: cfg.apiTimeoutMs,
    retries: cfg.apiRetries,
  };
}

export function pricePolicy(endpoint: string): RequestPolicy {
  const cfg = getConfig();
  return {
    endpoint,
    timeoutMs: cfg.priceTimeoutMs,
    retries: cfg.priceRetries,
  };
}
