import { Router } from "express";
import { Table } from "../models/Table";
import { Category } from "../models/Category";
import { MenuItem } from "../models/MenuItem";
import { Order } from "../models/Order";
import { Outlet } from "../models/Outlet";
import { Review } from "../models/Review";
import { Ingredient } from "../models/Ingredient";
import { asyncHandler } from "../utils/asyncHandler";
import { createOrder, closeTableSession } from "../services/orderService";
import { notify } from "../services/notify";
import { emit } from "../sockets";

// Public customer-facing routes — no auth
const r = Router();

r.get(
  "/menu/:tableCode",
  asyncHandler(async (req, res) => {
    const tableCode = req.params.tableCode;
    const table = await Table.findOne({ code: tableCode });
    if (!table) return res.status(404).json({ error: "Table not found" });
    const outlet = await Outlet.findById(table.outletId);
    const [cats, items] = await Promise.all([
      Category.find({ outletId: table.outletId, active: true }).sort({ sortOrder: 1 }),
      MenuItem.find({
        outletId: table.outletId,
        active: true,
        stockStatus: { $ne: "Out" },
      }).sort({ name: 1 }),
    ]);
    res.json({
      outlet: {
        name: outlet?.name,
        address: outlet?.address,
        taxRate: outlet?.taxRate,
        serviceRate: outlet?.serviceRate,
      },
      table: { code: table.code, capacity: table.capacity, zone: table.zone, status: table.status },
      categories: cats,
      items,
    });
  })
);

r.post(
  "/orders/:tableCode",
  asyncHandler(async (req, res) => {
    const tableCode = req.params.tableCode;
    const table = await Table.findOne({ code: tableCode });
    if (!table) return res.status(404).json({ error: "Table not found" });
    const order = await createOrder({
      outletId: table.outletId.toString(),
      channel: "Dine-in",
      tableCode,
      customerName: req.body.customerName,
      customerPhone: req.body.customerPhone,
      customerEmail: req.body.customerEmail,
      marketingOptIn: !!req.body.marketingOptIn,
      items: req.body.items ?? [],
      source: "customer",
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

r.get(
  "/order/:id",
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id).populate("customerId");
    if (!order) return res.status(404).json({ error: "Not found" });
    const review = await Review.findOne({ orderId: order._id });
    const c: any = order.customerId;
    const loyalty = c
      ? {
          name: c.name,
          tier: c.tier,
          points: c.points,
          visits: c.visits,
        }
      : null;
    // Don't leak the populated Customer object back to the client
    const out: any = order.toJSON();
    if (out.customerId && typeof out.customerId === "object") {
      out.customerId = out.customerId.id ?? out.customerId._id ?? null;
    }
    res.json({ order: out, reviewed: !!review, loyalty });
  })
);

// Most recent served/completed order at this table that has NOT been reviewed
// yet — lets a customer re-scan after their meal and land straight on a review
// prompt, even if localStorage was cleared or they&apos;re on a different phone.
r.get(
  "/table/:tableCode/pending-review",
  asyncHandler(async (req, res) => {
    const table = await Table.findOne({ code: req.params.tableCode });
    if (!table) return res.status(404).json({ error: "Table not found" });
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000); // 6h window
    const candidates = await Order.find({
      outletId: table.outletId,
      tableCode: table.code,
      status: { $in: ["Served", "Completed"] },
      placedAt: { $gte: since },
      sessionClosed: { $ne: true },
    })
      .sort({ servedAt: -1, placedAt: -1 })
      .limit(5);

    for (const o of candidates) {
      const rev = await Review.findOne({ orderId: o._id });
      if (!rev) return res.json({ order: o });
    }
    res.json({ order: null });
  })
);

// Active-order lookup for a table — lets the customer page restore state
// on re-scan without needing a saved id. Filters out sessions that have been
// explicitly closed by staff so a new guest doesn't see the previous order.
r.get(
  "/table/:tableCode/active-order",
  asyncHandler(async (req, res) => {
    const table = await Table.findOne({ code: req.params.tableCode });
    if (!table) return res.status(404).json({ error: "Table not found" });
    const order = await Order.findOne({
      outletId: table.outletId,
      tableCode: table.code,
      status: { $in: ["Pending", "Queued", "In Progress", "Ready", "Served"] },
      sessionClosed: { $ne: true },
    }).sort({ placedAt: -1 });
    res.json({ order });
  })
);

// Customer-initiated addendum — items start as Pending so the receptionist
// can review them before they hit KDS, mirroring the initial order flow.
r.post(
  "/orders/:id/append",
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (["Completed", "Cancelled"].includes(order.status))
      return res.status(409).json({ error: "Order is already closed" });

    const incoming: {
      menuItemId: string;
      qty: number;
      mods?: string[];
      note?: string;
    }[] = req.body.items ?? [];
    if (incoming.length === 0)
      return res.status(400).json({ error: "items[] required" });

    const outlet = await Outlet.findById(order.outletId);
    const menuItems = await MenuItem.find({
      _id: { $in: incoming.map((i) => i.menuItemId) },
    });
    const menuMap = new Map(
      menuItems.map((m: any) => [m._id.toString(), m])
    );

    const now = new Date();
    const newItems = incoming.map((i) => {
      const m: any = menuMap.get(i.menuItemId);
      if (!m)
        throw Object.assign(new Error(`Unknown menu item ${i.menuItemId}`), {
          status: 400,
        });
      return {
        menuItemId: m._id,
        name: m.name,
        qty: i.qty,
        price: m.price,
        mods: i.mods ?? [],
        note: i.note,
        status: "Pending" as const,
        addendum: true,
        addedAt: now,
      };
    });

    order.items.push(...(newItems as any));
    order.subtotal = order.items.reduce(
      (s: number, x: any) => s + x.price * x.qty,
      0
    );
    order.tax = Math.round(order.subtotal * (outlet?.taxRate ?? 0));
    order.service = Math.round(order.subtotal * (outlet?.serviceRate ?? 0));
    order.total = order.subtotal + order.tax + order.service;

    order.events.push({
      status: `Addendum requested (${newItems.length} items)`,
      at: now,
    });
    await order.save();

    // Inventory is deducted only when the receptionist forwards the addendum.
    // Here we just record the intent and notify the receptionist.
    emit("order:update", order.toJSON(), order.outletId.toString());
    await notify({
      outletId: order.outletId.toString(),
      type: "order.new",
      level: "warn",
      title: `${order.code} · ${newItems.length} item${
        newItems.length === 1 ? "" : "s"
      } added · review & forward`,
      body: `Guest at ${
        order.tableCode ?? "takeaway"
      } added to their order · total now Rs ${order.total.toLocaleString()}`,
      link: "/orders",
      targetRoles: ["admin", "manager", "receptionist"],
    });

    res.json({ order });
  })
);

