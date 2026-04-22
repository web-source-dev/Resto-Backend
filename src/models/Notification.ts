import { Schema, model } from "mongoose";

const NotificationSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    type: {
      type: String,
      enum: [
        "order.new",
        "order.ready",
        "order.overdue",
        "order.completed",
        "inventory.low",
        "inventory.out",
        "wastage.new",
        "wastage.warn",
        "expense.new",
        "review.negative",
        "staff.clock",
        "campaign.sent",
        "system",
      ],
      required: true,
    },
    level: { type: String, enum: ["info", "success", "warn", "error"], default: "info" },
    title: { type: String, required: true },
    body: String,
    link: String,
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    // Empty array = everyone in the outlet sees it. If set, only users whose
    // role is in this list will receive the notification.
    targetRoles: { type: [String], default: [] },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

NotificationSchema.index({ outletId: 1, createdAt: -1 });

export const Notification = model("Notification", NotificationSchema);
