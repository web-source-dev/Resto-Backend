import { Schema, model } from "mongoose";

const CustomerSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    name: { type: String, required: true },
    phone: { type: String, index: true },
    email: { type: String, lowercase: true, trim: true, index: true },
    tier: { type: String, enum: ["Bronze", "Silver", "Gold"], default: "Bronze" },
    visits: { type: Number, default: 0 },
    ltv: { type: Number, default: 0 },
    points: { type: Number, default: 0 },
    favorite: String,
    dietaryPrefs: [String],
    lastVisitAt: Date,
    marketingOptIn: { type: Boolean, default: false },
    birthday: Date,
    anniversary: Date,
    referralCode: { type: String, unique: true, sparse: true },
    referredById: { type: Schema.Types.ObjectId, ref: "Customer" },
  },
  { timestamps: true }
);

export const Customer = model("Customer", CustomerSchema);
