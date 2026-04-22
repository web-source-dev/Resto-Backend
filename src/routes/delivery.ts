import { Router } from "express";
import { Order } from "../models/Order";
import { User } from "../models/User";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, requireRole } from "../middleware/auth";
import {
  assignRider,
  claimDelivery,
  unassignRider,
  deliveryPickup,
  deliveryDelivered,
  deliveryFailed,
} from "../services/orderService";
import { emit } from "../sockets";

const r = Router();
r.use(authMiddleware);

const canDispatch = requireRole("admin", "manager", "receptionist");
const canRide = requireRole("admin", "manager", "rider");

// All live delivery orders with rider info — dispatcher view
r.get(
  "/queue",
  canDispatch,
  asyncHandler(async (req: AuthedRequest, res) => {
    const orders = await Order.find({
      outletId: req.outletId,
      channel: "Delivery",
      status: { $in: ["Pending", "Queued", "In Progress", "Ready", "Served"] },
      sessionClosed: { $ne: true },
    })
      .sort({ placedAt: 1 })
      .limit(100);
    res.json({ orders });
  })
);

// Rider performance — on-time %, avg delivery time, fail rate, 7-day trend
r.get(
  "/riders/:id/performance",
  canDispatch,
  asyncHandler(async (req: AuthedRequest, res) => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const orders = await Order.find({
      outletId: req.outletId,
      riderId: req.params.id,
      channel: "Delivery",
      placedAt: { $gte: since },
    }).sort({ placedAt: 1 });

    const delivered = orders.filter((o: any) => o.deliveredAt);
    const failed = orders.filter((o: any) => o.failureReason);
    const onTime = delivered.filter((o: any) => {
      if (!o.assignedAt || !o.deliveredAt) return true;
      const minutes =
        (o.deliveredAt.getTime() - o.assignedAt.getTime()) / 60000;
      return minutes <= 30;
    });
    const avgMinutes = delivered.length
      ? Math.round(
          delivered.reduce((s: number, o: any) => {
            const m =
              (o.deliveredAt.getTime() -
                (o.assignedAt ?? o.placedAt).getTime()) /
              60000;
            return s + m;
          }, 0) / delivered.length
        )
      : 0;

    // Trend: per-day deliveries for last 7 days
    const trend = Array.from({ length: 7 }).map((_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (6 - i));
      d.setHours(0, 0, 0, 0);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      const count = delivered.filter(
        (o: any) => o.deliveredAt >= d && o.deliveredAt < next
      ).length;
      return {
        d: d.toLocaleDateString("en-US", { weekday: "short" }),
        count,
      };
    });

    res.json({
      total: orders.length,
      delivered: delivered.length,
      failed: failed.length,
      onTimePct: delivered.length
        ? Math.round((onTime.length / delivered.length) * 100)
        : 0,
      avgMinutes,
      failRate: orders.length
        ? Math.round((failed.length / orders.length) * 100)
        : 0,
      trend,
    });
  })
);

