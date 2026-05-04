import { Router } from "express";
import { Types } from "mongoose";
import { Order } from "../models/Order";
import { MenuItem } from "../models/MenuItem";
import { Wastage } from "../models/Wastage";
import { Expense } from "../models/Expense";
import { Customer } from "../models/Customer";
import { User } from "../models/User";
import { Ingredient } from "../models/Ingredient";
import { AuditLog } from "../models/AuditLog";
import { AnomalyEvent } from "../models/AnomalyEvent";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest } from "../middleware/auth";

const r = Router();
r.use(authMiddleware);

// ──────────────────────────────────────────────────────────────────────
// Date-range parsing.
// Supports `?from=YYYY-MM-DD&to=YYYY-MM-DD` OR `?days=N` (default 30).
// `to` is inclusive (extends to end-of-day) so `from=today&to=today`
// returns the full day.
// ──────────────────────────────────────────────────────────────────────
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
    if (!Number.isNaN(parsedFrom.getTime())) {
      from = parsedFrom;
      from.setHours(0, 0, 0, 0);
    }
  } else {
    from = new Date(today);
    from.setDate(from.getDate() - days);
  }

  if (toRaw) {
    const parsedTo = new Date(toRaw);
    if (!Number.isNaN(parsedTo.getTime())) {
      to = parsedTo;
      to.setHours(23, 59, 59, 999);
    }
  }

  return { from, to };
}

/** Returns the prior period of the same length, ending one ms before `from`. */
function priorRange(from: Date, to: Date) {
  const span = to.getTime() - from.getTime();
  return {
    prevFrom: new Date(from.getTime() - span - 1),
    prevTo: new Date(from.getTime() - 1),
  };
}

function pct(curr: number, prev: number): number | null {
  if (!prev) return null;
  return Number((((curr - prev) / prev) * 100).toFixed(1));
}

// ══════════════════════════════════════════════════════════════════════
// SALES — KPI strip with deltas, trend, channel mix, hour heatmap,
// top items, payment mix.
// ══════════════════════════════════════════════════════════════════════

r.get(
  "/summary",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { from, to } = parseRange(req.query);
    const { prevFrom, prevTo } = priorRange(from, to);
    const outletId = new Types.ObjectId(req.outletId!);

    // Aggregate the current and prior periods in parallel — saves a
    // round-trip vs querying twice.
    const [curr, prev, items, wastage, prevWastage] = await Promise.all([
      Order.aggregate([
        { $match: { outletId, placedAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: null,
            revenue: { $sum: "$total" },
            orders: { $sum: 1 },
            cancelled: {
              $sum: { $cond: [{ $eq: ["$status", "Cancelled"] }, 1, 0] },
            },
          },
        },
      ]),
      Order.aggregate([
        { $match: { outletId, placedAt: { $gte: prevFrom, $lte: prevTo } } },
        {
          $group: {
            _id: null,
            revenue: { $sum: "$total" },
            orders: { $sum: 1 },
          },
        },
      ]),
      MenuItem.find({ outletId: req.outletId }),
      Wastage.find({ outletId: req.outletId, at: { $gte: from, $lte: to } }),
      Wastage.find({
        outletId: req.outletId,
        at: { $gte: prevFrom, $lte: prevTo },
      }),
    ]);

    const c = curr[0] ?? { revenue: 0, orders: 0, cancelled: 0 };
    const p = prev[0] ?? { revenue: 0, orders: 0 };

    // Plate-cost / food-cost sweep over current orders.
    const itemMap = new Map(items.map((i: any) => [i._id.toString(), i]));
    const period = await Order.find({
      outletId,
      placedAt: { $gte: from, $lte: to },
    });
    let plateCost = 0;
    for (const o of period) {
      for (const oi of o.items as any[]) {
        if (oi.status === "Cancelled") continue;
        const m: any = itemMap.get(oi.menuItemId?.toString() ?? "");
        if (m) plateCost += (m.plateCost ?? 0) * oi.qty;
      }
    }

    const wastageCost = wastage.reduce((s, w) => s + (w.cost ?? 0), 0);
    const prevWastageCost = prevWastage.reduce((s, w) => s + (w.cost ?? 0), 0);
    const aov = c.orders ? c.revenue / c.orders : 0;
    const prevAov = p.orders ? p.revenue / p.orders : 0;
    const foodCostPct = c.revenue ? (plateCost / c.revenue) * 100 : 0;
    const grossMargin = c.revenue
      ? ((c.revenue - plateCost) / c.revenue) * 100
      : 0;
    const cancellationRate = c.orders ? (c.cancelled / c.orders) * 100 : 0;

    res.json({
      from,
      to,
      revenue: Math.round(c.revenue),
      orders: c.orders,
      aov: Math.round(aov),
      cancelled: c.cancelled,
      foodCostPct: Number(foodCostPct.toFixed(1)),
      grossMargin: Number(grossMargin.toFixed(1)),
      wastageCost: Math.round(wastageCost),
      wastagePct: c.revenue ? Number(((wastageCost / c.revenue) * 100).toFixed(1)) : 0,
      cancellationRate: Number(cancellationRate.toFixed(1)),
      // Day-over-day-style deltas — `null` when prior period had no data.
      deltas: {
        revenue: pct(c.revenue, p.revenue),
        orders: pct(c.orders, p.orders),
        aov: pct(aov, prevAov),
        wastageCost: pct(wastageCost, prevWastageCost),
      },
    });
  })
);

