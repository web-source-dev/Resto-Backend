import { Router } from "express";
import { Wastage } from "../models/Wastage";
import { Ingredient } from "../models/Ingredient";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, requireRole } from "../middleware/auth";
import { emit } from "../sockets";
import { notify } from "../services/notify";

const r = Router();
r.use(authMiddleware);
const canApprove = requireRole("admin", "manager");

r.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const logs = await Wastage.find({ outletId: req.outletId })
      .sort({ at: -1 })
      .limit(Number(req.query.limit ?? 100));
    res.json({ logs });
  })
);

r.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const {
      ingredientId,
      menuItemId,
      itemName,
      qty,
      unit,
      reason,
      shift,
      photo,
    } = req.body;
    let cost = 0;
    if (ingredientId) {
      const ing = await Ingredient.findById(ingredientId);
      if (ing) {
        cost = Math.round((ing.costPerUnit ?? 0) * Number(qty));
        ing.stock = Math.max(0, (ing.stock ?? 0) - Number(qty));
        await ing.save();
        emit("inventory:update", { id: ing._id.toString() }, req.outletId);
      }
    }
    const approved = cost < 500; // threshold per PRD
    const log = await Wastage.create({
      outletId: req.outletId,
      ingredientId,
      menuItemId,
      itemName,
      qty,
      unit,
      reason,
      cost,
      shift,
      photo,
      approved,
      staffId: (req.user as any)?._id,
      staffName: (req.user as any)?.name,
    });
    emit("wastage:new", log.toJSON(), req.outletId);
    // Always notify management; escalate level for spend above approval
    // threshold so they see it pinned in the feed.
    const high = !approved; // cost >= 500 was gated as needing approval
    await notify({
      outletId: req.outletId!,
      type: "wastage.new",
      level: high ? "warn" : "info",
      title: high
        ? `Wastage needs approval · ${itemName ?? "item"}`
        : `Wastage logged · ${itemName ?? "item"}`,
      body: `${qty} ${unit ?? ""} · ${reason}${
        cost ? ` · Rs ${cost.toLocaleString()}` : ""
      }${(req.user as any)?.name ? ` · by ${(req.user as any).name}` : ""}`,
      link: "/wastage",
      targetRoles: ["admin", "manager"],
    });
    res.status(201).json({ log });
  })
);

r.post(
  "/:id/approve",
  canApprove,
  asyncHandler(async (req: AuthedRequest, res) => {
    const log = await Wastage.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      { approved: true },
      { new: true }
    );
    if (!log) return res.status(404).json({ error: "Not found" });
    res.json({ log });
  })
);

r.get(
  "/summary",
  asyncHandler(async (req: AuthedRequest, res) => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const logs = await Wastage.find({
      outletId: req.outletId,
      at: { $gte: since },
    });
    const byReason: Record<string, { count: number; cost: number }> = {};
    let totalCost = 0;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    let today = 0;
    for (const l of logs) {
      totalCost += l.cost ?? 0;
      if (l.at >= todayStart) today += l.cost ?? 0;
      byReason[l.reason] ??= { count: 0, cost: 0 };
      byReason[l.reason].count += 1;
      byReason[l.reason].cost += l.cost ?? 0;
    }
    const pending = await Wastage.countDocuments({
      outletId: req.outletId,
      approved: false,
    });
    res.json({
      today,
      weekCost: totalCost,
      byReason,
      pendingApproval: pending,
    });
  })
);

export default r;