// Riders currently on shift + their availability (busy with active delivery?)
r.get(
  "/riders",
  canDispatch,
  asyncHandler(async (req: AuthedRequest, res) => {
    const riders = await User.find({
      outletId: req.outletId,
      role: "rider",
      active: true,
    });
    const activeDeliveries = await Order.find({
      outletId: req.outletId,
      channel: "Delivery",
      status: { $in: ["Ready", "Served"] },
      riderId: { $exists: true, $ne: null },
    }).select("riderId code status deliveryAddress");
    const byRider = new Map<string, any>();
    for (const d of activeDeliveries) {
      byRider.set(String(d.riderId), d);
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const completed = await Order.aggregate([
      {
        $match: {
          outletId: (req.user as any).outletId,
          channel: "Delivery",
          status: "Completed",
          deliveredAt: { $gte: todayStart },
          riderId: { $exists: true, $ne: null },
        },
      },
      { $group: { _id: "$riderId", count: { $sum: 1 } } },
    ]);
    const completedByRider = new Map<string, number>();
    for (const c of completed) completedByRider.set(String(c._id), c.count);

    const out = riders.map((u: any) => {
      const o = u.toPublic();
      const busy = byRider.get(String(u._id));
      let status: string;
      if (!u.clockedInAt) status = "Off shift";
      else if (busy) status = busy.status === "Ready" ? "Picking up" : "En route";
      else if (u.onBreak) status = "On break";
      else status = "Available";
      return {
        ...o,
        deliveryStatus: status,
        activeDelivery: busy ?? null,
        deliveredToday: completedByRider.get(String(u._id)) ?? 0,
      };
    });
    res.json({ riders: out });
  })
);

// My assignment (rider) — the single active delivery, plus today's completed
r.get(
  "/my-assignment",
  canRide,
  asyncHandler(async (req: AuthedRequest, res) => {
    const me = req.user as any;
    const [active, today] = await Promise.all([
      Order.findOne({
        outletId: req.outletId,
        channel: "Delivery",
        riderId: me._id,
        status: { $in: ["Ready", "Served"] },
      }).sort({ assignedAt: -1 }),
      Order.find({
        outletId: req.outletId,
        channel: "Delivery",
        riderId: me._id,
        status: "Completed",
        deliveredAt: {
          $gte: (() => {
            const d = new Date();
            d.setHours(0, 0, 0, 0);
            return d;
          })(),
        },
      })
        .sort({ deliveredAt: -1 })
        .limit(20),
    ]);

    // Unassigned Ready deliveries the rider could self-claim
    const unassigned = await Order.find({
      outletId: req.outletId,
      channel: "Delivery",
      status: "Ready",
      riderId: { $in: [null, undefined] },
      sessionClosed: { $ne: true },
    })
      .sort({ readyAt: 1 })
      .limit(10);

    res.json({
      active,
      completedToday: today,
      unassigned,
      rider: {
        id: me._id,
        name: me.name,
        clockedInAt: me.clockedInAt,
        onBreak: !!me.onBreak,
      },
    });
  })
);

// Rider toggles their break state
r.post(
  "/break",
  canRide,
  asyncHandler(async (req: AuthedRequest, res) => {
    const me = req.user as any;
    const on = !!req.body.on;
    await User.updateOne({ _id: me._id }, { onBreak: on });
    const fresh = await User.findById(me._id);
    res.json({ user: (fresh as any).toPublic(), onBreak: on });
  })
);

// Dispatcher assigns
r.post(
  "/assign",
  canDispatch,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { orderId, riderId } = req.body;
    if (!orderId || !riderId)
      return res.status(400).json({ error: "orderId + riderId required" });
    const order = await assignRider(orderId, riderId, req.user?._id);
    res.json({ order });
  })
);

// Dispatcher unassigns (before pickup)
r.post(
  "/unassign",
  canDispatch,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { orderId } = req.body;
    const order = await unassignRider(orderId, req.user?._id);
    res.json({ order });
  })
);

// Rider self-claims an unassigned Ready delivery
r.post(
  "/claim",
  canRide,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { orderId } = req.body;
    const order = await claimDelivery(orderId, (req.user as any)._id.toString());
    res.json({ order });
  })
);

// Rider picks up the food at the counter
r.post(
  "/orders/:id/pickup",
  canRide,
  asyncHandler(async (req: AuthedRequest, res) => {
    const order = await deliveryPickup(req.params.id, req.user?._id);
    res.json({ order });
  })
);

// Rider drops off at the customer
r.post(
  "/orders/:id/delivered",
  canRide,
  asyncHandler(async (req: AuthedRequest, res) => {
    const order = await deliveryDelivered(req.params.id, req.user?._id, {
      paymentCollected: !!req.body.paymentCollected,
    });
    res.json({ order });
  })
);

// Delivery failed — capture a reason so management can follow up
r.post(
  "/orders/:id/fail",
  canRide,
  asyncHandler(async (req: AuthedRequest, res) => {
    const reason = String(req.body.reason ?? "").trim();
    if (!reason)
      return res.status(400).json({ error: "reason required" });
    const order = await deliveryFailed(req.params.id, reason, req.user?._id);
    res.json({ order });
  })
);

export default r;
