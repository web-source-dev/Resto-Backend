import { Router } from "express";
import { Order } from "../models/Order";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, requireRole } from "../middleware/auth";
import {
  createOrder,
  payOrder,
  transitionOrder,
  forwardOrder,
  forwardAddendum,
  adjustEta,
} from "../services/orderService";

const r = Router();
r.use(authMiddleware);
const canForward = requireRole("admin", "manager", "receptionist");
const canAdjustEta = requireRole("admin", "manager", "kitchen");

r.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const q: any = { outletId: req.outletId };
    if (req.query.status) q.status = req.query.status;
    if (req.query.channel) q.channel = req.query.channel;
    if (req.query.active === "true")
      q.status = { $in: ["Queued", "In Progress", "Ready"] };
    if (req.query.pending === "true") {
      // Both: brand-new orders awaiting review, and existing orders with
      // newly-added addendum items waiting to be forwarded.
      q.$or = [
        { status: "Pending" },
        { "items.status": "Pending", status: { $ne: "Cancelled" } },
      ];
    }
    const orders = await Order.find(q)
      .sort({ placedAt: -1 })
      .limit(Number(req.query.limit ?? 200));
    res.json({ orders });
  })
);

r.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const order = await Order.findOne({ _id: req.params.id, outletId: req.outletId });
    if (!order) return res.status(404).json({ error: "Not found" });
    res.json({ order });
  })
);

r.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const order = await createOrder({
      outletId: req.outletId!,
      channel: req.body.channel ?? "Dine-in",
      tableCode: req.body.tableCode,
      customerName: req.body.customerName,
      customerPhone: req.body.customerPhone,
      customerEmail: req.body.customerEmail,
      marketingOptIn: !!req.body.marketingOptIn,
      items: req.body.items ?? [],
      priority: req.body.priority,
      waiterId: req.user?._id,
      deliveryAddress: req.body.deliveryAddress,
      deliveryNote: req.body.deliveryNote,
      cashOnDelivery: req.body.cashOnDelivery,
      couponCode: req.body.couponCode,
      redeemPoints: req.body.redeemPoints
        ? Number(req.body.redeemPoints)
        : undefined,
    });
    res
      .status(201)
      .json({ order, loyalty: (order as any).loyalty ?? null });
  })
);

r.post(
  "/:id/forward",
  canForward,
  asyncHandler(async (req: AuthedRequest, res) => {
    const order = await forwardOrder(req.params.id, req.user?._id);
    res.json({ order });
  })
);

r.post(
  "/:id/forward-addendum",
  canForward,
  asyncHandler(async (req: AuthedRequest, res) => {
    const order = await forwardAddendum(req.params.id, req.user?._id);
    res.json({ order });
  })
);

r.post(
  "/:id/eta",
  canAdjustEta,
  asyncHandler(async (req: AuthedRequest, res) => {
    const order = await adjustEta(
      req.params.id,
      {
        addMinutes: req.body.addMinutes
          ? Number(req.body.addMinutes)
          : undefined,
        absoluteMinutes: req.body.absoluteMinutes
          ? Number(req.body.absoluteMinutes)
          : undefined,
      },
      req.user?._id
    );
    res.json({ order });
  })
);

r.post(
  "/:id/transition",
  asyncHandler(async (req: AuthedRequest, res) => {
    const order = await transitionOrder(
      req.params.id,
      req.body.to,
      req.user?._id,
      { etaMinutes: Number(req.body.etaMinutes) || undefined }
    );
    res.json({ order });
  })
);

r.post(
  "/:id/pay",
  asyncHandler(async (req: AuthedRequest, res) => {
    const order = await payOrder(req.params.id, req.body.method ?? "Cash");
    res.json({ order });
  })
);

export default r;
