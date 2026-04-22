import { Schema, model } from "mongoose";

export const WEBHOOK_EVENTS = [
  "order.created",
  "order.paid",
  "order.cancelled",
  "order.ready",
  "customer.created",
  "inventory.low",
  "promotion.redeemed",
  "review.received",
  "anomaly.detected",
] as const;

const WebhookSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    name: { type: String, required: true },
    url: { type: String, required: true },
    events: { type: [String], default: [] },
    secret: { type: String }, // HMAC signing key (per-hook override)
    active: { type: Boolean, default: true },
    lastDeliveredAt: { type: Date },
    lastStatus: { type: Number }, // HTTP status of last attempt
    lastError: { type: String },
    failureCount: { type: Number, default: 0 },
    successCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const Webhook = model("Webhook", WebhookSchema);
