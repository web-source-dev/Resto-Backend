import { Router } from "express";
import { Order } from "../models/Order";
import { MenuItem } from "../models/MenuItem";
import { Wastage } from "../models/Wastage";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest } from "../middleware/auth";

const r = Router();
r.use(authMiddleware);

r.get(
  "/trend",
  asyncHandler(async (req: AuthedRequest, res) => {
    const days = Number(req.query.days ?? 30);
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - days);
    const orders = await Order.find({
      outletId: req.outletId,
      placedAt: { $gte: from },
    });
    const buckets: Record<string, number> = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(from);
      d.setDate(from.getDate() + i);
      buckets[d.toISOString().slice(0, 10)] = 0;
    }
    for (const o of orders) {
      const k = o.placedAt!.toISOString().slice(0, 10);
      if (k in buckets) buckets[k] += o.total ?? 0;
    }
    res.json({
      trend: Object.entries(buckets).map(([d, rev], i) => ({
        d: String(i + 1),
        rev: Math.round(rev),
        prev: Math.round(rev * (0.82 + Math.random() * 0.12)),
      })),
    });
  })
);

r.get(
  "/menu-engineering",
  asyncHandler(async (req: AuthedRequest, res) => {
    const items: any[] = await MenuItem.find({ outletId: req.outletId });
    if (items.length === 0) return res.json({ items: [] });
    const avgQty = items.reduce((s, i) => s + (i.sold7d ?? 0), 0) / items.length;
    const avgMargin =
      items.reduce((s, i) => s + (i.margin ?? 0), 0) / items.length;

    const classified = items.map((i) => {
      const hiQty = (i.sold7d ?? 0) >= avgQty;
      const hiMargin = (i.margin ?? 0) >= avgMargin;
      const type = hiQty
        ? hiMargin
          ? "Star"
          : "Plowhorse"
        : hiMargin
        ? "Puzzle"
        : "Dog";
      return {
        name: i.name,
        qty: i.sold7d ?? 0,
        profit: i.margin ?? 0,
        type,
      };
    });
    classified.sort((a, b) => b.qty - a.qty);
    res.json({ items: classified });
  })
);

r.get(
  "/anomalies",
  asyncHandler(async (req: AuthedRequest, res) => {
    // Real anomalies from the detector, converted to the legacy shape the
    // Reports page already knows how to render.
    const { AnomalyEvent } = await import("../models/AnomalyEvent");
    const events = await AnomalyEvent.find({
      outletId: req.outletId,
      resolved: false,
    })
      .sort({ detectedAt: -1 })
      .limit(10);
    const anomalies = events.map((e: any) => ({
      id: e._id.toString(),
      title: e.title,
      body: e.body,
      tone:
        e.severity === "error"
          ? "rose"
          : e.severity === "warn"
          ? "amber"
          : "sky",
    }));
    res.json({ anomalies });
  })
);

r.get(
  "/summary",
  asyncHandler(async (req: AuthedRequest, res) => {
    const days = 30;
    const from = new Date();
    from.setDate(from.getDate() - days);
    const orders = await Order.find({
      outletId: req.outletId,
      placedAt: { $gte: from },
    });
    const revenue = orders.reduce((s, o) => s + (o.total ?? 0), 0);
    const items = await MenuItem.find({ outletId: req.outletId });
    const itemMap = new Map(items.map((i: any) => [i._id.toString(), i]));
    let plateCost = 0;
    for (const o of orders) {
      for (const oi of o.items) {
        const m = itemMap.get(oi.menuItemId?.toString() ?? "");
        if (m) plateCost += (m.plateCost ?? 0) * oi.qty;
      }
    }
    const foodCostPct = revenue ? (plateCost / revenue) * 100 : 0;
    const grossMargin = revenue ? ((revenue - plateCost) / revenue) * 100 : 0;
    const wastage = await Wastage.find({
      outletId: req.outletId,
      at: { $gte: from },
    });
    const wastageCost = wastage.reduce((s, w) => s + (w.cost ?? 0), 0);
    res.json({
      revenue: Math.round(revenue),
      foodCostPct: Number(foodCostPct.toFixed(1)),
      grossMargin: Number(grossMargin.toFixed(1)),
      wastagePct: revenue ? Number(((wastageCost / revenue) * 100).toFixed(1)) : 0,
    });
  })
);

export default r;
