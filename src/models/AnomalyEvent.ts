import { Schema, model } from "mongoose";

const AnomalyEventSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    ruleId: { type: Schema.Types.ObjectId, ref: "AnomalyRule" },
    ruleName: String,
    metric: String,
    title: String,
    body: String,
    severity: {
      type: String,
      enum: ["info", "warn", "error"],
      default: "warn",
    },
    observed: Number,
    baseline: Number,
    deviationPct: Number,
    detectedAt: { type: Date, default: Date.now, index: true },
    resolved: { type: Boolean, default: false, index: true },
    resolvedAt: Date,
    resolvedByUserId: { type: Schema.Types.ObjectId, ref: "User" },
    link: String,
  },
  { timestamps: true }
);

AnomalyEventSchema.index({ outletId: 1, resolved: 1, detectedAt: -1 });

export const AnomalyEvent = model("AnomalyEvent", AnomalyEventSchema);
