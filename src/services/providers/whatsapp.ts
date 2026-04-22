import { env } from "../../config/env";

type Result = { ok: true; id: string; provider: "twilio" | "mock" } | { ok: false; error: string };

let _client: any = null;
function client() {
  if (_client) return _client;
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return null;
  const twilio = require("twilio");
  _client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  return _client;
}

export function whatsappConfigured() {
  return Boolean(
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM
  );
}

export async function sendWhatsapp(to: string, body: string): Promise<Result> {
  const c = client();
  if (!c || !env.TWILIO_WHATSAPP_FROM) {
    return { ok: true, id: `mock-wa-${Date.now()}`, provider: "mock" };
  }
  const normalizedTo = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
  try {
    const msg = await c.messages.create({
      to: normalizedTo,
      from: env.TWILIO_WHATSAPP_FROM,
      body,
    });
    return { ok: true, id: msg.sid, provider: "twilio" };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
