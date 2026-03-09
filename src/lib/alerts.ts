import nodemailer from "nodemailer";
import { getConfig } from "./config.js";
import { getRecentAlertEvent, recordAlertEvent, updateServiceHeartbeat } from "./store.js";
import type { AlertEvent } from "../types/index.js";

export interface AlertRequest {
  key: string;
  severity: AlertEvent["severity"];
  title: string;
  body: string;
  cooldownMs?: number;
}

function canSendTelegram() {
  const cfg = getConfig();
  return Boolean(cfg.telegramBotToken && cfg.telegramChatId);
}

function canSendEmail() {
  const cfg = getConfig();
  return Boolean(cfg.alertEmailTo && cfg.smtpHost && cfg.smtpUser && cfg.smtpPass);
}

function dedupeUntil(cooldownMs: number): string {
  return new Date(Date.now() + cooldownMs).toISOString();
}

function shouldSend(channel: AlertEvent["channel"], key: string): boolean {
  const last = getRecentAlertEvent(key, channel);
  if (!last?.dedupeUntil) return true;
  return new Date(last.dedupeUntil).getTime() <= Date.now();
}

async function sendTelegram(title: string, body: string) {
  const cfg = getConfig();
  if (!cfg.telegramBotToken || !cfg.telegramChatId) {
    throw new Error("telegram not configured");
  }
  const res = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: cfg.telegramChatId,
      text: `*${title.replace(/\*/g, "")}*\n${body}`,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`telegram ${res.status}: ${await res.text()}`);
  }
}

let transporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (transporter) return transporter;
  const cfg = getConfig();
  if (!cfg.smtpHost || !cfg.smtpUser || !cfg.smtpPass) {
    throw new Error("smtp not configured");
  }
  transporter = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpSecure,
    auth: {
      user: cfg.smtpUser,
      pass: cfg.smtpPass,
    },
  });
  return transporter;
}

async function sendEmail(title: string, body: string) {
  const cfg = getConfig();
  if (!cfg.alertEmailTo) {
    throw new Error("email recipient not configured");
  }
  await getTransporter().sendMail({
    from: cfg.alertEmailFrom ?? cfg.smtpUser,
    to: cfg.alertEmailTo,
    subject: `[copy-trade] ${title}`,
    text: body,
  });
}

async function sendPerChannel(channel: AlertEvent["channel"], req: AlertRequest, configured: boolean) {
  const cooldownMs = req.cooldownMs ?? getConfig().alertCooldownMs;
  if (!configured) {
    recordAlertEvent({
      alertKey: req.key,
      channel,
      severity: req.severity,
      title: req.title,
      body: req.body,
      sentAt: new Date().toISOString(),
      status: "skipped",
      error: `${channel} not configured`,
    });
    return { channel, status: "skipped" as const };
  }

  if (!shouldSend(channel, req.key)) {
    recordAlertEvent({
      alertKey: req.key,
      channel,
      severity: req.severity,
      title: req.title,
      body: req.body,
      sentAt: new Date().toISOString(),
      dedupeUntil: getRecentAlertEvent(req.key, channel)?.dedupeUntil,
      status: "skipped",
      error: "cooldown active",
    });
    return { channel, status: "skipped" as const };
  }

  try {
    if (channel === "telegram") await sendTelegram(req.title, req.body);
    else await sendEmail(req.title, req.body);
    recordAlertEvent({
      alertKey: req.key,
      channel,
      severity: req.severity,
      title: req.title,
      body: req.body,
      sentAt: new Date().toISOString(),
      dedupeUntil: dedupeUntil(cooldownMs),
      status: "sent",
    });
    return { channel, status: "sent" as const };
  } catch (err: any) {
    recordAlertEvent({
      alertKey: req.key,
      channel,
      severity: req.severity,
      title: req.title,
      body: req.body,
      sentAt: new Date().toISOString(),
      status: "failed",
      error: err.message ?? String(err),
    });
    return { channel, status: "failed" as const, error: err.message ?? String(err) };
  }
}

export async function sendAlert(req: AlertRequest) {
  const results = await Promise.all([
    sendPerChannel("telegram", req, canSendTelegram()),
    sendPerChannel("email", req, canSendEmail()),
  ]);
  return results;
}

export async function testAlerts() {
  const results = await sendAlert({
    key: "alerts:test",
    severity: "info",
    title: "Alert test",
    body: `Test alert sent at ${new Date().toISOString()}`,
    cooldownMs: 0,
  });
  updateServiceHeartbeat({
    lastAlertTestAt: new Date().toISOString(),
    note: "alert test executed",
  });
  return results;
}
