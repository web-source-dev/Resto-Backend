import { Schema, model } from "mongoose";

const AuditLogSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet" },
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    userName: String,
    action: { type: String, required: true },
    targetType: String,
    targetId: String,
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export const AuditLog = model("AuditLog", AuditLogSchema);
