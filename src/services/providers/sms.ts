import { env } from "../../config/env";

type SmsResult = { ok: true; id: string; provider: "twilio" | "mock" } | { ok: false; error: string };

let _client: any = null;
function client() {
  if (_client) return _client;
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return null;
  // Lazy require — package exists but only loads when configured
  const twilio = require("twilio");
  _client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  return _client;
}

export function smsConfigured() {
  return Boolean(
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_SMS_FROM
  );
}

export async function sendSms(to: string, body: string): Promise<SmsResult> {
  const c = client();
  if (!c || !env.TWILIO_SMS_FROM) {
    return { ok: true, id: `mock-sms-${Date.now()}`, provider: "mock" };
  }
  try {
    const msg = await c.messages.create({ to, from: env.TWILIO_SMS_FROM, body });
    return { ok: true, id: msg.sid, provider: "twilio" };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
