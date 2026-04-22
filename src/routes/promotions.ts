import { Router } from "express";
import { Promotion } from "../models/Promotion";
import { PricingRule } from "../models/PricingRule";
import { Outlet } from "../models/Outlet";
import { Customer } from "../models/Customer";
import { MenuItem } from "../models/MenuItem";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, requireRole } from "../middleware/auth";
import { priceOrder } from "../services/pricingEngine";

const r = Router();
r.use(authMiddleware);
const canWrite = requireRole("admin", "manager");

// ─── Promotions ────────────────────────────────────────────────────────────

r.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const items = await Promotion.find({ outletId: req.outletId }).sort({
      createdAt: -1,
    });
    res.json({ items });
  })
);

r.post(
  "/",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = { ...req.body };
    if (body.code) body.code = String(body.code).toUpperCase().trim();
    const item = await Promotion.create({
      outletId: req.outletId,
      createdBy: (req.user as any)?._id,
      ...body,
    });
    res.status(201).json({ item });
  })
);

r.patch(
  "/:id",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = { ...req.body };
    if (body.code) body.code = String(body.code).toUpperCase().trim();
    const item = await Promotion.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      body,
      { new: true }
    );
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json({ item });
  })
);

r.post(
  "/:id/toggle",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const p = await Promotion.findOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    if (!p) return res.status(404).json({ error: "Not found" });
    p.active = !p.active;
    await p.save();
    res.json({ item: p });
  })
);

r.delete(
  "/:id",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    await Promotion.deleteOne({ _id: req.params.id, outletId: req.outletId });
    res.json({ ok: true });
  })
);

// Validate a coupon + compute tentative discount — used by the checkout UI
r.post(
  "/validate",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { code, items = [], customerPhone, channel } = req.body ?? {};
    if (!code) return res.status(400).json({ ok: false, reason: "Code required" });
    const outlet = await Outlet.findById(req.outletId);
    if (!outlet) return res.status(404).json({ ok: false, reason: "Outlet missing" });

    let customerId: string | undefined;
    if (customerPhone) {
      const c = await Customer.findOne({
        outletId: req.outletId,
        phone: customerPhone,
      });
      if (c) customerId = c._id.toString();
    }

    const menuIds = (items as any[])
      .map((i) => i.menuItemId)
      .filter(Boolean);
    const menus = await MenuItem.find({ _id: { $in: menuIds } });
    const menuMap = new Map(menus.map((m: any) => [m._id.toString(), m]));
    const pricedItems = (items as any[]).map((i) => {
      const m: any = menuMap.get(i.menuItemId);
      return {
        menuItemId: i.menuItemId,
        name: m?.name ?? "",
        qty: Number(i.qty) || 1,
        price: Number(m?.price ?? 0),
        categoryId: m?.categoryId?.toString(),
        isCombo: m?.isCombo,
      };
    });

    const result = await priceOrder({
      outletId: req.outletId!,
      channel: channel ?? "Dine-in",
      items: pricedItems,
      customerId,
      couponCode: code,
      taxRate: outlet.taxRate ?? 0,
      serviceRate: outlet.serviceRate ?? 0,
    });
    res.json({
      ok: result.couponValidation?.ok ?? false,
      reason: result.couponValidation?.reason,
      discountAmount: result.discountAmount,
      discountLines: result.discountLines,
      newTotal: result.total,
    });
  })
);

// ─── Pricing rules ─────────────────────────────────────────────────────────

r.get(
  "/rules",
  asyncHandler(async (req: AuthedRequest, res) => {
    const items = await PricingRule.find({ outletId: req.outletId }).sort({
      createdAt: -1,
    });
    res.json({ items });
  })
);

r.post(
  "/rules",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const item = await PricingRule.create({
      outletId: req.outletId,
      ...req.body,
    });
    res.status(201).json({ item });
  })
);

r.patch(
  "/rules/:id",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const item = await PricingRule.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      req.body,
      { new: true }
    );
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json({ item });
  })
);

r.post(
  "/rules/:id/toggle",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const p = await PricingRule.findOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    if (!p) return res.status(404).json({ error: "Not found" });
    p.active = !p.active;
    await p.save();
    res.json({ item: p });
  })
);

r.delete(
  "/rules/:id",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    await PricingRule.deleteOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    res.json({ ok: true });
  })
);

export default r;
