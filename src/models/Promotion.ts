import { Schema, model } from "mongoose";

export const PROMO_TYPES = [
  "percent",
  "flat",
  "bogo",
  "free-item",
  "first-order",
] as const;
export type PromoType = (typeof PROMO_TYPES)[number];

export const PROMO_SEGMENTS = [
  "All",
  "Gold",
  "Silver",
  "Bronze",
  "New",
  "Lapsed",
] as const;

const PromotionSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true },
    description: String,
    type: { type: String, enum: PROMO_TYPES, required: true },
    // percent: 0-100 ; flat: rupees ; bogo/free-item: targetItemId required ; first-order: percent
    value: { type: Number, default: 0 },
    minBasket: { type: Number, default: 0 },
    targetItemId: { type: Schema.Types.ObjectId, ref: "MenuItem" },
    segment: { type: String, enum: PROMO_SEGMENTS, default: "All" },
    redemptionLimit: { type: Number, default: 0 }, // 0 = unlimited
    usedCount: { type: Number, default: 0 },
    validFrom: Date,
    validTo: Date,
    active: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

PromotionSchema.index({ outletId: 1, code: 1 }, { unique: true });

export const Promotion = model("Promotion", PromotionSchema);
