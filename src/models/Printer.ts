import { Schema, model } from "mongoose";

export const PRINTER_TYPES = ["receipt", "kitchen", "bar", "label"] as const;

const PrinterSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    name: { type: String, required: true },
    type: { type: String, enum: PRINTER_TYPES, default: "receipt" },
    host: { type: String, required: true }, // IP or hostname
    port: { type: Number, default: 9100 },
    station: { type: String }, // e.g. "Kitchen", "Grill", "Bar"
    active: { type: Boolean, default: true },
    lastTestAt: { type: Date },
    lastTestOk: { type: Boolean },
    lastTestError: { type: String },
  },
  { timestamps: true }
);

export const Printer = model("Printer", PrinterSchema);
