import { env } from "../../config/env";
import { emailConfigured } from "./email";
import { smsConfigured } from "./sms";
import { whatsappConfigured } from "./whatsapp";
import { stripeConfigured, publishableKey } from "./stripe";
import { mapsConfigured } from "./maps";

export type ProviderId = "sms" | "whatsapp" | "email" | "stripe" | "maps" | "google-reviews";

export function providerStatus() {
  return {
    sms: {
      id: "sms" as const,
      label: "Twilio SMS",
      configured: smsConfigured(),
      requiredEnv: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_SMS_FROM"],
      docsUrl: "https://www.twilio.com/docs/sms",
    },
    whatsapp: {
      id: "whatsapp" as const,
      label: "Twilio WhatsApp",
      configured: whatsappConfigured(),
      requiredEnv: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM"],
      docsUrl: "https://www.twilio.com/docs/whatsapp",
    },
    email: {
      id: "email" as const,
      label: "SMTP Email",
      configured: emailConfigured(),
      requiredEnv: ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"],
      docsUrl: "https://nodemailer.com/smtp/",
    },
    stripe: {
      id: "stripe" as const,
      label: "Stripe Payments",
      configured: stripeConfigured(),
      publishableKey: publishableKey(),
      requiredEnv: ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET"],
      docsUrl: "https://stripe.com/docs/api",
    },
    maps: {
      id: "maps" as const,
      label: "Google Maps",
      configured: mapsConfigured(),
      requiredEnv: ["GOOGLE_MAPS_KEY"],
      docsUrl: "https://developers.google.com/maps/documentation",
    },
    "google-reviews": {
      id: "google-reviews" as const,
      label: "Google Reviews",
      configured: Boolean(env.GOOGLE_REVIEWS_PLACE_ID),
      placeId: env.GOOGLE_REVIEWS_PLACE_ID ?? null,
      requiredEnv: ["GOOGLE_REVIEWS_PLACE_ID"],
      docsUrl: "https://developers.google.com/my-business/content/review-data",
    },
  };
}

export { sendSms } from "./sms";
export { sendWhatsapp } from "./whatsapp";
export { sendEmail, verifyEmailTransport } from "./email";
export { createPaymentIntent, refundPayment, pingStripe } from "./stripe";
export { geocode, distanceKm } from "./maps";
export { buildTestTicket, buildKitchenTicket, escposPrint } from "./escpos";
