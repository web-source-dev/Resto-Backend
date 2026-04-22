import { Router } from "express";
import { Shift } from "../models/Shift";
import { User } from "../models/User";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, requireRole } from "../middleware/auth";
import { notify } from "../services/notify";

const r = Router();
r.use(authMiddleware);

const canManage = requireRole("admin", "manager");

r.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const q: any = { outletId: req.outletId };
    if (req.query.from && req.query.to) {
      q.date = { $gte: req.query.from, $lte: req.query.to };
    } else if (req.query.date) {
      q.date = req.query.date;
    }
    if (req.query.userId) q.userId = req.query.userId;
    const shifts = await Shift.find(q)
      .populate("userId", "name role")
      .sort({ date: 1, startTime: 1 })
      .limit(Number(req.query.limit ?? 500));
    res.json({ shifts });
  })
);

r.post(
  "/",
  canManage,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { date, userId, startTime, endTime, role, notes } = req.body;
    if (!date || !userId || !startTime || !endTime)
      return res.status(400).json({ error: "date, userId, start, end required" });
    const s = await Shift.create({
      outletId: req.outletId,
      userId,
      date,
      startTime,
      endTime,
      role,
      notes,
      published: false,
    });
    res.status(201).json({ shift: s });
  })
);

r.patch(
  "/:id",
  canManage,
  asyncHandler(async (req: AuthedRequest, res) => {
    const s = await Shift.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      req.body,
      { new: true }
    );
    if (!s) return res.status(404).json({ error: "Not found" });
    res.json({ shift: s });
  })
);

r.delete(
  "/:id",
  canManage,
  asyncHandler(async (req: AuthedRequest, res) => {
    await Shift.deleteOne({ _id: req.params.id, outletId: req.outletId });
    res.json({ ok: true });
  })
);

// Publish a week's worth of shifts — sends a personal notification to each
// staff member whose shift got published.
r.post(
  "/publish",
  canManage,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { from, to } = req.body;
    if (!from || !to)
      return res.status(400).json({ error: "from + to required" });
    const shifts = await Shift.find({
      outletId: req.outletId,
      date: { $gte: from, $lte: to },
      published: { $ne: true },
    });
    const byUser: Record<string, number> = {};
    for (const s of shifts) {
      byUser[String(s.userId)] = (byUser[String(s.userId)] ?? 0) + 1;
    }
    await Shift.updateMany(
      {
        outletId: req.outletId,
        date: { $gte: from, $lte: to },
        published: { $ne: true },
      },
      { published: true }
    );
    for (const [uid, count] of Object.entries(byUser)) {
      await notify({
        outletId: req.outletId!,
        type: "staff.clock",
        level: "info",
        title: `${count} new shift${count === 1 ? "" : "s"} published`,
        body: `${from} → ${to}`,
        link: "/staff",
        targetUserId: uid,
      });
    }
    res.json({ ok: true, published: shifts.length });
  })
);

// Request a swap: any staff can request a swap on their own shift;
// management notified.
r.post(
  "/:id/request-swap",
  asyncHandler(async (req: AuthedRequest, res) => {
    const shift = await Shift.findOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    if (!shift) return res.status(404).json({ error: "Not found" });
    const me = req.user as any;
    if (String(shift.userId) !== String(me._id) && !["admin", "manager"].includes(me.role))
      return res.status(403).json({ error: "Not your shift" });
    shift.swapStatus = "requested";
    shift.swapRequestedByUserId = me._id;
    await shift.save();
    await notify({
      outletId: req.outletId!,
      type: "staff.clock",
      level: "warn",
      title: `Shift swap requested · ${shift.date} ${shift.startTime}`,
      body: `${me.name} asked to swap`,
      link: "/staff",
      targetRoles: ["admin", "manager"],
    });
    res.json({ shift });
  })
);

// Manager approves (or rejects) a swap to another staff
r.post(
  "/:id/approve-swap",
  canManage,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { targetUserId, approve } = req.body;
    const shift = await Shift.findOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    if (!shift) return res.status(404).json({ error: "Not found" });
    if (shift.swapStatus !== "requested")
      return res.status(409).json({ error: "No pending swap" });

    if (approve && targetUserId) {
      const prevUserId = shift.userId;
      shift.userId = targetUserId;
      shift.swapStatus = "approved";
      await shift.save();
      await notify({
        outletId: req.outletId!,
        type: "staff.clock",
        level: "success",
        title: `Swap approved · ${shift.date}`,
        body: `${shift.startTime}–${shift.endTime} · you're now on this shift`,
        link: "/staff",
        targetUserId: String(targetUserId),
      });
      await notify({
        outletId: req.outletId!,
        type: "staff.clock",
        level: "info",
        title: `Swap approved · your shift ${shift.date} is covered`,
        body: `${shift.startTime}–${shift.endTime}`,
        link: "/staff",
        targetUserId: String(prevUserId),
      });
    } else {
      shift.swapStatus = "rejected";
      await shift.save();
    }
    res.json({ shift });
  })
);

export default r;
