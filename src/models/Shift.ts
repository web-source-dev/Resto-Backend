import { Schema, model } from "mongoose";

const ShiftSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // Stored as YYYY-MM-DD to keep timezone simple across staff devices
    date: { type: String, required: true, index: true },
    startTime: { type: String, required: true }, // HH:mm
    endTime: { type: String, required: true }, // HH:mm
    role: String,
    notes: String,
    published: { type: Boolean, default: false },
    // Shift swap workflow
    swapRequestedByUserId: { type: Schema.Types.ObjectId, ref: "User" },
    swapStatus: {
      type: String,
      enum: ["none", "requested", "accepted", "approved", "rejected"],
      default: "none",
    },
    swapTargetUserId: { type: Schema.Types.ObjectId, ref: "User" },
    swapTargetShiftId: { type: Schema.Types.ObjectId, ref: "Shift" },
  },
  { timestamps: true }
);

ShiftSchema.index({ outletId: 1, date: 1, userId: 1 });

export const Shift = model("Shift", ShiftSchema);
