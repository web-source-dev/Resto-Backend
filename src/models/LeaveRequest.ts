import { Schema, model } from "mongoose";

export const LEAVE_TYPES = [
  "sick",
  "vacation",
  "personal",
  "emergency",
] as const;

const LeaveRequestSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    userName: String,
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    type: { type: String, enum: LEAVE_TYPES, required: true },
    reason: String,
    status: {
      type: String,
      enum: ["Pending", "Approved", "Rejected"],
      default: "Pending",
    },
    decidedByUserId: { type: Schema.Types.ObjectId, ref: "User" },
    decidedByName: String,
    decidedAt: Date,
    decisionNote: String,
  },
  { timestamps: true }
);

LeaveRequestSchema.virtual("days").get(function () {
  if (!this.from || !this.to) return 0;
  return Math.max(
    1,
    Math.ceil((this.to.getTime() - this.from.getTime()) / 86400000) + 1
  );
});
LeaveRequestSchema.set("toJSON", { virtuals: true });

export const LeaveRequest = model("LeaveRequest", LeaveRequestSchema);
