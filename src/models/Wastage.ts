import { Schema, model } from "mongoose";

const WastageSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    ingredientId: { type: Schema.Types.ObjectId, ref: "Ingredient" },
    menuItemId: { type: Schema.Types.ObjectId, ref: "MenuItem" },
    itemName: String,
    qty: { type: Number, required: true },
    unit: String,
    cost: { type: Number, default: 0 },
    reason: {
      type: String,
      enum: [
        "Spoiled",
        "Dropped",
        "Overcooked",
        "Customer return",
        "Staff meal",
        "Complimentary",
        "Shift-end discard",
      ],
      required: true,
    },
    staffId: { type: Schema.Types.ObjectId, ref: "User" },
    staffName: String,
    shift: String,
    photo: String,
    approved: { type: Boolean, default: false },
    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

export const Wastage = model("Wastage", WastageSchema);
