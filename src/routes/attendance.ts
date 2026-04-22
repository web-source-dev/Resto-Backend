import { Router } from "express";
import { Attendance } from "../models/Attendance";
import { User } from "../models/User";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest } from "../middleware/auth";

const r = Router();
r.use(authMiddleware);

r.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const q: any = { outletId: req.outletId };
    if (req.query.userId) q.userId = req.query.userId;
    if (req.query.from || req.query.to) {
      q.clockedInAt = {};
      if (req.query.from)
        (q.clockedInAt as any).$gte = new Date(String(req.query.from));
      if (req.query.to)
        (q.clockedInAt as any).$lte = new Date(String(req.query.to));
    }
    const entries = await Attendance.find(q)
      .populate("userId", "name role hourlyRate")
      .sort({ clockedInAt: -1 })
      .limit(Number(req.query.limit ?? 200));
    res.json({ entries });
  })
);

// Payroll summary — hours × hourly rate for the period
r.get(
  "/payroll",
  asyncHandler(async (req: AuthedRequest, res) => {
    const from = req.query.from
      ? new Date(String(req.query.from))
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const to = req.query.to
      ? new Date(String(req.query.to))
      : new Date();

    const entries = await Attendance.find({
      outletId: req.outletId,
      clockedInAt: { $gte: from, $lte: to },
      clockedOutAt: { $exists: true, $ne: null },
    });
    const users = await User.find({ outletId: req.outletId });
    const userMap = new Map(users.map((u: any) => [String(u._id), u]));
    const agg = new Map<string, { hours: number; entries: number }>();
    for (const e of entries) {
      if (!e.clockedOutAt) continue;
      const minutes =
        (e.clockedOutAt.getTime() - e.clockedInAt.getTime()) / 60000 -
        (e.breakMinutes ?? 0);
      const hours = Math.max(0, minutes / 60);
      const k = String(e.userId);
      const cur = agg.get(k) ?? { hours: 0, entries: 0 };
      agg.set(k, { hours: cur.hours + hours, entries: cur.entries + 1 });
    }
    const rows = Array.from(agg.entries()).map(([userId, v]) => {
      const u: any = userMap.get(userId);
      const rate = u?.hourlyRate ?? 0;
      return {
        userId,
        name: u?.name ?? "?",
        role: u?.role ?? "?",
        hourlyRate: rate,
        hours: Number(v.hours.toFixed(2)),
        entries: v.entries,
        pay: Math.round(v.hours * rate),
      };
    });
    rows.sort((a, b) => b.pay - a.pay);
    res.json({
      from,
      to,
      rows,
      totalPay: rows.reduce((s, r) => s + r.pay, 0),
      totalHours: Number(
        rows.reduce((s, r) => s + r.hours, 0).toFixed(2)
      ),
    });
  })
);

export default r;
