import { env } from "../../config/env";

let _client: any = null;
function client() {
  if (_client) return _client;
  if (!env.STRIPE_SECRET_KEY) return null;
  const Stripe = require("stripe");
  _client = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
  return _client;
}

export function stripeConfigured() {
  return Boolean(env.STRIPE_SECRET_KEY);
}

export function publishableKey() {
  return env.STRIPE_PUBLISHABLE_KEY ?? null;
}

export async function createPaymentIntent(args: {
  amount: number; // minor units (paisa, cents)
  currency: string;
  metadata?: Record<string, string>;
  receiptEmail?: string;
}) {
  const c = client();
  if (!c) {
    return {
      ok: true as const,
      provider: "mock" as const,
      id: `mock_pi_${Date.now()}`,
      clientSecret: `mock_secret_${Date.now()}`,
    };
  }
  try {
    const pi = await c.paymentIntents.create({
      amount: args.amount,
      currency: args.currency,
      metadata: args.metadata,
      receipt_email: args.receiptEmail,
      automatic_payment_methods: { enabled: true },
    });
    return {
      ok: true as const,
      provider: "stripe" as const,
      id: pi.id,
      clientSecret: pi.client_secret,
    };
  } catch (err: any) {
    return { ok: false as const, error: err?.message ?? String(err) };
  }
}

export async function refundPayment(paymentIntentId: string, amount?: number) {
  const c = client();
  if (!c) return { ok: true as const, provider: "mock" as const, id: `mock_re_${Date.now()}` };
  try {
    const refund = await c.refunds.create({ payment_intent: paymentIntentId, amount });
    return { ok: true as const, provider: "stripe" as const, id: refund.id };
  } catch (err: any) {
    return { ok: false as const, error: err?.message ?? String(err) };
  }
}

export async function pingStripe() {
  const c = client();
  if (!c) return { ok: false as const, error: "Stripe not configured" };
  try {
    const acct = await c.accounts.retrieve();
    return { ok: true as const, accountId: acct.id, country: acct.country };
  } catch (err: any) {
    return { ok: false as const, error: err?.message ?? String(err) };
  }
}
