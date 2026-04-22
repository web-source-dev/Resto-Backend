import { Schema, model } from "mongoose";

const WaitlistSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    customerName: { type: String, required: true },
    phone: String,
    party: { type: Number, default: 2 },
    quotedMinutes: Number,
    status: {
      type: String,
      enum: ["Waiting", "Seated", "Left", "Cancelled"],
      default: "Waiting",
      index: true,
    },
    notifiedAt: Date,
    seatedAt: Date,
    tableId: { type: Schema.Types.ObjectId, ref: "Table" },
    tableCode: String,
    note: String,
    requestedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

WaitlistSchema.virtual("waitingMinutes").get(function () {
  if (this.status !== "Waiting") return 0;
  return Math.round((Date.now() - this.requestedAt.getTime()) / 60000);
});
WaitlistSchema.set("toJSON", { virtuals: true });

export const Waitlist = model("Waitlist", WaitlistSchema);
