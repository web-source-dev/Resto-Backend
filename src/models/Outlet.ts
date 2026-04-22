import { Schema, model, Types } from "mongoose";

const BusinessHourSchema = new Schema(
  {
    day: { type: Number, required: true, min: 0, max: 6 }, // 0 = Sun
    closed: { type: Boolean, default: false },
    openTime: { type: String, default: "10:00" }, // "HH:mm"
    closeTime: { type: String, default: "23:00" },
  },
  { _id: false }
);

const OutletSchema = new Schema(
  {
    name: { type: String, required: true },
    address: String,
    phone: String,
    email: String,
    taxId: String,
    logoUrl: String,
    timezone: { type: String, default: "Asia/Karachi" },
    currency: { type: String, default: "PKR" },
    language: { type: String, default: "en" },
    taxRate: { type: Number, default: 0.16 },
    serviceRate: { type: Number, default: 0.05 },
    acceptsTips: { type: Boolean, default: true },
    paymentMethods: {
      type: [String],
      default: ["Cash", "Card", "JazzCash", "Easypaisa"],
    },
    // Feature toggles — gate provider-backed features
    whatsappEnabled: { type: Boolean, default: false },
    emailEnabled: { type: Boolean, default: true },
    smsEnabled: { type: Boolean, default: true },
    stripeEnabled: { type: Boolean, default: false },
    googleReviewsEnabled: { type: Boolean, default: false },

    // Business hours (7 entries, one per weekday)
    businessHours: { type: [BusinessHourSchema], default: [] },

    // Receipt customization
    receiptHeader: { type: String, default: "" },
    receiptFooter: { type: String, default: "Thank you for dining with us!" },
    receiptLegalText: { type: String, default: "" },
    receiptShowLogo: { type: Boolean, default: true },
    receiptShowTaxBreakdown: { type: Boolean, default: true },

    // QR branding
    qrBrandColor: { type: String, default: "#0ea5e9" },
    qrBrandLogoUrl: { type: String, default: "" },

    // Security policy
    sessionTimeoutMinutes: { type: Number, default: 720 }, // 12h
    requireMfa: { type: Boolean, default: false },
    passwordMinLength: { type: Number, default: 8 },

    // Data retention (days)
    retainOrderHistoryDays: { type: Number, default: 365 },
    retainAuditLogDays: { type: Number, default: 180 },
  },
  { timestamps: true }
);

export const Outlet = model("Outlet", OutletSchema);
export type OutletId = Types.ObjectId;
