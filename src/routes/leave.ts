import { Router } from "express";
import { LeaveRequest } from "../models/LeaveRequest";
import { User } from "../models/User";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, requireRole } from "../middleware/auth";
import { notify } from "../services/notify";

const r = Router();
r.use(authMiddleware);
const canDecide = requireRole("admin", "manager");

r.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const q: any = { outletId: req.outletId };
    if (req.query.userId) q.userId = req.query.userId;
    if (req.query.status) q.status = req.query.status;
    const items = await LeaveRequest.find(q)
      .populate("userId", "name role")
      .sort({ createdAt: -1 })
      .limit(Number(req.query.limit ?? 100));
    res.json({ items });
  })
);

r.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const me = req.user as any;
    const { userId, from, to, type, reason } = req.body;
    // Staff can only file for themselves; admin/manager can file on behalf
    const forUserId =
      ["admin", "manager"].includes(me.role) && userId ? userId : me._id;
    const target = await User.findById(forUserId);
    if (!target) return res.status(400).json({ error: "Invalid user" });
    const item = await LeaveRequest.create({
      outletId: req.outletId,
      userId: forUserId,
      userName: target.name,
      from: new Date(from),
      to: new Date(to),
      type: type ?? "personal",
      reason,
      status: "Pending",
    });
    await notify({
      outletId: req.outletId!,
      type: "staff.clock",
      level: "warn",
      title: `Leave request · ${target.name}`,
      body: `${type ?? "personal"} · ${new Date(from).toLocaleDateString()} → ${new Date(to).toLocaleDateString()}`,
      link: "/staff",
      targetRoles: ["admin", "manager"],
    });
    res.status(201).json({ item });
  })
);

r.post(
  "/:id/decide",
  canDecide,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { approve, note } = req.body;
    const me = req.user as any;
    const item = await LeaveRequest.findOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    if (!item) return res.status(404).json({ error: "Not found" });
    if (item.status !== "Pending")
      return res.status(409).json({ error: "Already decided" });
    item.status = approve ? "Approved" : "Rejected";
    item.decidedByUserId = me._id;
    item.decidedByName = me.name;
    item.decidedAt = new Date();
    item.decisionNote = note;
    await item.save();
    await notify({
      outletId: req.outletId!,
      type: "staff.clock",
      level: approve ? "success" : "warn",
      title: `Leave ${approve ? "approved" : "rejected"}`,
      body: `${new Date(item.from).toLocaleDateString()} → ${new Date(item.to).toLocaleDateString()}${note ? ` · ${note}` : ""}`,
      link: "/staff",
      targetUserId: String(item.userId),
    });
    res.json({ item });
  })
);

export default r;