r.get(
  "/trend",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { from, to } = parseRange(req.query);
    const msInDay = 24 * 60 * 60 * 1000;
    const days = Math.max(
      1,
      Math.ceil((to.getTime() - from.getTime()) / msInDay)
    );
    const { prevFrom, prevTo } = priorRange(from, to);

    const outletId = new Types.ObjectId(req.outletId!);

    const [currAgg, prevAgg, channelAgg] = await Promise.all([
      Order.aggregate([
        { $match: { outletId, placedAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$placedAt" } },
            rev: { $sum: "$total" },
            count: { $sum: 1 },
          },
        },
      ]),
      Order.aggregate([
        { $match: { outletId, placedAt: { $gte: prevFrom, $lte: prevTo } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$placedAt" } },
            rev: { $sum: "$total" },
          },
        },
      ]),
      Order.aggregate([
        { $match: { outletId, placedAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: "%Y-%m-%d", date: "$placedAt" } },
              channel: "$channel",
            },
            rev: { $sum: "$total" },
          },
        },
      ]),
    ]);

    const buckets: Record<string, number> = {};
    const counts: Record<string, number> = {};
    const prevBuckets: Record<string, number> = {};
    const channelBuckets: Record<string, Record<string, number>> = {};

    for (let i = 0; i < days; i++) {
      const d = new Date(from);
      d.setDate(from.getDate() + i);
      const k = d.toISOString().slice(0, 10);
      buckets[k] = 0;
      counts[k] = 0;
      channelBuckets[k] = { "Dine-in": 0, Takeaway: 0, Delivery: 0, Phone: 0 };
      const p = new Date(prevFrom);
      p.setDate(prevFrom.getDate() + i);
      prevBuckets[p.toISOString().slice(0, 10)] = 0;
    }
    for (const row of currAgg) {
      buckets[row._id] = (buckets[row._id] ?? 0) + (row.rev ?? 0);
      counts[row._id] = (counts[row._id] ?? 0) + (row.count ?? 0);
    }
    for (const row of prevAgg) {
      prevBuckets[row._id] = (prevBuckets[row._id] ?? 0) + (row.rev ?? 0);
    }
    for (const row of channelAgg) {
      const dKey = row._id.date;
      const ch = row._id.channel ?? "Other";
      if (!channelBuckets[dKey]) continue;
      channelBuckets[dKey][ch] = (channelBuckets[dKey][ch] ?? 0) + (row.rev ?? 0);
    }

    const prevHasData = prevAgg.length > 0;
    res.json({
      from,
      to,
      prevAvailable: prevHasData,
      trend: Object.keys(buckets).map((k, i) => {
        const p = new Date(prevFrom);
        p.setDate(prevFrom.getDate() + i);
        const prevKey = p.toISOString().slice(0, 10);
        return {
          d: String(i + 1),
          date: k,
          rev: Math.round(buckets[k] ?? 0),
          count: counts[k] ?? 0,
          prev: prevHasData ? Math.round(prevBuckets[prevKey] ?? 0) : null,
          dineIn: Math.round(channelBuckets[k]?.["Dine-in"] ?? 0),
          takeaway: Math.round(channelBuckets[k]?.Takeaway ?? 0),
          delivery: Math.round(channelBuckets[k]?.Delivery ?? 0),
          phone: Math.round(channelBuckets[k]?.Phone ?? 0),
        };
      }),
    });
  })
);

