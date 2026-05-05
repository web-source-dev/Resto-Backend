import crypto from "crypto";
import axios from "axios";
import { Webhook } from "../models/Webhook";
import { env } from "../config/env";

export type WebhookEvent =
  | "order.created"
  | "order.paid"
  | "order.cancelled"
  | "order.ready"
  | "customer.created"
  | "inventory.low"
  | "promotion.redeemed"
  | "review.received"
  | "anomaly.detected";

function sign(secret: string, body: string) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

async function deliverOne(hook: any, event: WebhookEvent, payload: any) {
  const ts = Date.now().toString();
  const body = JSON.stringify({ event, ts, outletId: String(hook.outletId), data: payload });
  const signingSecret = hook.secret || env.WEBHOOK_SIGNING_SECRET;
  const sig = sign(signingSecret, `${ts}.${body}`);
  try {
    const r = await axios.post(hook.url, body, {
      timeout: env.WEBHOOK_TIMEOUT_MS,
      headers: {
        "Content-Type": "application/json",
        "X-Dinova-Event": event,
        "X-Dinova-Timestamp": ts,
        "X-Dinova-Signature": `t=${ts},v1=${sig}`,
      },
      validateStatus: () => true,
    });
    const ok = r.status >= 200 && r.status < 300;
    await Webhook.updateOne(
      { _id: hook._id },
      {
        lastDeliveredAt: new Date(),
        lastStatus: r.status,
        lastError: ok ? null : `HTTP ${r.status}`,
        $inc: ok ? { successCount: 1 } : { failureCount: 1 },
      }
    );
    return { ok, status: r.status };
  } catch (err: any) {
    await Webhook.updateOne(
      { _id: hook._id },
      {
        lastDeliveredAt: new Date(),
        lastStatus: 0,
        lastError: err?.message ?? String(err),
        $inc: { failureCount: 1 },
      }
    );
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function dispatchWebhook(
  outletId: string,
  event: WebhookEvent,
  payload: any
) {
  const hooks = await Webhook.find({
    outletId,
    active: true,
    events: event,
  });
  // Fire in parallel; don't block the caller
  for (const hook of hooks) {
    deliverOne(hook, event, payload).catch((err) =>
      console.error("[webhook]", hook.name, err)
    );
  }
}

export async function testDeliver(hookId: string) {
  const hook = await Webhook.findById(hookId);
  if (!hook) return { ok: false, error: "Not found" };
  return deliverOne(hook, "order.created", {
    test: true,
    message: "This is a test delivery from Dinova settings.",
    at: new Date().toISOString(),
  });
}
