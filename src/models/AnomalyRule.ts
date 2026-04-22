import { Schema, model } from "mongoose";

export const ANOMALY_METRICS = [
  "revenue",
  "food-cost-pct",
  "wastage",
  "order-volume",
  "delivery-fail-rate",
  "ots-minutes",
] as const;

const AnomalyRuleSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    name: { type: String, required: true },
    metric: { type: String, enum: ANOMALY_METRICS, required: true },
    compareTo: {
      type: String,
      enum: ["same-weekday", "trailing-7d", "trailing-30d"],
      default: "same-weekday",
    },
    deviationPct: { type: Number, required: true }, // e.g. 20 = fire if off by ≥20%
    severity: {
      type: String,
      enum: ["info", "warn", "error"],
      default: "warn",
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const AnomalyRule = model("AnomalyRule", AnomalyRuleSchema);