r.post(
  "/order/:id/call-waiter",
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Not found" });
    await notify({
      outletId: order.outletId.toString(),
      type: "system",
      level: "warn",
      title: `${order.tableCode ?? order.code} called waiter`,
      body: req.body.reason ?? "Guest needs assistance",
      link: "/tables",
      // Front-of-house concern — kitchen is busy cooking, riders are off-site.
      targetRoles: ["admin", "manager", "receptionist", "waiter"],
    });
    res.json({ ok: true });
  })
);

r.post(
  "/reviews",
  asyncHandler(async (req, res) => {
    const { orderId, rating, text, customerName } = req.body;
    if (!rating || rating < 1 || rating > 5)
      return res.status(400).json({ error: "rating 1-5 required" });
    const order = orderId ? await Order.findById(orderId) : null;
    const outletId = order?.outletId;
    if (!outletId) return res.status(400).json({ error: "orderId required" });
    const rev = await Review.create({
      outletId,
      orderId,
      customerName: customerName ?? order?.customerName,
      rating,
      text,
      channel: "In-app",
      recovery: Number(rating) <= 3,
    });
    if (Number(rating) <= 3) {
      await notify({
        outletId: outletId.toString(),
        type: "review.negative",
        level: "warn",
        title: `${rating}★ review — needs recovery`,
        body: text ? text.slice(0, 100) : "Guest left low feedback",
        link: "/customers",
        targetRoles: ["admin", "manager", "receptionist"],
      });
    }

    // A review from a dine-in guest ends the session: the table auto-frees
    // and the in-flight order is marked closed so the next scan is fresh.
    if (order && order.tableId && ["Served", "Completed"].includes(order.status)) {
      if (order.status === "Served") {
        order.status = "Completed";
        order.closedAt = new Date();
        order.events.push({
          status: "Completed",
          at: new Date(),
          note: "Closed by customer review",
        });
        await order.save();
      }
      await closeTableSession(
        order.tableId.toString(),
        outletId.toString()
      );
    }

    res.status(201).json({ review: rev });
  })
);

export default r;
