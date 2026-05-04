import { Schema, model } from "mongoose";

export type OrderStatus =
  | "Pending"
  | "Queued"
  | "In Progress"
  | "Ready"
  | "Served"
  | "Completed"
  | "Cancelled";

const OrderItemSchema = new Schema(
  {
    menuItemId: { type: Schema.Types.ObjectId, ref: "MenuItem" },
    name: { type: String, required: true },
    qty: { type: Number, required: true, default: 1 },
    price: { type: Number, required: true },
    mods: [String],
    note: String,
    status: {
      type: String,
      enum: ["Pending", "Queued", "In Progress", "Ready"],
      default: "Queued",
    },
    eta: Date,
    addendum: { type: Boolean, default: false },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const OrderEventSchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    status: String,
    by: { type: Schema.Types.ObjectId, ref: "User" },
    note: String,
  },
  { _id: false }
);

const OrderSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    code: { type: String, required: true, unique: true, index: true },
    channel: {
      type: String,
      enum: ["Dine-in", "Takeaway", "Delivery", "Phone"],
      default: "Dine-in",
      index: true,
    },
    tableId: { type: Schema.Types.ObjectId, ref: "Table" },
    tableCode: String,
    customerId: { type: Schema.Types.ObjectId, ref: "Customer" },
    customerName: String,
    customerPhone: String,
    customerEmail: String,
    marketingOptIn: { type: Boolean, default: false },
    waiterId: { type: Schema.Types.ObjectId, ref: "User" },
    // Delivery-specific
    deliveryAddress: String,
    deliveryNote: String,
    cashOnDelivery: { type: Boolean, default: false },
    riderId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    riderName: String,
    assignedAt: Date,
    pickedUpAt: Date,
    deliveredAt: Date,
    failureReason: String,
    items: { type: [OrderItemSchema], default: [] },
    subtotal: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    service: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    discountLines: {
      type: [
        new Schema(
          {
            source: {
              type: String,
              enum: ["coupon", "combo", "happy-hour", "weekend-surcharge", "delivery-markup", "loyalty-redemption", "tier", "first-order"],
            },
            code: String,
            label: String,
            amount: Number, // negative = discount, positive = surcharge
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    couponCode: String,
    pointsRedeemed: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["Pending", "Queued", "In Progress", "Ready", "Served", "Completed", "Cancelled"],
      default: "Queued",
      index: true,
    },
    source: {
      type: String,
      enum: ["customer", "staff"],
      default: "staff",
    },
    sessionClosed: { type: Boolean, default: false, index: true },
    paymentStatus: {
      type: String,
      enum: ["Pending", "Paid", "Refunded"],
      default: "Pending",
    },
    paymentMethod: {
      type: String,
      enum: ["Cash", "Card", "JazzCash", "Easypaisa", "Stripe", "BankTransfer"],
    },
    priority: { type: String, enum: ["Normal", "Rush", "VIP"], default: "Normal" },
    eta: Date,
    placedAt: { type: Date, default: Date.now },
    acceptedAt: Date,
    readyAt: Date,
    servedAt: Date,
    closedAt: Date,
    events: { type: [OrderEventSchema], default: [] },
  },
  { timestamps: true }
);

OrderSchema.virtual("elapsedMin").get(function () {
  const start = (this.acceptedAt ?? this.placedAt ?? new Date()).getTime();
  return Math.round((Date.now() - start) / 60000);
});

OrderSchema.set("toJSON", { virtuals: true });

export const Order = model("Order", OrderSchema);
