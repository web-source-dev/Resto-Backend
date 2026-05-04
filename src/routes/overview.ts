import { Router } from "express";
import { Order } from "../models/Order";
import { Table } from "../models/Table";
import { User } from "../models/User";
import { Review } from "../models/Review";
import { Ingredient } from "../models/Ingredient";
import { MenuItem } from "../models/MenuItem";
import { Wastage } from "../models/Wastage";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, excludeRoles } from "../middleware/auth";

const r = Router();
r.use(authMiddleware);
// Block riders from this resource — not relevant to delivery work and may
// contain PII or operational data they shouldn't see.
r.use(excludeRoles("rider"));

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

r.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const outletId = req.outletId;
    const today = startOfDay();
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      todayOrders,
      weekOrders,
      activeOrders,
      tables,
      staff,
      reviews,
      lowStock,
      outOfStock,
      wastageToday,
      topItems,
    ] = await Promise.all([
      Order.find({ outletId, placedAt: { $gte: today } }),
      Order.find({ outletId, placedAt: { $gte: weekAgo } }),
      Order.find({
        outletId,
        status: { $in: ["Pending", "Queued", "In Progress", "Ready"] },
      })
        .sort({ placedAt: -1 })
        .limit(10),
      Table.find({ outletId }),
      User.find({ outletId, active: true }),
      Review.find({ outletId }),
      Ingredient.find({ outletId, $expr: { $and: [{ $gt: ["$par", 0] }, { $lt: ["$stock", "$par"] }, { $gt: ["$stock", 0] }] } }),
      Ingredient.find({ outletId, stock: { $lte: 0 } }),
      Wastage.find({ outletId, at: { $gte: today } }),
      MenuItem.find({ outletId }).sort({ sold7d: -1 }).limit(6),
    ]);

    const revenueToday = todayOrders.reduce((s, o) => s + (o.total ?? 0), 0);
    const revenueWeek = weekOrders.reduce((s, o) => s + (o.total ?? 0), 0);
    const aov = todayOrders.length ? revenueToday / todayOrders.length : 0;

    // hourly buckets
    const hourly = Array.from({ length: 24 }).map((_, h) => ({ t: `${h}`, rev: 0, ord: 0 }));
    for (const o of todayOrders) {
      const h = o.placedAt ? new Date(o.placedAt).getHours() : 0;
      hourly[h].rev += o.total ?? 0;
      hourly[h].ord += 1;
    }
    const visibleHours = hourly.slice(9, 23);

    // channel mix
    const channels: Record<string, number> = {
      "Dine-in": 0,
      Takeaway: 0,
      Delivery: 0,
      Phone: 0,
    };
    for (const o of todayOrders) channels[o.channel ?? "Dine-in"] = (channels[o.channel ?? "Dine-in"] ?? 0) + 1;
    const totalOrders = todayOrders.length || 1;
    const channelPct = Object.fromEntries(
      Object.entries(channels).map(([k, v]) => [k, Math.round((v / totalOrders) * 100)])
    );

    // weekly bars by day & channel
    const weekBars: Record<string, { dinein: number; delivery: number; takeaway: number }> = {};
    for (const o of weekOrders) {
      const day = new Date(o.placedAt).toLocaleDateString("en-US", { weekday: "short" });
      weekBars[day] ??= { dinein: 0, delivery: 0, takeaway: 0 };
      const t = o.total ?? 0;
      if (o.channel === "Delivery") weekBars[day].delivery += t;
      else if (o.channel === "Takeaway") weekBars[day].takeaway += t;
      else weekBars[day].dinein += t;
    }
    const weekOrder = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const weekChannels = weekOrder.map((d) => ({
      d,
      ...(weekBars[d] ?? { dinein: 0, delivery: 0, takeaway: 0 }),
    }));

    // order-to-serve
    const served = todayOrders.filter((o) => o.servedAt && o.placedAt);
    const ots = served.length
      ? Math.round(
          served.reduce(
            (s, o) => s + (new Date(o.servedAt!).getTime() - new Date(o.placedAt!).getTime()),
            0
          ) /
            served.length /
            1000
        )
      : 0;
    const otsMin = Math.floor(ots / 60);
    const otsSec = ots % 60;

    // food cost %
    let plateCostSum = 0;
    const menuMap = new Map<string, any>();
    const items = await MenuItem.find({ outletId });
    for (const i of items) menuMap.set(i._id.toString(), i);
    for (const o of todayOrders) {
      for (const oi of o.items) {
        const m = menuMap.get(oi.menuItemId?.toString() ?? "");
        if (m) plateCostSum += (m.plateCost ?? 0) * oi.qty;
      }
    }
    const foodCostPct = revenueToday ? (plateCostSum / revenueToday) * 100 : 0;

    const occupied = tables.filter((t) => t.status === "Occupied").length;
    const free = tables.filter((t) => t.status === "Free").length;
    const cleaning = tables.filter((t) => t.status === "Cleaning").length;
    const avgRating = reviews.length
      ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length
      : 0;

    res.json({
      kpis: {
        revenueToday: Math.round(revenueToday),
        orders: todayOrders.length,
        aov: Math.round(aov),
        // `ots` is the human-readable label kept for back-compat; numeric
        // shadow fields let the frontend sort, format, or threshold without
        // string-parsing.
        ots: `${otsMin}m ${otsSec}s`,
        otsSeconds: ots,
        foodCostPct: Number(foodCostPct.toFixed(1)),
        activeTables: `${occupied} / ${tables.length}`,
        activeTablesCount: occupied,
        totalTables: tables.length,
        freeTables: free,
        cleaningTables: cleaning,
        activeStaff: staff.length,
        avgRating: Number(avgRating.toFixed(1)),
        reviewsCount: reviews.length,
        lowStockCount: lowStock.length + outOfStock.length,
        wastageToday: wastageToday.reduce((s, w) => s + (w.cost ?? 0), 0),
      },
      hourly: visibleHours,
      channelPct,
      weekChannels,
      activeOrders,
      topItems: topItems.map((i: any) => ({
        name: i.name,
        sold: i.sold7d,
        revenue: i.sold7d * i.price,
        margin: i.margin,
      })),
      alerts: [
        ...outOfStock.slice(0, 2).map((i) => ({
          level: "high",
          title: `${i.name} out of stock`,
          meta: `0 ${i.unit} left`,
        })),
        ...lowStock.slice(0, 2).map((i) => ({
          level: "med",
          title: `${i.name} low stock`,
          meta: `${i.stock} ${i.unit} left · par ${i.par}`,
        })),
      ],
    });
  })
);

export default r;
