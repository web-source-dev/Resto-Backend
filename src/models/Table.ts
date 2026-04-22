import { Schema, model } from "mongoose";

const TableSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    code: { type: String, required: true },
    capacity: { type: Number, default: 4 },
    zone: { type: String, enum: ["Indoor", "Outdoor", "VIP"], default: "Indoor" },
    status: {
      type: String,
      enum: ["Free", "Occupied", "Reserved", "Cleaning"],
      default: "Free",
      index: true,
    },
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 },
    currentOrderId: { type: Schema.Types.ObjectId, ref: "Order" },
    seatedAt: Date,
    guests: Number,
    waiterId: { type: Schema.Types.ObjectId, ref: "User" },
    reservedFor: Date,
  },
  { timestamps: true }
);

TableSchema.index({ outletId: 1, code: 1 }, { unique: true });

export const Table = model("Table", TableSchema);
