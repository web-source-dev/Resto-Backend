import { Schema, model } from "mongoose";

const IngredientSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    sku: { type: String, required: true },
    name: { type: String, required: true },
    category: String,
    unit: { type: String, default: "kg" },
    stock: { type: Number, default: 0 },
    par: { type: Number, default: 0 },
    costPerUnit: { type: Number, default: 0 },
    expiresAt: Date,
  },
  { timestamps: true }
);

IngredientSchema.index({ outletId: 1, sku: 1 }, { unique: true });

IngredientSchema.virtual("status").get(function () {
  if (this.stock <= 0) return "Out";
  if (this.stock < this.par) return "Low";
  return "OK";
});

IngredientSchema.virtual("value").get(function () {
  return Math.round(this.stock * this.costPerUnit);
});

IngredientSchema.set("toJSON", { virtuals: true });

export const Ingredient = model("Ingredient", IngredientSchema);
