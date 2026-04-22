import { Router } from "express";
import { Category } from "../models/Category";
import { MenuItem } from "../models/MenuItem";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, requireRole } from "../middleware/auth";

const r = Router();
r.use(authMiddleware);

const canWrite = requireRole("admin", "manager");

r.get(
  "/categories",
  asyncHandler(async (req: AuthedRequest, res) => {
    const categories = await Category.find({ outletId: req.outletId }).sort({
      sortOrder: 1,
      name: 1,
    });
    const counts = await MenuItem.aggregate([
      { $match: { outletId: (req.user as any).outletId } },
      { $group: { _id: "$categoryId", count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((c) => [c._id.toString(), c.count]));
    res.json({
      categories: categories.map((c) => ({
        ...c.toJSON(),
        count: countMap.get(c._id.toString()) ?? 0,
      })),
    });
  })
);

r.post(
  "/categories",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const c = await Category.create({ outletId: req.outletId, ...req.body });
    res.status(201).json({ category: c });
  })
);

r.get(
  "/items",
  asyncHandler(async (req: AuthedRequest, res) => {
    const q: any = { outletId: req.outletId };
    if (req.query.categoryId) q.categoryId = req.query.categoryId;
    if (req.query.active) q.active = req.query.active === "true";
    const items = await MenuItem.find(q).sort({ name: 1 });
    res.json({ items });
  })
);

r.post(
  "/items",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const item = await MenuItem.create({ outletId: req.outletId, ...req.body });
    res.status(201).json({ item });
  })
);

r.post(
  "/items/bulk",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const rows: any[] = req.body.items ?? [];
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "items[] required" });
    }
    const created = await MenuItem.insertMany(
      rows.map((r) => ({ outletId: req.outletId, ...r }))
    );
    res.status(201).json({ created: created.length });
  })
);

r.patch(
  "/items/:id",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const item = await MenuItem.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      req.body,
      { new: true }
    );
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json({ item });
  })
);

r.delete(
  "/items/:id",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    await MenuItem.deleteOne({ _id: req.params.id, outletId: req.outletId });
    res.json({ ok: true });
  })
);

r.post(
  "/items/:id/toggle",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const item = await MenuItem.findOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    if (!item) return res.status(404).json({ error: "Not found" });
    item.active = !item.active;
    await item.save();
    res.json({ item });
  })
);

export default r;
