import { Router } from "express";
import { Order } from "../models/Order";
import { MenuItem } from "../models/MenuItem";
import { Wastage } from "../models/Wastage";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest } from "../middleware/auth";

const r = Router();
r.use(authMiddleware);

function parseRange(query: any) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const fromRaw = typeof query.from === "string" ? query.from : undefined;
  const toRaw = typeof query.to === "string" ? query.to : undefined;
  const days = Math.max(1, Number(query.days ?? 30));

  let from = today;
  let to = new Date(today);
  to.setDate(to.getDate() + 1);

  if (fromRaw) {
    const parsedFrom = new Date(fromRaw);
    if (!Number.isNaN(parsedFrom.getTime())) from = parsedFrom;
  } else {
    from = new Date(today);
    from.setDate(from.getDate() - days);
  }

  if (toRaw) {
    const parsedTo = new Date(toRaw);
    if (!Number.isNaN(parsedTo.getTime())) {
      to = new Date(parsedTo);
      to.setHours(23, 59, 59, 999);
    }
  }

  return { from, to };
}

r.get(
  "/trend",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { from, to } = parseRange(req.query);
    const msInDay = 24 * 60 * 60 * 1000;
    const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / msInDay));
    const prevFrom = new Date(from.getTime() - days * msInDay);
    const prevTo = new Date(from.getTime() - 1);
    const orders = await Order.find({
      outletId: req.outletId,
      placedAt: { $gte: from, $lte: to },
    });
    const prevOrders = await Order.find({
      outletId: req.outletId,
      placedAt: { $gte: prevFrom, $lte: prevTo },
    });
    const buckets: Record<string, number> = {};
    const prevBuckets: Record<string, number> = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(from);
      d.setDate(from.getDate() + i);
      buckets[d.toISOString().slice(0, 10)] = 0;
      const p = new Date(prevFrom);
      p.setDate(prevFrom.getDate() + i);
      prevBuckets[p.toISOString().slice(0, 10)] = 0;
    }
    for (const o of orders) {
      const k = o.placedAt!.toISOString().slice(0, 10);
      if (k in buckets) buckets[k] += o.total ?? 0;
    }
    for (const o of prevOrders) {
      const k = o.placedAt!.toISOString().slice(0, 10);
      if (k in prevBuckets) prevBuckets[k] += o.total ?? 0;
    }
    res.json({
      from,
      to,
      trend: Object.keys(buckets).map((k, i) => {
        const p = new Date(prevFrom);
        p.setDate(prevFrom.getDate() + i);
        const prevKey = p.toISOString().slice(0, 10);
        return {
          d: String(i + 1),
          rev: Math.round(buckets[k] ?? 0),
          prev: Math.round(prevBuckets[prevKey] ?? 0),
        };
      }),
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
    const { from, to } = parseRange(req.query);
    const orders = await Order.find({
      outletId: req.outletId,
      placedAt: { $gte: from, $lte: to },
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
      at: { $gte: from, $lte: to },
    });
    const wastageCost = wastage.reduce((s, w) => s + (w.cost ?? 0), 0);
    res.json({
      from,
      to,
      revenue: Math.round(revenue),
      foodCostPct: Number(foodCostPct.toFixed(1)),
      grossMargin: Number(grossMargin.toFixed(1)),
      wastagePct: revenue ? Number(((wastageCost / revenue) * 100).toFixed(1)) : 0,
    });
  })
);

r.get(
  "/export",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { from, to } = parseRange(req.query);
    const orders = await Order.find({
      outletId: req.outletId,
      placedAt: { $gte: from, $lte: to },
    }).sort({ placedAt: 1 });

    res.json({
      from,
      to,
      orders: orders.map((o: any) => ({
        code: o.code,
        placedAt: o.placedAt,
        channel: o.channel,
        tableCode: o.tableCode ?? "",
        customerName: o.customerName ?? "Walk-in",
        items: o.items?.length ?? 0,
        subtotal: o.subtotal ?? 0,
        tax: o.tax ?? 0,
        service: o.service ?? 0,
        total: o.total ?? 0,
        status: o.status,
        paymentStatus: o.paymentStatus,
      })),
    });
  })
);

export default r;
