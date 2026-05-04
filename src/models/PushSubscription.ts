import { Schema, model } from "mongoose";

const PushSubscriptionSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    expirationTime: { type: Number, default: null },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    userAgent: String,
  },
  { timestamps: true }
);

PushSubscriptionSchema.index({ outletId: 1, userId: 1 });

export const PushSubscription = model("PushSubscription", PushSubscriptionSchema);
