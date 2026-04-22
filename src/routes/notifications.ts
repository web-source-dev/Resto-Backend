import { Router } from "express";
import { Notification } from "../models/Notification";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest } from "../middleware/auth";

const r = Router();
r.use(authMiddleware);

r.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const role = (req.user as any)?.role;
    const userId = (req.user as any)?._id;
    // A notification reaches a user if ANY applies:
    //  - personal: notification.userId === me
    //  - role-targeted: notification has roles set and one matches mine
    //  - broadcast: no user, no role filter
    const roleGate: any = {
      $or: [
        { userId },
        { userId: null, targetRoles: { $size: 0 } },
        { userId: null, targetRoles: { $in: [role] } },
      ],
    };
    const q: any = { outletId: req.outletId, ...roleGate };
    if (req.query.unread === "true") q.read = false;
    const items = await Notification.find(q)
      .sort({ createdAt: -1 })
      .limit(Number(req.query.limit ?? 50));
    const unread = await Notification.countDocuments({
      outletId: req.outletId,
      read: false,
      ...roleGate,
    });
    res.json({ items, unread });
  })
);

r.post(
  "/read",
  asyncHandler(async (req: AuthedRequest, res) => {
    const role = (req.user as any)?.role;
    const userId = (req.user as any)?._id;
    const roleGate: any = {
      $or: [
        { userId },
        { userId: null, targetRoles: { $size: 0 } },
        { userId: null, targetRoles: { $in: [role] } },
      ],
    };
    const ids: string[] = req.body.ids ?? [];
    if (ids.length === 0) {
      await Notification.updateMany(
        { outletId: req.outletId, read: false, ...roleGate },
        { read: true }
      );
    } else {
      await Notification.updateMany(
        { _id: { $in: ids }, outletId: req.outletId, ...roleGate },
        { read: true }
      );
    }
    res.json({ ok: true });
  })
);

export default r;
