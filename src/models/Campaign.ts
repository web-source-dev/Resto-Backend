import { Schema, model } from "mongoose";

const CampaignSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    name: { type: String, required: true },
    channel: {
      type: String,
      enum: ["SMS", "Email", "WhatsApp", "Push"],
      default: "WhatsApp",
    },
    segment: {
      type: String,
      enum: ["All", "Gold", "Silver", "Bronze", "Lapsed", "New"],
      default: "All",
    },
    message: { type: String, required: true },
    status: { type: String, enum: ["Draft", "Sent", "Scheduled"], default: "Draft" },
    sentAt: Date,
    sentCount: Number,
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export const Campaign = model("Campaign", CampaignSchema);
