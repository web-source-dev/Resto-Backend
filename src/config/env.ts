import "dotenv/config";

function str(v?: string) {
  return v && v.trim().length ? v.trim() : undefined;
}

export const env = {
  PORT: Number(process.env.PORT ?? 4000),
  JWT_SECRET: process.env.JWT_SECRET ?? "dev-secret",
  JWT_EXPIRES: process.env.JWT_EXPIRES ?? "7d",
  CORS_ORIGIN: (process.env.CORS_ORIGIN ?? "http://localhost:3000").split(","),
  MONGO_URI: process.env.MONGO_URI,

  // ─── Integration credentials (optional; features auto-mock when missing) ───
  TWILIO_ACCOUNT_SID: str(process.env.TWILIO_ACCOUNT_SID),
  TWILIO_AUTH_TOKEN: str(process.env.TWILIO_AUTH_TOKEN),
  TWILIO_SMS_FROM: str(process.env.TWILIO_SMS_FROM),
  TWILIO_WHATSAPP_FROM: str(process.env.TWILIO_WHATSAPP_FROM),

  SMTP_HOST: str(process.env.SMTP_HOST),
  SMTP_PORT: Number(process.env.SMTP_PORT ?? 587),
  SMTP_USER: str(process.env.SMTP_USER),
  SMTP_PASS: str(process.env.SMTP_PASS),
  SMTP_FROM: str(process.env.SMTP_FROM),
  SMTP_SECURE: (process.env.SMTP_SECURE ?? "false") === "true",

  STRIPE_SECRET_KEY: str(process.env.STRIPE_SECRET_KEY),
  STRIPE_PUBLISHABLE_KEY: str(process.env.STRIPE_PUBLISHABLE_KEY),
  STRIPE_WEBHOOK_SECRET: str(process.env.STRIPE_WEBHOOK_SECRET),

  GOOGLE_MAPS_KEY: str(process.env.GOOGLE_MAPS_KEY),
  GOOGLE_REVIEWS_PLACE_ID: str(process.env.GOOGLE_REVIEWS_PLACE_ID),

  // Webhook delivery
  WEBHOOK_SIGNING_SECRET: str(process.env.WEBHOOK_SIGNING_SECRET) ?? "dev-webhook-secret",
  WEBHOOK_TIMEOUT_MS: Number(process.env.WEBHOOK_TIMEOUT_MS ?? 8000),
};

export type Env = typeof env;
