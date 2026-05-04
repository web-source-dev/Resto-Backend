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
      enum: ["Pending", "Queued", "In Progress", "Ready", "Cancelled"],
      default: "Queued",
    },
    cancelledAt: Date,
    cancelReason: String,
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
    // Snapshot of order.total at the moment of payment. When an addendum
    // re-opens a Paid bill, paymentStatus flips back to Pending but paidAmount
    // is retained so the UI can show balanceDue = total - paidAmount.
    paidAmount: { type: Number, default: 0 },
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
    // Non-recipe consumables used on this order (boxes, napkins, sachets, etc).
    // Auto-deducts via the menu BOM cover predictable per-dish usage; this
    // array captures variable / ad-hoc usage logged via "Use supplies".
    supplies: {
      type: [
        new Schema(
          {
            ingredientId: { type: Schema.Types.ObjectId, ref: "Ingredient" },
            name: { type: String, required: true },
            qty: { type: Number, required: true },
            unit: String,
            costPerUnit: { type: Number, default: 0 },
            at: { type: Date, default: Date.now },
            by: { type: Schema.Types.ObjectId, ref: "User" },
            byName: String,
            reason: String,
          },
          { _id: true }
        ),
      ],
      default: [],
    },
  },
  { timestamps: true }
);

// Indexes that the reports aggregations rely on. The first covers the
// dominant filter shape `{ outletId, placedAt: { $gte, $lte } }` plus
// channel/payment splits used in trend, channel-mix, hour heatmap, P&L,
// and payment-mix endpoints. The second supports the rider scorecard.
OrderSchema.index({ outletId: 1, placedAt: -1, channel: 1 });
OrderSchema.index({ outletId: 1, paymentMethod: 1, placedAt: -1 });
OrderSchema.index({ outletId: 1, riderId: 1, deliveredAt: -1 });

OrderSchema.virtual("elapsedMin").get(function (this: any) {
  const start = (this.acceptedAt ?? this.placedAt ?? new Date()).getTime();
  // Once the kitchen marks Ready, freeze the timer at that moment. Order
  // throughput KPIs and KDS overdue indicators should reflect prep time
  // (placed → ready), not how long the ticket has been sitting on the pass.
  const end = this.readyAt ? new Date(this.readyAt).getTime() : Date.now();
  return Math.round((end - start) / 60000);
});

OrderSchema.virtual("balanceDue").get(function (this: any) {
  const total = Number(this.total ?? 0);
  const paid = Number(this.paidAmount ?? 0);
  return Math.max(0, total - paid);
});

OrderSchema.virtual("suppliesCost").get(function (this: any) {
  return (this.supplies ?? []).reduce(
    (s: number, x: any) => s + (Number(x.qty) || 0) * (Number(x.costPerUnit) || 0),
    0
  );
});

OrderSchema.set("toJSON", { virtuals: true });

export const Order = model("Order", OrderSchema);