r.get(
  "/channels",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { from, to } = parseRange(req.query);
    const outletId = new Types.ObjectId(req.outletId!);
    const rows = await Order.aggregate([
      { $match: { outletId, placedAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: "$channel",
          revenue: { $sum: "$total" },
          orders: { $sum: 1 },
        },
      },
    ]);
    const total = rows.reduce((s, r) => s + (r.revenue ?? 0), 0);
    res.json({
      from,
      to,
      total: Math.round(total),
      channels: rows
        .map((r) => ({
          channel: r._id ?? "Other",
          revenue: Math.round(r.revenue ?? 0),
          orders: r.orders ?? 0,
          share: total ? Number((((r.revenue ?? 0) / total) * 100).toFixed(1)) : 0,
        }))
        .sort((a, b) => b.revenue - a.revenue),
    });
  })
);

r.get(
  "/hour-heatmap",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { from, to } = parseRange(req.query);
    const outletId = new Types.ObjectId(req.outletId!);
    // Server-side aggregation by (dayOfWeek, hourOfDay) — way faster than
    // pulling N orders to JS and bucketing.
    const rows = await Order.aggregate([
      { $match: { outletId, placedAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: {
            dow: { $dayOfWeek: "$placedAt" }, // 1 = Sunday
            hour: { $hour: "$placedAt" },
          },
          orders: { $sum: 1 },
          revenue: { $sum: "$total" },
        },
      },
    ]);
    // Build a 7×24 grid for the frontend; weeks normalised to Mon-first.
    const grid: { dow: number; hour: number; orders: number; revenue: number }[] = [];
    for (let dow = 0; dow < 7; dow++) {
      for (let h = 0; h < 24; h++) {
        grid.push({ dow, hour: h, orders: 0, revenue: 0 });
      }
    }
    for (const row of rows) {
      // Mongo dayOfWeek: 1=Sun..7=Sat → convert to 0=Mon..6=Sun.
      const m = (row._id.dow + 5) % 7;
      const idx = m * 24 + row._id.hour;
      grid[idx].orders = row.orders ?? 0;
      grid[idx].revenue = Math.round(row.revenue ?? 0);
    }
    const peakRow = [...grid].sort((a, b) => b.orders - a.orders)[0];
    res.json({ from, to, grid, peak: peakRow });
  })
);

r.get(
  "/top-items",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { from, to } = parseRange(req.query);
    const outletId = new Types.ObjectId(req.outletId!);
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 20), 100));
    const by = req.query.by === "qty" ? "qty" : "revenue";
    const rows = await Order.aggregate([
      { $match: { outletId, placedAt: { $gte: from, $lte: to } } },
      { $unwind: "$items" },
      { $match: { "items.status": { $ne: "Cancelled" } } },
      {
        $group: {
          _id: { menuItemId: "$items.menuItemId", name: "$items.name" },
          qty: { $sum: "$items.qty" },
          revenue: { $sum: { $multiply: ["$items.price", "$items.qty"] } },
          orders: { $sum: 1 },
        },
      },
      { $sort: by === "qty" ? { qty: -1 } : { revenue: -1 } },
      { $limit: limit },
    ]);
    res.json({
      from,
      to,
      by,
      items: rows.map((r) => ({
        menuItemId: r._id.menuItemId,
        name: r._id.name,
        qty: r.qty ?? 0,
        revenue: Math.round(r.revenue ?? 0),
        orders: r.orders ?? 0,
      })),
    });
  })
);

