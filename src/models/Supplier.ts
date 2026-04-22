import { Schema, model } from "mongoose";

const SupplierSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    name: { type: String, required: true },
    contact: String,
    phone: String,
    email: String,
    leadTimeDays: { type: Number, default: 2 },
    rating: { type: Number, default: 4.5 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Supplier = model("Supplier", SupplierSchema);
