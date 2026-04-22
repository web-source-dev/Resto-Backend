import { Schema, model } from "mongoose";

export const PRICING_RULE_TYPES = [
  "happy-hour",
  "weekend-surcharge",
  "delivery-markup",
] as const;
export type PricingRuleType = (typeof PRICING_RULE_TYPES)[number];

const PricingRuleSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    name: { type: String, required: true },
    type: { type: String, enum: PRICING_RULE_TYPES, required: true },
    // adjustmentPct: negative for discount (e.g., -15), positive for surcharge
    adjustmentPct: { type: Number, required: true },
    // 0=Sun … 6=Sat; empty means "every day"
    daysOfWeek: { type: [Number], default: [] },
    // "HH:mm" strings, local time of the outlet; empty means "whole day"
    startTime: String,
    endTime: String,
    // Optional category or channel restriction
    categoryId: { type: Schema.Types.ObjectId, ref: "Category" },
    channel: {
      type: String,
      enum: ["Dine-in", "Takeaway", "Delivery", "Phone"],
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const PricingRule = model("PricingRule", PricingRuleSchema);
