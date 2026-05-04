import { Router } from "express";
import { Category } from "../models/Category";
import { MenuItem } from "../models/MenuItem";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, requireRole } from "../middleware/auth";
import { audit } from "../services/audit";

const r = Router();
r.use(authMiddleware);

// Menu and recipes are admin-only — pricing, BOM, and 86 list are revenue-
// and cost-of-goods-sensitive enough that managers shouldn't edit them.
const canWrite = requireRole("admin");

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
    await audit({
      outletId: req.outletId!,
      userId: req.user?._id,
      userName: req.user?.name,
      action: "menu.item.create",
      targetType: "MenuItem",
      targetId: String(item._id),
      after: { name: item.name, price: item.price, active: item.active },
    });
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
    await audit({
      outletId: req.outletId!,
      userId: req.user?._id,
      userName: req.user?.name,
      action: "menu.item.bulk_create",
      targetType: "MenuItem",
      after: { count: created.length },
    });
    res.status(201).json({ created: created.length });
  })
);

r.patch(
  "/items/:id",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const before = await MenuItem.findOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    if (!before) return res.status(404).json({ error: "Not found" });
    const item = await MenuItem.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      req.body,
      { new: true }
    );
    if (!item) return res.status(404).json({ error: "Not found" });
    await audit({
      outletId: req.outletId!,
      userId: req.user?._id,
      userName: req.user?.name,
      action: "menu.item.update",
      targetType: "MenuItem",
      targetId: String(item._id),
      before: { name: before.name, price: before.price, active: before.active },
      after: {
        name: item.name,
        price: item.price,
        active: item.active,
        changed: Object.keys(req.body ?? {}),
      },
    });
    res.json({ item });
  })
);

r.delete(
  "/items/:id",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const before = await MenuItem.findOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    await MenuItem.deleteOne({ _id: req.params.id, outletId: req.outletId });
    await audit({
      outletId: req.outletId!,
      userId: req.user?._id,
      userName: req.user?.name,
      action: "menu.item.delete",
      targetType: "MenuItem",
      targetId: String(req.params.id),
      before: before ? { name: before.name, price: before.price } : undefined,
    });
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
    const wasActive = item.active;
    item.active = !item.active;
    await item.save();
    await audit({
      outletId: req.outletId!,
      userId: req.user?._id,
      userName: req.user?.name,
      action: "menu.item.toggle",
      targetType: "MenuItem",
      targetId: String(item._id),
      before: { name: item.name, active: wasActive },
      after: { name: item.name, active: item.active },
    });
    res.json({ item });
  })
);

export default r;