r.get(
  "/payment-mix",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { from, to } = parseRange(req.query);
    const outletId = new Types.ObjectId(req.outletId!);
    const rows = await Order.aggregate([
      {
        $match: {
          outletId,
          placedAt: { $gte: from, $lte: to },
          paymentStatus: "Paid",
        },
      },
      {
        $group: {
          _id: "$paymentMethod",
          revenue: { $sum: { $ifNull: ["$paidAmount", "$total"] } },
          orders: { $sum: 1 },
        },
      },
    ]);
    const total = rows.reduce((s, r) => s + (r.revenue ?? 0), 0);
    res.json({
      from,
      to,
      total: Math.round(total),
      methods: rows
        .map((r) => ({
          method: r._id ?? "Unknown",
          revenue: Math.round(r.revenue ?? 0),
          orders: r.orders ?? 0,
          share: total ? Number((((r.revenue ?? 0) / total) * 100).toFixed(1)) : 0,
        }))
        .sort((a, b) => b.revenue - a.revenue),
    });
  })
);

// ══════════════════════════════════════════════════════════════════════
// MENU
// ══════════════════════════════════════════════════════════════════════

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
        id: i._id,
        name: i.name,
        sold7d: i.sold7d ?? 0,
        margin: i.margin ?? 0,
        price: i.price,
        type,
      };
    });
    res.json({ items: classified });
  })
);

// ══════════════════════════════════════════════════════════════════════
// PEOPLE — sales by waiter, top customers
// ══════════════════════════════════════════════════════════════════════

r.get(
  "/sales-by-waiter",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { from, to } = parseRange(req.query);
    const outletId = new Types.ObjectId(req.outletId!);
    const rows = await Order.aggregate([
      {
        $match: {
          outletId,
          placedAt: { $gte: from, $lte: to },
          waiterId: { $ne: null },
          status: { $ne: "Cancelled" },
        },
      },
      {
        $group: {
          _id: "$waiterId",
          revenue: { $sum: "$total" },
          orders: { $sum: 1 },
          covers: { $sum: { $size: "$items" } },
        },
      },
      { $sort: { revenue: -1 } },
    ]);
    // Hydrate names from User collection.
    const userIds = rows.map((r) => r._id).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }).select("name role");
    const uMap = new Map(users.map((u: any) => [String(u._id), u]));
    res.json({
      from,
      to,
      waiters: rows.map((r) => {
        const u: any = uMap.get(String(r._id));
        const aov = r.orders ? r.revenue / r.orders : 0;
        return {
          waiterId: String(r._id),
          name: u?.name ?? "Unknown",
          orders: r.orders ?? 0,
          revenue: Math.round(r.revenue ?? 0),
          aov: Math.round(aov),
          covers: r.covers ?? 0,
        };
      }),
    });
  })
);

r.get(
  "/top-customers",
  asyncHandler(async (req: AuthedRequest, res) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 25), 100));
    const sortBy = String(req.query.by ?? "ltv");
    const sort: any = { ltv: -1 };
    if (sortBy === "visits") sort.visits = -1;
    if (sortBy === "lastVisit") sort.lastVisit = -1;
    const customers = await Customer.find({ outletId: req.outletId })
      .sort(sort)
      .limit(limit);
    res.json({
      customers: customers.map((c: any) => ({
        id: c._id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        ltv: Math.round(c.ltv ?? 0),
        points: c.points ?? 0,
        tier: c.tier ?? "Bronze",
        visits: c.visits ?? 0,
        favoriteItem: c.favoriteItemName ?? null,
        lastVisit: c.lastVisit ?? null,
      })),
    });
  })
);

