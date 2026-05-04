import { Router } from "express";
import { authMiddleware, AuthedRequest } from "../middleware/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { PushSubscription } from "../models/PushSubscription";
import { getVapidPublicKey } from "../services/push";

const r = Router();
r.use(authMiddleware);

r.get(
  "/vapid-public-key",
  asyncHandler(async (_req: AuthedRequest, res) => {
    res.json({ key: getVapidPublicKey() });
  })
);

r.post(
  "/subscribe",
  asyncHandler(async (req: AuthedRequest, res) => {
    const sub = req.body?.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return res.status(400).json({ error: "Invalid subscription" });
    }

    await PushSubscription.findOneAndUpdate(
      { endpoint: sub.endpoint },
      {
        outletId: req.outletId,
        userId: req.user?._id,
        role: req.user?.role,
        endpoint: sub.endpoint,
        expirationTime: sub.expirationTime ?? null,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
        userAgent: req.headers["user-agent"] ?? "",
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({ ok: true });
  })
);

r.post(
  "/unsubscribe",
  asyncHandler(async (req: AuthedRequest, res) => {
    const endpoint = req.body?.endpoint;
    if (!endpoint) return res.status(400).json({ error: "endpoint is required" });
    await PushSubscription.deleteOne({
      endpoint,
      outletId: req.outletId,
      userId: req.user?._id,
    });
    res.json({ ok: true });
  })
);

export default r;
