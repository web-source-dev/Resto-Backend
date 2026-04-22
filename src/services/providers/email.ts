import { env } from "../../config/env";

type Result =
  | { ok: true; id: string; provider: "smtp" | "mock" }
  | { ok: false; error: string };

let _transport: any = null;
function transport() {
  if (_transport) return _transport;
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return null;
  const nodemailer = require("nodemailer");
  _transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  return _transport;
}

export function emailConfigured() {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM);
}

export async function sendEmail(args: {
  to: string;
  subject: string;
  body: string;
  html?: string;
}): Promise<Result> {
  const t = transport();
  if (!t || !env.SMTP_FROM) {
    return { ok: true, id: `mock-email-${Date.now()}`, provider: "mock" };
  }
  try {
    const info = await t.sendMail({
      from: env.SMTP_FROM,
      to: args.to,
      subject: args.subject,
      text: args.body,
      html: args.html ?? args.body.replace(/\n/g, "<br/>"),
    });
    return { ok: true, id: info.messageId, provider: "smtp" };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function verifyEmailTransport(): Promise<{ ok: boolean; error?: string }> {
  const t = transport();
  if (!t) return { ok: false, error: "SMTP not configured" };
  try {
    await t.verify();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
