import { Schema, model } from "mongoose";

export const TEMPLATE_CHANNELS = ["SMS", "Email", "WhatsApp", "Push"] as const;

export const TEMPLATE_EVENTS = [
  "order.ready",
  "order.delivered",
  "order.confirmed",
  "waitlist.ready",
  "review.request",
  "campaign.promo",
  "custom",
] as const;

const NotificationTemplateSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    name: { type: String, required: true },
    channel: { type: String, enum: TEMPLATE_CHANNELS, required: true },
    event: { type: String, enum: TEMPLATE_EVENTS, default: "custom" },
    subject: String, // email-only
    body: { type: String, required: true }, // supports {{customerName}} {{orderCode}} etc.
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

NotificationTemplateSchema.index({ outletId: 1, channel: 1, event: 1 });

export const NotificationTemplate = model(
  "NotificationTemplate",
  NotificationTemplateSchema
);
