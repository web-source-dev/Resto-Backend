import { Schema, model } from "mongoose";

const ReservationSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    tableId: { type: Schema.Types.ObjectId, ref: "Table" },
    customerName: { type: String, required: true },
    phone: String,
    party: { type: Number, default: 2 },
    at: { type: Date, required: true, index: true },
    status: { type: String, enum: ["Booked", "Seated", "Completed", "No-show", "Cancelled"], default: "Booked" },
    depositPaid: { type: Number, default: 0 },
    note: String,
  },
  { timestamps: true }
);

export const Reservation = model("Reservation", ReservationSchema);