// ══════════════════════════════════════════════════════════════════════
// OPERATIONS — cancellations, voids
// ══════════════════════════════════════════════════════════════════════

r.get(
  "/cancellations",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { from, to } = parseRange(req.query);
    const outletId = new Types.ObjectId(req.outletId!);

    // Order-level cancellations.
    const orderCancels = await Order.aggregate([
      {
        $match: {
          outletId,
          status: "Cancelled",
          placedAt: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: null,
          orders: { $sum: 1 },
          value: { $sum: "$total" },
        },
      },
    ]);

    // Item-level cancellations sourced from the audit log so we get the
    // staff member who voided each line.
    const itemCancels = await AuditLog.find({
      outletId: req.outletId,
      action: "order.item.cancel",
      at: { $gte: from, $lte: to },
    }).sort({ at: -1 });

    const byUser: Record<string, { name: string; count: number; value: number }> = {};
    let lineCount = 0;
    let lineValue = 0;
    for (const e of itemCancels as any[]) {
      const before = e.before ?? {};
      const v = (Number(before.price ?? 0) || 0) * (Number(before.qty ?? 0) || 0);
      lineCount += 1;
      lineValue += v;
      const key = e.userName ?? "system";
      if (!byUser[key]) byUser[key] = { name: key, count: 0, value: 0 };
      byUser[key].count += 1;
      byUser[key].value += v;
    }

    res.json({
      from,
      to,
      orders: {
        count: orderCancels[0]?.orders ?? 0,
        value: Math.round(orderCancels[0]?.value ?? 0),
      },
      lines: {
        count: lineCount,
        value: Math.round(lineValue),
      },
      byUser: Object.values(byUser)
        .map((u) => ({ ...u, value: Math.round(u.value) }))
        .sort((a, b) => b.value - a.value),
      recent: itemCancels.slice(0, 25).map((e: any) => ({
        at: e.at,
        userName: e.userName,
        orderCode: e.after?.code,
        item: e.before?.name,
        qty: e.before?.qty,
        value: Math.round((e.before?.price ?? 0) * (e.before?.qty ?? 0)),
        reason: e.after?.reason ?? null,
      })),
    });
  })
);

// ══════════════════════════════════════════════════════════════════════
// COST — wastage analysis, P&L, inventory snapshot
// ══════════════════════════════════════════════════════════════════════

r.get(
  "/wastage-analysis",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { from, to } = parseRange(req.query);
    const filter: any = {
      outletId: req.outletId,
      at: { $gte: from, $lte: to },
    };
    const [byReason, byIngredient, byStaff, top] = await Promise.all([
      Wastage.aggregate([
        { $match: { ...filter, outletId: new Types.ObjectId(req.outletId!) } },
        {
          $group: {
            _id: "$reason",
            count: { $sum: 1 },
            cost: { $sum: "$cost" },
            qty: { $sum: "$qty" },
          },
        },
        { $sort: { cost: -1 } },
      ]),
      Wastage.aggregate([
        { $match: { ...filter, outletId: new Types.ObjectId(req.outletId!) } },
        {
          $group: {
            _id: { ingredientId: "$ingredientId", name: "$itemName" },
            count: { $sum: 1 },
            cost: { $sum: "$cost" },
            qty: { $sum: "$qty" },
          },
        },
        { $sort: { cost: -1 } },
        { $limit: 25 },
      ]),
      Wastage.aggregate([
        { $match: { ...filter, outletId: new Types.ObjectId(req.outletId!) } },
        {
          $group: {
            _id: { staffId: "$staffId", name: "$staffName" },
            count: { $sum: 1 },
            cost: { $sum: "$cost" },
          },
        },
        { $sort: { cost: -1 } },
      ]),
      Wastage.find(filter).sort({ at: -1 }).limit(50),
    ]);

    const totalCost = byReason.reduce((s, r) => s + (r.cost ?? 0), 0);
    res.json({
      from,
      to,
      totalCost: Math.round(totalCost),
      totalEvents: byReason.reduce((s, r) => s + (r.count ?? 0), 0),
      byReason: byReason.map((r) => ({
        reason: r._id ?? "Unspecified",
        count: r.count ?? 0,
        qty: Number((r.qty ?? 0).toFixed(2)),
        cost: Math.round(r.cost ?? 0),
        share: totalCost
          ? Number((((r.cost ?? 0) / totalCost) * 100).toFixed(1))
          : 0,
      })),
      byIngredient: byIngredient.map((r) => ({
        ingredientId: r._id.ingredientId,
        name: r._id.name ?? "Unknown",
        count: r.count ?? 0,
        qty: Number((r.qty ?? 0).toFixed(2)),
        cost: Math.round(r.cost ?? 0),
      })),
      byStaff: byStaff
        .filter((s) => s._id?.staffId)
        .map((s) => ({
          staffId: s._id.staffId,
          name: s._id.name ?? "Unknown",
          count: s.count ?? 0,
          cost: Math.round(s.cost ?? 0),
        })),
      recent: top.map((w: any) => ({
        at: w.at,
        itemName: w.itemName,
        qty: w.qty,
        unit: w.unit,
        reason: w.reason,
        cost: w.cost,
        staffName: w.staffName,
      })),
    });
  })
);

