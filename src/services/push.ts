import fs from "fs";
import path from "path";
import webpush from "web-push";
import { env } from "../config/env";
import { PushSubscription } from "../models/PushSubscription";

let configured = false;
let devLogged = false;

/** Dev keys: persisted to cwd so server restarts don’t invalidate subscriptions. */
let devVapid: { publicKey: string; privateKey: string } | null = null;

const DEV_VAPID_FILE = path.join(process.cwd(), ".vapid-dev.json");

function getDevVapidPair() {
  if (!devVapid) {
    try {
      if (fs.existsSync(DEV_VAPID_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(DEV_VAPID_FILE, "utf8"));
        if (parsed?.publicKey && parsed?.privateKey) {
          devVapid = {
            publicKey: parsed.publicKey,
            privateKey: parsed.privateKey,
          };
        }
      }
    } catch {
      /* fall through to generate */
    }
    if (!devVapid) {
      devVapid = webpush.generateVAPIDKeys();
      try {
        fs.writeFileSync(DEV_VAPID_FILE, JSON.stringify(devVapid, null, 2), "utf8");
      } catch {
        /* ignore */
      }
    }
    if (!devLogged) {
      devLogged = true;
      console.warn(
        "[push] VAPID keys not set in env — using dev keys (" +
          (fs.existsSync(DEV_VAPID_FILE) ? ".vapid-dev.json in server cwd" : "generated") +
          "). Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY for production."
      );
    }
  }
  return devVapid;
}

/** Public key exposed to clients for PushManager.subscribe */
export function getVapidPublicKey(): string | null {
  if (env.VAPID_PUBLIC_KEY) return env.VAPID_PUBLIC_KEY;
  if (process.env.NODE_ENV !== "production") return getDevVapidPair().publicKey;
  return null;
}

function ensureConfigured() {
  if (configured) return true;

  let pub = env.VAPID_PUBLIC_KEY;
  let priv = env.VAPID_PRIVATE_KEY;

  if (!pub || !priv) {
    if (process.env.NODE_ENV !== "production") {
      const pair = getDevVapidPair();
      pub = pair.publicKey;
      priv = pair.privateKey;
    } else {
      return false;
    }
  }

  webpush.setVapidDetails(env.VAPID_SUBJECT, pub, priv);
  configured = true;
  return true;
}

export function pushConfigured() {
  return ensureConfigured();
}

export async function sendPushToOutlet(
  outletId: string,
  payload: { title: string; body?: string; url?: string; tag?: string; level?: string },
  target?: { userId?: string; roles?: string[] }
) {
  if (!ensureConfigured()) {
    console.warn("[push] skipped send — VAPID not configured");
    return;
  }

  const oid = String(outletId);
  const query: Record<string, unknown> = { outletId: oid };
  // Personal target wins; otherwise narrow by role list; otherwise outlet-wide broadcast.
  if (target?.userId) {
    query.userId = String(target.userId);
  } else if (target?.roles && target.roles.length > 0) {
    query.role = { $in: target.roles };
  }
  const subs = await PushSubscription.find(query).lean();
  if (!subs.length) {
    return;
  }

  const message = JSON.stringify({
    ...payload,
    ts: Date.now(),
    id: `${payload.tag ?? "n"}-${Date.now()}`,
  });

  await Promise.all(
    subs.map(async (sub: any) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            expirationTime: sub.expirationTime ?? null,
            keys: { p256dh: sub.keys?.p256dh, auth: sub.keys?.auth },
          },
          message,
          {
            TTL: 86400,
            urgency: "high",
          }
        );
      } catch (err: any) {
        const code = err?.statusCode;
        if (code === 404 || code === 410 || code === 401 || code === 403) {
          await PushSubscription.deleteOne({ _id: sub._id });
          if (code === 401 || code === 403) {
            console.warn(
              "[push] subscription rejected (likely VAPID mismatch); removed — user should re-enable push"
            );
          }
        } else {
          console.warn("[push] send failed:", err?.message ?? err);
        }
      }
    })
  );
}
