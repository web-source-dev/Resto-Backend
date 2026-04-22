import { Schema, model } from "mongoose";

const GRNLineSchema = new Schema(
  {
    ingredientId: { type: Schema.Types.ObjectId, ref: "Ingredient" },
    name: String,
    orderedQty: Number,
    receivedQty: Number,
    unit: String,
    priceOrdered: Number,
    priceActual: Number,
    qtyVariance: Number, // receivedQty - orderedQty
    priceVariance: Number, // (priceActual - priceOrdered) * receivedQty
    qualityNotes: String,
  },
  { _id: false }
);

const GoodsReceivedSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    poId: { type: Schema.Types.ObjectId, ref: "PurchaseOrder", index: true },
    poCode: String,
    supplierId: { type: Schema.Types.ObjectId, ref: "Supplier" },
    supplierName: String,
    lines: { type: [GRNLineSchema], default: [] },
    totalQtyVariance: { type: Number, default: 0 },
    totalPriceVariance: { type: Number, default: 0 },
    onTime: Boolean, // receivedAt vs po.expectedAt
    daysLate: Number,
    receivedByUserId: { type: Schema.Types.ObjectId, ref: "User" },
    receivedByName: String,
    receivedAt: { type: Date, default: Date.now },
    note: String,
  },
  { timestamps: true }
);

export const GoodsReceived = model("GoodsReceived", GoodsReceivedSchema);
