import { Schema, model } from "mongoose";

export const API_KEY_SCOPES = [
  "read:orders",
  "write:orders",
  "read:menu",
  "write:menu",
  "read:customers",
  "write:customers",
  "read:reports",
  "webhook:sign",
] as const;

const ApiKeySchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    name: { type: String, required: true },
    prefix: { type: String, required: true, index: true }, // first 8 chars, shown to user
    hashedKey: { type: String, required: true }, // sha256 of full key
    scopes: { type: [String], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    lastUsedAt: { type: Date },
    expiresAt: { type: Date },
    revokedAt: { type: Date },
  },
  { timestamps: true }
);

export const ApiKey = model("ApiKey", ApiKeySchema);
