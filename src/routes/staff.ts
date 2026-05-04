import { Router } from "express";
import bcrypt from "bcryptjs";
import { User } from "../models/User";
import { Order } from "../models/Order";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, requireRole, excludeRoles } from "../middleware/auth";
import { notify } from "../services/notify";
import { Attendance } from "../models/Attendance";

const r = Router();
r.use(authMiddleware);
// Block riders from this resource — not relevant to delivery work and may
// contain PII or operational data they shouldn't see.
r.use(excludeRoles("rider"));
const canManage = requireRole("admin", "manager");

r.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const users = await User.find({ outletId: req.outletId }).sort({ name: 1 });
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const orders = await Order.find({
      outletId: req.outletId,
      placedAt: { $gte: todayStart },
    });
    const salesByWaiter = new Map<string, number>();
    for (const o of orders) {
      if (!o.waiterId) continue;
      salesByWaiter.set(
        o.waiterId.toString(),
        (salesByWaiter.get(o.waiterId.toString()) ?? 0) + (o.total ?? 0)
      );
    }
    res.json({
      staff: users.map((u: any) => {
        const o = u.toPublic();
        o.salesToday = salesByWaiter.get(u._id.toString()) ?? 0;
        return o;
      }),
    });
  })
);

r.post(
  "/",
  canManage,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { name, email, password, role, phone, hourlyRate } = req.body;
    const passwordHash = await bcrypt.hash(password ?? "password", 10);
    const user = await User.create({
      outletId: req.outletId,
      name,
      email: (email ?? `${Date.now()}@local.dev`).toLowerCase(),
      passwordHash,
      role: role ?? "waiter",
      phone,
      hourlyRate,
    });
    res.status(201).json({ user: (user as any).toPublic() });
  })
);

r.patch(
  "/:id",
  canManage,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = await User.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      req.body,
      { new: true }
    );
    if (!user) return res.status(404).json({ error: "Not found" });
    res.json({ user: (user as any).toPublic() });
  })
);

r.post(
  "/:id/clock",
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = await User.findOne({ _id: req.params.id, outletId: req.outletId });
    if (!user) return res.status(404).json({ error: "Not found" });
    const wasOn = !!user.clockedInAt;
    const now = new Date();
    user.clockedInAt = wasOn ? (null as any) : now;
    await user.save();

    // Mirror to Attendance records so we have a real history for payroll.
    if (!wasOn) {
      // Clock-in → create a new attendance row
      await Attendance.create({
        outletId: req.outletId,
        userId: user._id,
        clockedInAt: now,
      });
    } else {
      // Clock-out → close the most recent open attendance row for this user
      const open = await Attendance.findOne({
        outletId: req.outletId,
        userId: user._id,
        clockedOutAt: { $in: [null, undefined] },
      }).sort({ clockedInAt: -1 });
      if (open) {
        open.clockedOutAt = now;
        await open.save();
      }
    }
    await notify({
      outletId: req.outletId!,
      type: "staff.clock",
      level: "info",
      title: `${user.name} clocked ${wasOn ? "out" : "in"}`,
      body: `${user.role}${
        user.currentShift ? ` · ${user.currentShift}` : ""
      }`,
      link: "/staff",
      targetRoles: ["admin", "manager"],
    });
    res.json({ user: (user as any).toPublic() });
  })
);

export default r;
