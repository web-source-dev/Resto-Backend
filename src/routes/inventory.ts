import { Router } from "express";
import { Ingredient } from "../models/Ingredient";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, requireRole } from "../middleware/auth";
import { emit } from "../sockets";

const r = Router();
r.use(authMiddleware);
const canWrite = requireRole("admin", "manager", "receptionist", "kitchen");

r.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const items = await Ingredient.find({ outletId: req.outletId }).sort({ name: 1 });
    res.json({ items });
  })
);

r.post(
  "/",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const item = await Ingredient.create({ outletId: req.outletId, ...req.body });
    emit("inventory:update", { id: item._id.toString() }, req.outletId);
    res.status(201).json({ item });
  })
);

r.patch(
  "/:id",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const item = await Ingredient.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      req.body,
      { new: true }
    );
    if (!item) return res.status(404).json({ error: "Not found" });
    emit("inventory:update", { id: item._id.toString() }, req.outletId);
    res.json({ item });
  })
);

r.post(
  "/:id/adjust",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { delta } = req.body;
    const item = await Ingredient.findOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    if (!item) return res.status(404).json({ error: "Not found" });
    item.stock = Math.max(0, (item.stock ?? 0) + Number(delta ?? 0));
    await item.save();
    emit("inventory:update", { id: item._id.toString() }, req.outletId);
    res.json({ item });
  })
);

r.get(
  "/summary",
  asyncHandler(async (req: AuthedRequest, res) => {
    const items = await Ingredient.find({ outletId: req.outletId });
    let value = 0;
    let low = 0;
    let out = 0;
    let expiring = 0;
    const now = Date.now();
    const threeDays = 3 * 24 * 60 * 60 * 1000;
    for (const i of items) {
      value += (i.stock ?? 0) * (i.costPerUnit ?? 0);
      if ((i.stock ?? 0) <= 0) out += 1;
      else if ((i.stock ?? 0) < (i.par ?? 0)) low += 1;
      if (i.expiresAt && i.expiresAt.getTime() - now < threeDays) expiring += 1;
    }
    res.json({
      total: items.length,
      value: Math.round(value),
      low,
      out,
      expiring,
    });
  })
);

export default r;
