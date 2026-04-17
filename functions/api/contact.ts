/// <reference types="@cloudflare/workers-types" />

interface Env {
  RESEND_API_KEY: string;
  CONTACT_RATE_LIMIT?: KVNamespace;
  CONTACT_FROM?: string;
  CONTACT_TO?: string;
}

type Ctx = EventContext<Env, string, Record<string, unknown>>;

const DEFAULT_FROM = "Brookfield Digital <onboarding@resend.dev>";
const DEFAULT_TO = "eric@brkdllc.com";

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
  // intentionally loose; Resend will reject truly malformed addresses
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

async function readField(formData: FormData | null, body: Record<string, unknown> | null, key: string): Promise<string> {
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

export const onRequestPost = async (ctx: Ctx): Promise<Response> => {
  const { request, env } = ctx;

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

  const name = (await readField(formData, bodyJson, "name")).trim();
  const email = (await readField(formData, bodyJson, "email")).trim();
  const message = (await readField(formData, bodyJson, "message")).trim();
  const honeypot = (await readField(formData, bodyJson, "website")).trim();

  // Silent drop for bot submissions
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

  if (!env.RESEND_API_KEY) {
    return json({ error: "Email service is not configured." }, 500);
  }

  const from = env.CONTACT_FROM || DEFAULT_FROM;
  const to = env.CONTACT_TO || DEFAULT_TO;

  const subject = `Contact form: ${name}`;
  const text = `From: ${name} <${email}>\n\n${message}`;
  const html = `<p><strong>From:</strong> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</p><p style="white-space:pre-wrap">${escapeHtml(message)}</p>`;

  const resendResponse = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from,
      to,
      reply_to: email,
      subject,
      text,
      html,
    }),
  });

  if (!resendResponse.ok) {
    const detail = await resendResponse.text().catch(() => "");
    console.error("Resend error", resendResponse.status, detail);
    return json({ error: "Could not send message. Please email eric@brkdllc.com directly." }, 502);
  }

  return json({ ok: true });
};

export const onRequest = (): Response =>
  new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