r.get(
  "/pnl",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { from, to } = parseRange(req.query);
    const outletId = new Types.ObjectId(req.outletId!);

    // Revenue + COGS in one pipeline.
    const [revAgg, items, wastage, expenses] = await Promise.all([
      Order.aggregate([
        {
          $match: {
            outletId,
            placedAt: { $gte: from, $lte: to },
            status: { $ne: "Cancelled" },
          },
        },
        {
          $group: {
            _id: null,
            revenue: { $sum: "$total" },
            tax: { $sum: "$tax" },
            service: { $sum: "$service" },
            discountAmount: { $sum: "$discountAmount" },
            orders: { $sum: 1 },
          },
        },
      ]),
      MenuItem.find({ outletId: req.outletId }),
      Wastage.find({ outletId: req.outletId, at: { $gte: from, $lte: to } }),
      Expense.find({ outletId: req.outletId, at: { $gte: from, $lte: to } }),
    ]);

    const itemMap = new Map(items.map((i: any) => [i._id.toString(), i]));
    const orders = await Order.find({
      outletId,
      placedAt: { $gte: from, $lte: to },
      status: { $ne: "Cancelled" },
    });
    let cogs = 0;
    let suppliesCost = 0;
    for (const o of orders as any[]) {
      for (const oi of o.items ?? []) {
        if (oi.status === "Cancelled") continue;
        const m: any = itemMap.get(oi.menuItemId?.toString() ?? "");
        if (m) cogs += (m.plateCost ?? 0) * oi.qty;
      }
      for (const s of o.supplies ?? []) {
        suppliesCost += (s.qty ?? 0) * (s.costPerUnit ?? 0);
      }
    }

    const wastageCost = wastage.reduce((s, w) => s + (w.cost ?? 0), 0);
    const expenseTotal = expenses.reduce((s, e) => s + (e.amount ?? 0), 0);
    const expenseByCategory: Record<string, number> = {};
    for (const e of expenses as any[]) {
      const k = e.category ?? "Other";
      expenseByCategory[k] = (expenseByCategory[k] ?? 0) + (e.amount ?? 0);
    }

    const revenue = revAgg[0]?.revenue ?? 0;
    const grossProfit = revenue - cogs;
    const operatingProfit = grossProfit - wastageCost - suppliesCost - expenseTotal;

    res.json({
      from,
      to,
      revenue: Math.round(revenue),
      tax: Math.round(revAgg[0]?.tax ?? 0),
      service: Math.round(revAgg[0]?.service ?? 0),
      discountAmount: Math.round(revAgg[0]?.discountAmount ?? 0),
      cogs: Math.round(cogs),
      grossProfit: Math.round(grossProfit),
      grossMarginPct: revenue
        ? Number(((grossProfit / revenue) * 100).toFixed(1))
        : 0,
      wastageCost: Math.round(wastageCost),
      suppliesCost: Math.round(suppliesCost),
      expenseTotal: Math.round(expenseTotal),
      expenseByCategory: Object.entries(expenseByCategory)
        .map(([category, amount]) => ({ category, amount: Math.round(amount) }))
        .sort((a, b) => b.amount - a.amount),
      operatingProfit: Math.round(operatingProfit),
      operatingMarginPct: revenue
        ? Number(((operatingProfit / revenue) * 100).toFixed(1))
        : 0,
    });
  })
);

