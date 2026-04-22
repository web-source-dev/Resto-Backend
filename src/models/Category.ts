import { Schema, model } from "mongoose";

const CategorySchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    name: { type: String, required: true },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    icon: String,
  },
  { timestamps: true }
);

export const Category = model("Category", CategorySchema);
