import { Schema, model } from "mongoose";

const POLineSchema = new Schema(
  {
    ingredientId: { type: Schema.Types.ObjectId, ref: "Ingredient" },
    name: String,
    qty: { type: Number, required: true },
    unit: String,
    costPerUnit: Number,
    lineTotal: Number,
  },
  { _id: false }
);

const PurchaseOrderSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    code: { type: String, required: true, unique: true, index: true },
    supplierId: { type: Schema.Types.ObjectId, ref: "Supplier" },
    supplierName: String,
    lines: { type: [POLineSchema], default: [] },
    total: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["Draft", "Sent", "Partially Received", "Received", "Closed", "Cancelled"],
      default: "Draft",
    },
    expectedAt: Date,
    receivedAt: Date,
    note: String,
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export const PurchaseOrder = model("PurchaseOrder", PurchaseOrderSchema);