r.get(
  "/inventory-snapshot",
  asyncHandler(async (req: AuthedRequest, res) => {
    const ings = await Ingredient.find({ outletId: req.outletId });
    let value = 0;
    let outCount = 0;
    let lowCount = 0;
    const byCategory: Record<string, { value: number; count: number }> = {};
    for (const i of ings as any[]) {
      const v = (i.stock ?? 0) * (i.costPerUnit ?? 0);
      value += v;
      if ((i.stock ?? 0) <= 0) outCount += 1;
      else if ((i.stock ?? 0) < (i.par ?? 0)) lowCount += 1;
      const cat = i.category ?? "Other";
      if (!byCategory[cat]) byCategory[cat] = { value: 0, count: 0 };
      byCategory[cat].value += v;
      byCategory[cat].count += 1;
    }
    res.json({
      total: ings.length,
      value: Math.round(value),
      out: outCount,
      low: lowCount,
      byCategory: Object.entries(byCategory)
        .map(([category, v]) => ({
          category,
          count: v.count,
          value: Math.round(v.value),
        }))
        .sort((a, b) => b.value - a.value),
    });
  })
);

// ══════════════════════════════════════════════════════════════════════
// DELIVERY — performance + rider scorecard
// ══════════════════════════════════════════════════════════════════════

r.get(
  "/delivery-performance",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { from, to } = parseRange(req.query);
    const outletId = new Types.ObjectId(req.outletId!);
    const baseMatch = {
      outletId,
      channel: "Delivery",
      placedAt: { $gte: from, $lte: to },
    };
    const [agg, failed] = await Promise.all([
      Order.aggregate([
        { $match: { ...baseMatch, deliveredAt: { $exists: true } } },
        {
          $project: {
            durationMin: {
              $divide: [
                { $subtract: ["$deliveredAt", "$placedAt"] },
                1000 * 60,
              ],
            },
            onTime: {
              $cond: [
                {
                  $lte: [
                    { $subtract: ["$deliveredAt", "$placedAt"] },
                    1000 * 60 * 30,
                  ],
                },
                1,
                0,
              ],
            },
            cashOnDelivery: 1,
            paymentStatus: 1,
            total: 1,
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            avgMin: { $avg: "$durationMin" },
            onTime: { $sum: "$onTime" },
            codCount: {
              $sum: { $cond: ["$cashOnDelivery", 1, 0] },
            },
            codCollected: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      "$cashOnDelivery",
                      { $eq: ["$paymentStatus", "Paid"] },
                    ],
                  },
                  "$total",
                  0,
                ],
              },
            },
          },
        },
      ]),
      Order.find({
        ...baseMatch,
        failureReason: { $exists: true, $ne: null },
      }).sort({ placedAt: -1 }).limit(50),
    ]);
    const a = agg[0] ?? { count: 0, avgMin: 0, onTime: 0, codCount: 0, codCollected: 0 };

    const failureReasons: Record<string, number> = {};
    for (const o of failed as any[]) {
      const k = o.failureReason ?? "Unknown";
      failureReasons[k] = (failureReasons[k] ?? 0) + 1;
    }

    res.json({
      from,
      to,
      delivered: a.count,
      avgMinutes: Number((a.avgMin ?? 0).toFixed(1)),
      onTimePct: a.count ? Number(((a.onTime / a.count) * 100).toFixed(1)) : 0,
      cod: { total: a.codCount, collected: Math.round(a.codCollected ?? 0) },
      failed: failed.length,
      failureReasons: Object.entries(failureReasons)
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
    });
  })
);

