import { Schema, model } from "mongoose";

const AttendanceSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    clockedInAt: { type: Date, required: true },
    clockedOutAt: Date,
    breakMinutes: { type: Number, default: 0 },
    note: String,
    shiftId: { type: Schema.Types.ObjectId, ref: "Shift" },
  },
  { timestamps: true }
);

AttendanceSchema.index({ outletId: 1, userId: 1, clockedInAt: -1 });

AttendanceSchema.virtual("hours").get(function () {
  if (!this.clockedInAt || !this.clockedOutAt) return 0;
  const ms = this.clockedOutAt.getTime() - this.clockedInAt.getTime();
  const minutes = ms / 60000 - (this.breakMinutes ?? 0);
  return Math.max(0, minutes / 60);
});
AttendanceSchema.set("toJSON", { virtuals: true });

export const Attendance = model("Attendance", AttendanceSchema);
