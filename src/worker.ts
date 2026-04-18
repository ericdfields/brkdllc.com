/// <reference types="@cloudflare/workers-types" />

import { AwsClient } from "aws4fetch";

interface Env {
  ASSETS: Fetcher;
  AWS_SES_ACCESS_KEY_ID?: string;
  AWS_SES_SECRET_ACCESS_KEY?: string;
  AWS_SES_SESSION_TOKEN?: string;
  AWS_SES_REGION?: string;
  CONTACT_RATE_LIMIT?: KVNamespace;
  CONTACT_FROM?: string;
  CONTACT_TO?: string;
}

const DEFAULT_FROM = "Brookfield Digital <eric@brkdllc.com>";
const DEFAULT_TO = "eric@brkdllc.com";
const DEFAULT_REGION = "us-east-1";

const MAX_NAME = 200;
const MAX_EMAIL = 200;
const MAX_MESSAGE = 5000;

const RATE_WINDOW_SECONDS = 10 * 60;
const RATE_MAX = 5;

const memoryBuckets = new Map<string, number[]>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function readField(
  formData: FormData | null,
  body: Record<string, unknown> | null,
  key: string,
): string {
  if (formData) {
    const v = formData.get(key);
    return typeof v === "string" ? v : "";
  }
  if (body && typeof body[key] === "string") return body[key] as string;
  return "";
}

async function checkRateLimit(ip: string, env: Env): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - RATE_WINDOW_SECONDS;
  const key = `rl:${ip}`;

  if (env.CONTACT_RATE_LIMIT) {
    const raw = await env.CONTACT_RATE_LIMIT.get(key);
    const timestamps = (raw ? (JSON.parse(raw) as number[]) : []).filter((t) => t > cutoff);
    if (timestamps.length >= RATE_MAX) return false;
    timestamps.push(now);
    await env.CONTACT_RATE_LIMIT.put(key, JSON.stringify(timestamps), {
      expirationTtl: RATE_WINDOW_SECONDS + 60,
    });
    return true;
  }

  const existing = (memoryBuckets.get(ip) ?? []).filter((t) => t > cutoff);
  if (existing.length >= RATE_MAX) {
    memoryBuckets.set(ip, existing);
    return false;
  }
  existing.push(now);
  memoryBuckets.set(ip, existing);
  return true;
}

async function sendViaSes(
  env: Env,
  payload: { from: string; to: string; replyTo: string; subject: string; text: string; html: string },
): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
  const region = env.AWS_SES_REGION || DEFAULT_REGION;
  const client = new AwsClient({
    accessKeyId: env.AWS_SES_ACCESS_KEY_ID as string,
    secretAccessKey: env.AWS_SES_SECRET_ACCESS_KEY as string,
    sessionToken: env.AWS_SES_SESSION_TOKEN,
    service: "ses",
    region,
  });

  const body = JSON.stringify({
    FromEmailAddress: payload.from,
    Destination: { ToAddresses: [payload.to] },
    ReplyToAddresses: [payload.replyTo],
    Content: {
      Simple: {
        Subject: { Data: payload.subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: payload.text, Charset: "UTF-8" },
          Html: { Data: payload.html, Charset: "UTF-8" },
        },
      },
    },
  });

  const url = `https://email.${region}.amazonaws.com/v2/email/outbound-emails`;
  const response = await client.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

  if (response.ok) return { ok: true };
  const detail = await response.text().catch(() => "");
  return { ok: false, status: response.status, detail };
}

async function handleContact(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }

  let formData: FormData | null = null;
  let bodyJson: Record<string, unknown> | null = null;
  const contentType = request.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      bodyJson = (await request.json()) as Record<string, unknown>;
    } else {
      formData = await request.formData();
    }
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  const name = readField(formData, bodyJson, "name").trim();
  const email = readField(formData, bodyJson, "email").trim();
  const message = readField(formData, bodyJson, "message").trim();
  const honeypot = readField(formData, bodyJson, "website").trim();

  if (honeypot.length > 0) {
    return json({ ok: true });
  }

  if (!name || name.length > MAX_NAME) {
    return json({ error: "Please provide your name." }, 400);
  }
  if (!email || email.length > MAX_EMAIL || !isEmail(email)) {
    return json({ error: "Please provide a valid email address." }, 400);
  }
  if (!message || message.length > MAX_MESSAGE) {
    return json({ error: "Please include a message (up to 5000 characters)." }, 400);
  }

  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";

  const allowed = await checkRateLimit(ip, env);
  if (!allowed) {
    return json({ error: "Too many submissions. Please try again in a few minutes." }, 429);
  }

  if (!env.AWS_SES_ACCESS_KEY_ID || !env.AWS_SES_SECRET_ACCESS_KEY) {
    return json({ error: "Email service is not configured." }, 500);
  }

  const from = env.CONTACT_FROM || DEFAULT_FROM;
  const to = env.CONTACT_TO || DEFAULT_TO;
  const subject = `Contact form: ${name}`;
  const text = `From: ${name} <${email}>\n\n${message}`;
  const html = `<p><strong>From:</strong> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</p><p style="white-space:pre-wrap">${escapeHtml(message)}</p>`;

  const result = await sendViaSes(env, { from, to, replyTo: email, subject, text, html });
  if (!result.ok) {
    console.error("SES send failed", result.status, result.detail);
    return json({ error: "Could not send message. Please email eric@brkdllc.com directly." }, 502);
  }

  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/contact") {
      return handleContact(request, env);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
