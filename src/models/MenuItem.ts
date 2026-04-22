import { Schema, model } from "mongoose";

const RecipeEntrySchema = new Schema(
  {
    ingredientId: { type: Schema.Types.ObjectId, ref: "Ingredient", required: true },
    qty: { type: Number, required: true },
  },
  { _id: false }
);

const MenuItemSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", required: true, index: true },
    name: { type: String, required: true },
    description: String,
    price: { type: Number, required: true },
    plateCost: { type: Number, default: 0 },
    image: String,
    station: {
      type: String,
      enum: ["Grill", "Fryer", "Cold", "Drinks", "Oven"],
      default: "Grill",
    },
    tags: [String],
    active: { type: Boolean, default: true },
    stockStatus: { type: String, enum: ["OK", "Low", "Out"], default: "OK" },
    sold7d: { type: Number, default: 0 },
    recipe: { type: [RecipeEntrySchema], default: [] },
    // Combo support: if isCombo=true, comboItems lists the bundled items + qtys.
    // The MenuItem.price is the bundle price; savings are computed at runtime.
    isCombo: { type: Boolean, default: false },
    comboItems: {
      type: [
        new Schema(
          {
            menuItemId: { type: Schema.Types.ObjectId, ref: "MenuItem" },
            qty: { type: Number, default: 1 },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  { timestamps: true }
);

MenuItemSchema.virtual("margin").get(function () {
  if (!this.price) return 0;
  return Math.round(((this.price - this.plateCost) / this.price) * 100);
});

MenuItemSchema.set("toJSON", { virtuals: true });

export const MenuItem = model("MenuItem", MenuItemSchema);
