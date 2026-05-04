import { Router } from "express";
import { Ingredient } from "../models/Ingredient";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, requireRole, excludeRoles } from "../middleware/auth";
import { emit } from "../sockets";
import { audit } from "../services/audit";
import { recomputeMenuStockStatusForIngredient } from "../services/orderService";

const r = Router();
r.use(authMiddleware);
// Block riders from this resource — not relevant to delivery work and may
// contain PII or operational data they shouldn't see.
r.use(excludeRoles("rider"));
// Stock and inventory edits are restricted to admin + manager. Kitchen and
// receptionist can still see stock (read-only) and trigger consumption via
// orders/wastage/supplies, but they can't add, restock, or adjust counts.
const canWrite = requireRole("admin", "manager");

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
    await audit({
      outletId: req.outletId!,
      userId: req.user?._id,
      userName: req.user?.name,
      action: "inventory.create",
      targetType: "Ingredient",
      targetId: String(item._id),
      after: {
        sku: item.sku,
        name: item.name,
        category: item.category,
        unit: item.unit,
        stock: item.stock,
        costPerUnit: item.costPerUnit,
      },
    });
    res.status(201).json({ item });
  })
);

r.patch(
  "/:id",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const before = await Ingredient.findOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    if (!before) return res.status(404).json({ error: "Not found" });
    const item = await Ingredient.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      req.body,
      { new: true }
    );
    if (!item) return res.status(404).json({ error: "Not found" });
    emit("inventory:update", { id: item._id.toString() }, req.outletId);
    await recomputeMenuStockStatusForIngredient(item._id);
    await audit({
      outletId: req.outletId!,
      userId: req.user?._id,
      userName: req.user?.name,
      action: "inventory.update",
      targetType: "Ingredient",
      targetId: String(item._id),
      before: {
        name: before.name,
        stock: before.stock,
        par: before.par,
        costPerUnit: before.costPerUnit,
      },
      after: {
        name: item.name,
        stock: item.stock,
        par: item.par,
        costPerUnit: item.costPerUnit,
        // Only the keys the user actually sent — useful for diffing.
        changed: Object.keys(req.body ?? {}),
      },
    });
    res.json({ item });
  })
);

r.post(
  "/:id/adjust",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { delta, reason } = req.body;
    const item = await Ingredient.findOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    if (!item) return res.status(404).json({ error: "Not found" });
    const prevStock = item.stock ?? 0;
    // Round to 4dp so adjustments don't drift like the order BOM path used to.
    item.stock = Math.round(Math.max(0, prevStock + Number(delta ?? 0)) * 10000) / 10000;
    await item.save();
    emit("inventory:update", { id: item._id.toString() }, req.outletId);
    await recomputeMenuStockStatusForIngredient(item._id);
    await audit({
      outletId: req.outletId!,
      userId: req.user?._id,
      userName: req.user?.name,
      action: "inventory.adjust",
      targetType: "Ingredient",
      targetId: String(item._id),
      before: { name: item.name, stock: prevStock },
      after: { name: item.name, stock: item.stock, delta: Number(delta), reason },
    });
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
