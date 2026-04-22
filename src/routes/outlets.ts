import { Router } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { Outlet } from "../models/Outlet";
import { User } from "../models/User";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, requireRole } from "../middleware/auth";
import { audit } from "../services/audit";

const r = Router();
r.use(authMiddleware);
const canManage = requireRole("admin");

// List outlets this user can access (current + any from outletIds)
r.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const me = req.user as any;
    const ids = new Set<string>();
    ids.add(String(me.outletId));
    for (const id of me.outletIds ?? []) ids.add(String(id));
    const outlets = await Outlet.find({ _id: { $in: Array.from(ids) } });
    res.json({
      outlets,
      currentOutletId: String(me.outletId),
      canCreate: me.role === "admin",
    });
  })
);

// Current outlet getter — used by settings for live edit
r.get(
  "/current",
  asyncHandler(async (req: AuthedRequest, res) => {
    const outlet = await Outlet.findById(req.outletId);
    if (!outlet) return res.status(404).json({ error: "Not found" });
    res.json({ outlet });
  })
);

r.patch(
  "/:id",
  requireRole("admin", "manager"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const me = req.user as any;
    const ids = new Set<string>([
      String(me.outletId),
      ...(me.outletIds ?? []).map((x: any) => String(x)),
    ]);
    if (!ids.has(String(req.params.id)))
      return res.status(403).json({ error: "Not your outlet" });
    const allowed: any = {};
    for (const k of [
      "name",
      "address",
      "phone",
      "email",
      "taxId",
      "logoUrl",
      "timezone",
      "currency",
      "language",
      "taxRate",
      "serviceRate",
      "acceptsTips",
      "paymentMethods",
      "smsEnabled",
      "whatsappEnabled",
      "emailEnabled",
      "stripeEnabled",
      "googleReviewsEnabled",
      "businessHours",
      "receiptHeader",
      "receiptFooter",
      "receiptLegalText",
      "receiptShowLogo",
      "receiptShowTaxBreakdown",
      "qrBrandColor",
      "qrBrandLogoUrl",
      "sessionTimeoutMinutes",
      "requireMfa",
      "passwordMinLength",
      "retainOrderHistoryDays",
      "retainAuditLogDays",
    ]) {
      if (req.body[k] !== undefined) allowed[k] = req.body[k];
    }
    const before = await Outlet.findById(req.params.id);
    const outlet = await Outlet.findByIdAndUpdate(req.params.id, allowed, {
      new: true,
    });
    if (!outlet) return res.status(404).json({ error: "Not found" });
    await audit({
      outletId: req.outletId!,
      userId: (req.user as any)?._id?.toString(),
      userName: (req.user as any)?.name,
      action: "outlet.update",
      targetType: "Outlet",
      targetId: String(outlet._id),
      before: before?.toJSON(),
      after: outlet.toJSON(),
    });
    res.json({ outlet });
  })
);

r.post(
  "/",
  canManage,
  asyncHandler(async (req: AuthedRequest, res) => {
    const outlet = await Outlet.create(req.body);
    // Add this outlet to admin's accessible set
    const me = req.user as any;
    if (!me.outletIds || !me.outletIds.map((x: any) => String(x)).includes(String(outlet._id))) {
      await User.updateOne(
        { _id: me._id },
        { $addToSet: { outletIds: outlet._id } }
      );
    }
    res.status(201).json({ outlet });
  })
);

// Switch the current outlet — issues a fresh JWT scoped to the new outlet.
r.post(
  "/switch",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { outletId } = req.body;
    const me = req.user as any;
    const allowed = new Set<string>();
    allowed.add(String(me.outletId));
    for (const id of me.outletIds ?? []) allowed.add(String(id));
    if (!allowed.has(String(outletId)))
      return res.status(403).json({ error: "Not authorized for that outlet" });
    const target = await Outlet.findById(outletId);
    if (!target) return res.status(404).json({ error: "Outlet not found" });
    // Update user's active outletId
    await User.updateOne({ _id: me._id }, { outletId: target._id });
    const token = jwt.sign(
      { sub: me._id.toString(), outletId: target._id.toString(), role: me.role },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES } as any
    );
    res.json({ token, outlet: target });
  })
);

export default r;
