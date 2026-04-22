import { Schema, model } from "mongoose";

export const EXPENSE_CATEGORIES = [
  "Utilities",
  "Rent",
  "Staff Meals",
  "Maintenance",
  "Supplies",
  "Packaging",
  "Marketing",
  "Transport",
  "Licenses & Insurance",
  "Other",
] as const;

const ExpenseSchema = new Schema(
  {
    outletId: {
      type: Schema.Types.ObjectId,
      ref: "Outlet",
      required: true,
      index: true,
    },
    category: {
      type: String,
      enum: EXPENSE_CATEGORIES as unknown as string[],
      required: true,
    },
    subcategory: String, // free-text e.g. "Electricity", "Jan 2026 bill"
    description: String,
    amount: { type: Number, required: true, min: 0 },
    paymentMethod: {
      type: String,
      enum: ["Cash", "Card", "BankTransfer", "JazzCash", "Easypaisa", "Other"],
      default: "Cash",
    },
    vendor: String,
    receiptUrl: String,
    recurring: { type: Boolean, default: false },
    approved: { type: Boolean, default: false },
    loggedById: { type: Schema.Types.ObjectId, ref: "User" },
    loggedByName: String,
    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

ExpenseSchema.index({ outletId: 1, at: -1 });
ExpenseSchema.index({ outletId: 1, category: 1 });

export const Expense = model("Expense", ExpenseSchema);
