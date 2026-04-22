import { Schema, model } from "mongoose";

const ReviewSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer" },
    customerName: String,
    orderId: { type: Schema.Types.ObjectId, ref: "Order" },
    rating: { type: Number, min: 1, max: 5, required: true },
    text: String,
    channel: { type: String, enum: ["In-app", "Google", "WhatsApp", "Other"], default: "In-app" },
    recovery: { type: Boolean, default: false },
    resolved: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const Review = model("Review", ReviewSchema);