r.get(
  "/rider-scorecard",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { from, to } = parseRange(req.query);
    const outletId = new Types.ObjectId(req.outletId!);
    const rows = await Order.aggregate([
      {
        $match: {
          outletId,
          channel: "Delivery",
          riderId: { $ne: null },
          placedAt: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: "$riderId",
          assigned: { $sum: 1 },
          delivered: {
            $sum: { $cond: [{ $ifNull: ["$deliveredAt", false] }, 1, 0] },
          },
          failed: {
            $sum: { $cond: [{ $ifNull: ["$failureReason", false] }, 1, 0] },
          },
          totalMinutes: {
            $sum: {
              $cond: [
                { $ifNull: ["$deliveredAt", false] },
                {
                  $divide: [
                    { $subtract: ["$deliveredAt", "$placedAt"] },
                    1000 * 60,
                  ],
                },
                0,
              ],
            },
          },
          revenue: { $sum: "$total" },
        },
      },
      { $sort: { delivered: -1 } },
    ]);
    const userIds = rows.map((r) => r._id).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }).select("name role");
    const uMap = new Map(users.map((u: any) => [String(u._id), u]));
    res.json({
      from,
      to,
      riders: rows.map((r) => {
        const u: any = uMap.get(String(r._id));
        const avgMin = r.delivered ? r.totalMinutes / r.delivered : 0;
        return {
          riderId: String(r._id),
          name: u?.name ?? "Unknown",
          assigned: r.assigned ?? 0,
          delivered: r.delivered ?? 0,
          failed: r.failed ?? 0,
          avgMinutes: Number(avgMin.toFixed(1)),
          revenue: Math.round(r.revenue ?? 0),
        };
      }),
    });
  })
);

// ══════════════════════════════════════════════════════════════════════
// AUDIT — activity summary
// ══════════════════════════════════════════════════════════════════════

r.get(
  "/audit-summary",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { from, to } = parseRange(req.query);
    const filter = {
      outletId: req.outletId,
      at: { $gte: from, $lte: to },
    };
    const [byAction, byUser] = await Promise.all([
      AuditLog.aggregate([
        {
          $match: {
            ...filter,
            outletId: new Types.ObjectId(req.outletId!),
          },
        },
        {
          $group: {
            _id: "$action",
            count: { $sum: 1 },
            lastAt: { $max: "$at" },
          },
        },
        { $sort: { count: -1 } },
      ]),
      AuditLog.aggregate([
        {
          $match: {
            ...filter,
            outletId: new Types.ObjectId(req.outletId!),
          },
        },
        {
          $group: {
            _id: { userId: "$userId", name: "$userName" },
            count: { $sum: 1 },
            lastAt: { $max: "$at" },
          },
        },
        { $sort: { count: -1 } },
      ]),
    ]);
    res.json({
      from,
      to,
      total: byAction.reduce((s, r) => s + (r.count ?? 0), 0),
      byAction: byAction.map((a) => ({
        action: a._id,
        count: a.count,
        lastAt: a.lastAt,
      })),
      byUser: byUser
        .filter((u) => u._id?.userId || u._id?.name)
        .map((u) => ({
          userId: u._id?.userId,
          name: u._id?.name ?? "system",
          count: u.count,
          lastAt: u.lastAt,
        })),
    });
  })
);

// ══════════════════════════════════════════════════════════════════════
// ANOMALIES (existing) + EXPORT
// ══════════════════════════════════════════════════════════════════════

r.get(
  "/anomalies",
  asyncHandler(async (req: AuthedRequest, res) => {
    const items = await AnomalyEvent.find({ outletId: req.outletId })
      .sort({ at: -1 })
      .limit(Number(req.query.limit ?? 100));
    res.json({ anomalies: items });
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
        paymentMethod: o.paymentMethod ?? "",
      })),
    });
  })
);

export default r;
