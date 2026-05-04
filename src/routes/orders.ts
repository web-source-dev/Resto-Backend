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
  adjustItemEta,
  appendItemsByStaff,
  cancelOrderItem,
  recordSupplyUsage,
} from "../services/orderService";
import { paginated } from "../utils/paginate";

const r = Router();
r.use(authMiddleware);
const canForward = requireRole("admin", "manager", "receptionist");
const canAdjustEta = requireRole("admin", "manager", "kitchen");
// Staff who can take a verbal request from a guest at the table.
const canAppend = requireRole("admin", "manager", "receptionist", "waiter");
// Cancelling a line removes it from the bill — keep this off-limits to waiters
// and kitchen to discourage shrinkage. Receptionists handle voids at the till.
const canCancelItem = requireRole("admin", "manager", "receptionist");
// Order creation: rider and kitchen don't take orders. Front-of-house roles
// can place phone/takeaway/dine-in orders; admin/manager can also.
const canCreateOrder = requireRole("admin", "manager", "receptionist", "waiter");
// Status transitions are driven by kitchen/floor/management workflows. Rider
// transitions delivery state via /api/delivery/* — never through this route.
const canTransition = requireRole(
  "admin",
  "manager",
  "receptionist",
  "waiter",
  "kitchen"
);
// Payment is taken at the till by reception or by the floor staff handing off.
const canPay = requireRole("admin", "manager", "receptionist", "waiter");

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
    // Waiters only run the floor — takeaway/delivery/phone aren't theirs to see.
    // Force Dine-in regardless of any channel param the client passed.
    if (req.user?.role === "waiter") {
      q.channel = "Dine-in";
    }
    // Riders only see deliveries that are theirs OR claimable. They never see
    // dine-in / takeaway / phone — those contain customer PII they shouldn't.
    if (req.user?.role === "rider") {
      q.channel = "Delivery";
      q.$or = [
        { riderId: req.user._id },
        { riderId: { $in: [null, undefined] }, status: { $in: ["Ready", "Served"] } },
      ];
    }
    // Default limit dropped from 200 → 50 to keep mobile payloads tight; the
    // response now carries `total` and `hasMore` so callers know when to
    // page. Frontend pages that genuinely want a wider window pass an
    // explicit `?limit=`.
    const result = await paginated(Order, q, {
      sort: { placedAt: -1 },
      limit: Number(req.query.limit ?? 50),
      skip: Number(req.query.skip ?? 0),
      legacyKey: "orders",
    });
    res.json(result);
  })
);

r.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const filter: any = { _id: req.params.id, outletId: req.outletId };
    if (req.user?.role === "waiter") filter.channel = "Dine-in";
    if (req.user?.role === "rider") {
      filter.channel = "Delivery";
      filter.$or = [
        { riderId: req.user._id },
        { riderId: { $in: [null, undefined] }, status: { $in: ["Ready", "Served"] } },
      ];
    }
    const order = await Order.findOne(filter);
    if (!order) return res.status(404).json({ error: "Not found" });
    res.json({ order });
  })
);

r.post(
  "/",
  canCreateOrder,
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
    const order = await forwardAddendum(
      req.params.id,
      req.user?._id,
      req.user?.name
    );
    res.json({ order });
  })
);

// Staff types in items the guest asked for verbally. Goes straight to Queued
// (no review queue) since staff is the source of truth here.
r.post(
  "/:id/append",
  canAppend,
  asyncHandler(async (req: AuthedRequest, res) => {
    // Tolerant of either body key — `items` is canonical for line-item
    // appends, but accept `supplies` too so a caller mixing up endpoints
    // doesn't silently send an empty array.
    const items = req.body?.items ?? req.body?.supplies ?? [];
    const order = await appendItemsByStaff({
      orderId: req.params.id,
      items,
      by: req.user?._id,
      byName: req.user?.name,
    });
    res.status(201).json({ order });
  })
);

// Log non-recipe supply usage on an order (boxes, napkins, sachets, etc.)
// Same role gate as append — the staff at the table is the source of truth.
r.post(
  "/:id/supplies",
  canAppend,
  asyncHandler(async (req: AuthedRequest, res) => {
    // Accept either `supplies` or `items` so the body-key contract matches
    // /append. Each line still requires {ingredientId, qty} regardless.
    const supplies = req.body?.supplies ?? req.body?.items ?? [];
    const order = await recordSupplyUsage({
      orderId: req.params.id,
      supplies,
      by: req.user?._id,
      byName: req.user?.name,
    });
    res.json({ order });
  })
);

// Cancel a single line item. Restores BOM if it had been deducted.
r.post(
  "/:id/items/:itemId/cancel",
  canCancelItem,
  asyncHandler(async (req: AuthedRequest, res) => {
    const order = await cancelOrderItem({
      orderId: req.params.id,
      itemId: req.params.itemId,
      by: req.user?._id,
      byName: req.user?.name,
      reason: req.body?.reason,
    });
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
  "/:id/items/:itemId/eta",
  canAdjustEta,
  asyncHandler(async (req: AuthedRequest, res) => {
    const order = await adjustItemEta(
      req.params.id,
      req.params.itemId,
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
  canTransition,
  asyncHandler(async (req: AuthedRequest, res) => {
    const order = await transitionOrder(
      req.params.id,
      req.body.to,
      req.user?._id,
      {
        etaMinutes: Number(req.body.etaMinutes) || undefined,
        byName: req.user?.name,
      }
    );
    res.json({ order });
  })
);

r.post(
  "/:id/pay",
  canPay,
  asyncHandler(async (req: AuthedRequest, res) => {
    const order = await payOrder(
      req.params.id,
      req.body.method ?? "Cash",
      req.user?._id,
      req.user?.name
    );
    res.json({ order });
  })
);

export default r;
