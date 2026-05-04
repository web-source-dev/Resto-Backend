import { Types } from "mongoose";
import { Order } from "../models/Order";
import { MenuItem } from "../models/MenuItem";
import { Ingredient } from "../models/Ingredient";
import { Table } from "../models/Table";
import { Outlet } from "../models/Outlet";
import { emit } from "../sockets";
import { notify } from "./notify";
import { Ingredient as IngModel } from "../models/Ingredient";
import { Notification } from "../models/Notification";
import { User } from "../models/User";
import { Customer } from "../models/Customer";
import { priceOrder, commitPromotionUsage } from "./pricingEngine";
import { dispatchWebhook } from "./webhookDispatcher";

// Loyalty config — keeping it simple for now, could be per-outlet settings later.
const POINTS_PER_RUPEE = 0.1; // 10% back as points · 1 point = Rs 1 redeemable
const TIER_THRESHOLDS = {
  Silver: 10000,
  Gold: 50000,
};

/** Resolve outlet document; if User/Table references an ID with no row (e.g. after partial DB reset), create a minimal Outlet so orders still work. */
async function ensureOutlet(outletId: string) {
  const id = String(outletId ?? "").trim();
  if (!id || !Types.ObjectId.isValid(id)) {
    throw Object.assign(new Error("Invalid outlet"), { status: 400 });
  }
  let outlet = await Outlet.findById(id);
  if (outlet) return outlet;
  try {
    outlet = await Outlet.create({
      _id: new Types.ObjectId(id),
      name: "Restaurant",
    });
    return outlet;
  } catch (e: any) {
    if (e?.code === 11000) {
      outlet = await Outlet.findById(id);
      if (outlet) return outlet;
    }
    throw e;
  }
}

function applyItemEta(
  order: any,
  targetEta: Date,
  onlyPendingOrQueued = false
) {
  for (const item of order.items as any[]) {
    if (item.status === "Ready") continue;
    if (onlyPendingOrQueued && !["Pending", "Queued"].includes(item.status)) continue;
    item.eta = targetEta;
    if (item.status !== "Ready") item.status = "In Progress";
  }
}

function tierForLTV(ltv: number): "Bronze" | "Silver" | "Gold" {
  if (ltv >= TIER_THRESHOLDS.Gold) return "Gold";
  if (ltv >= TIER_THRESHOLDS.Silver) return "Silver";
  return "Bronze";
}

async function upsertCustomerForOrder(args: {
  outletId: any;
  name?: string;
  phone?: string;
  email?: string;
  total: number;
  favoriteItemName?: string;
  marketingOptIn?: boolean;
  forceCreate?: boolean;
}): Promise<{ customer: any; pointsEarned: number; isNew: boolean; prevTier: string } | null> {
  const normalizedName = (args.name ?? "").trim();
  const hasMeaningfulName =
    !!normalizedName &&
    normalizedName.toLowerCase() !== "walk-in guest" &&
    normalizedName.toLowerCase() !== "guest";
  if (!args.phone && !args.email && !hasMeaningfulName && !args.forceCreate) return null;
  const filter: any = { outletId: args.outletId };
  if (args.phone) filter.phone = args.phone;
  else if (args.email) filter.email = args.email.toLowerCase();
  else if (hasMeaningfulName) filter.name = new RegExp(`^${normalizedName}$`, "i");

  let customer = await Customer.findOne(filter);
  const pointsEarned = Math.max(0, Math.round(args.total * POINTS_PER_RUPEE));
  const isNew = !customer;
  const prevTier = customer?.tier ?? "Bronze";

  if (!customer) {
    customer = await Customer.create({
      outletId: args.outletId,
      name: normalizedName || "Walk-in guest",
      phone: args.phone,
      email: args.email?.toLowerCase(),
      tier: "Bronze",
      visits: 1,
      ltv: args.total,
      points: pointsEarned,
      favorite: args.favoriteItemName,
      lastVisitAt: new Date(),
      marketingOptIn: !!args.marketingOptIn,
    });
  } else {
    customer.visits = (customer.visits ?? 0) + 1;
    customer.ltv = (customer.ltv ?? 0) + args.total;
    customer.points = (customer.points ?? 0) + pointsEarned;
    customer.lastVisitAt = new Date();
    customer.tier = tierForLTV(customer.ltv) as any;
    // Enrich fields only when previously blank — never overwrite on the fly
    if (args.name && (!customer.name || customer.name === "Guest"))
      customer.name = args.name;
    if (args.email && !customer.email) customer.email = args.email.toLowerCase();
    if (args.phone && !customer.phone) customer.phone = args.phone;
    if (args.favoriteItemName && !customer.favorite)
      customer.favorite = args.favoriteItemName;
    if (args.marketingOptIn) customer.marketingOptIn = true;
    await customer.save();
  }

  return { customer, pointsEarned, isNew, prevTier };
}


let counter = 2100;
async function nextCode() {
  const last = await Order.findOne().sort({ createdAt: -1 }).select("code");
  if (last?.code) {
    const n = parseInt(last.code.replace(/[^0-9]/g, ""), 10);
    if (!isNaN(n)) counter = Math.max(counter, n);
  }
  counter += 1;
  return `#A-${counter}`;
}

export async function createOrder(input: {
  outletId: string;
  channel: "Dine-in" | "Takeaway" | "Delivery" | "Phone";
  tableCode?: string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  marketingOptIn?: boolean;
  items: { menuItemId: string; qty: number; mods?: string[]; note?: string }[];
  waiterId?: string;
  priority?: "Normal" | "Rush" | "VIP";
  source?: "customer" | "staff";
  deliveryAddress?: string;
  deliveryNote?: string;
  cashOnDelivery?: boolean;
  couponCode?: string;
  redeemPoints?: number;
}) {
  const source = input.source ?? "staff";
  const initialStatus: "Pending" | "Queued" =
    source === "customer" ? "Pending" : "Queued";
  const outlet = await ensureOutlet(input.outletId);
  const menuIds = input.items.map((i) => i.menuItemId);
  const menuItems = await MenuItem.find({ _id: { $in: menuIds } });
  const menuMap = new Map(menuItems.map((m) => [m._id.toString(), m]));

  const items = input.items.map((i) => {
    const m = menuMap.get(i.menuItemId);
    if (!m) throw Object.assign(new Error("Menu item not found"), { status: 400 });
    return {
      menuItemId: m._id,
      name: m.name,
      qty: i.qty,
      price: m.price,
      mods: i.mods ?? [],
      note: i.note,
      status: "Queued" as const,
    };
  });

  // Look up customer id now (for promo segment + points redemption); the full
  // upsert happens after the order saves.
  let customerIdForPricing: string | undefined;
  if (input.customerPhone || input.customerEmail) {
    const filter: any = { outletId: outlet._id };
    if (input.customerPhone) filter.phone = input.customerPhone;
    else if (input.customerEmail) filter.email = input.customerEmail.toLowerCase();
    const existing = await Customer.findOne(filter);
    if (existing) customerIdForPricing = existing._id.toString();
  }

  const pricing = await priceOrder({
    outletId: outlet._id.toString(),
    channel: input.channel,
    items: items.map((i) => ({
      menuItemId: i.menuItemId.toString(),
      name: i.name,
      qty: i.qty,
      price: i.price,
      categoryId: (menuMap.get(i.menuItemId.toString()) as any)?.categoryId?.toString(),
      isCombo: (menuMap.get(i.menuItemId.toString()) as any)?.isCombo,
    })),
    customerId: customerIdForPricing,
    couponCode: input.couponCode,
    redeemPoints: input.redeemPoints,
    taxRate: outlet.taxRate ?? 0,
    serviceRate: outlet.serviceRate ?? 0,
  });

  if (input.couponCode && pricing.couponValidation && !pricing.couponValidation.ok) {
    throw Object.assign(new Error(pricing.couponValidation.reason || "Invalid coupon"), {
      status: 400,
    });
  }

  const subtotal = pricing.subtotal;
  const tax = pricing.tax;
  const service = pricing.service;
  const total = pricing.total;

  let tableId: any = undefined;
  if (input.tableCode) {
    const table = await Table.findOne({ outletId: outlet._id, code: input.tableCode });
    if (table) tableId = table._id;
  }

  if (input.channel === "Delivery" && !input.deliveryAddress) {
    throw Object.assign(
      new Error("Delivery orders require a deliveryAddress"),
      { status: 400 }
    );
  }

  const code = await nextCode();
  const order = await Order.create({
    outletId: outlet._id,
    code,
    channel: input.channel,
    tableCode: input.tableCode,
    tableId,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    customerEmail: input.customerEmail?.toLowerCase(),
    marketingOptIn: !!input.marketingOptIn,
    items,
    subtotal,
    tax,
    service,
    discountAmount: pricing.discountAmount,
    discountLines: pricing.discountLines,
    couponCode: input.couponCode?.toUpperCase(),
    pointsRedeemed: pricing.pointsRedeemed,
    total,
    status: initialStatus,
    source,
    priority: input.priority ?? "Normal",
    waiterId: input.waiterId,
    deliveryAddress: input.deliveryAddress,
    deliveryNote: input.deliveryNote,
    cashOnDelivery: !!input.cashOnDelivery,
    events: [{ status: initialStatus, at: new Date() }],
  });

  // deduct inventory per recipe (auto-deduction per PRD §7.7)
  for (const i of items) {
    const m = menuMap.get(i.menuItemId.toString());
    if (!m?.recipe?.length) continue;
    for (const r of m.recipe) {
      await Ingredient.updateOne(
        { _id: r.ingredientId },
        { $inc: { stock: -(r.qty * i.qty) } }
      );
    }
  }

  // Commit promotion usage (atomic counter bump)
  await commitPromotionUsage(pricing.triggeredPromotionIds);

  // Debit loyalty points used for redemption
  if (pricing.pointsRedeemed > 0 && customerIdForPricing) {
    await Customer.updateOne(
      { _id: customerIdForPricing },
      { $inc: { points: -pricing.pointsRedeemed } }
    );
  }

  // Auto-upsert Customer record (CRM enrichment) when we have a contact detail.
  // Top item on the order becomes their "favorite" if they don't have one yet.
  const topItem = [...items].sort((a, b) => b.qty - a.qty)[0];
  const loyalty = await upsertCustomerForOrder({
    outletId: outlet._id,
    name: input.customerName,
    phone: input.customerPhone,
    email: input.customerEmail,
    total,
    favoriteItemName: topItem?.name,
    marketingOptIn: input.marketingOptIn,
    forceCreate: source === "customer" || !!(input.customerName && input.customerName.trim()),
  });
  if (loyalty) {
    order.customerId = loyalty.customer._id as any;
    await order.save();
  }

  // seat table if dine-in
  if (tableId) {
    await Table.updateOne(
      { _id: tableId },
      {
        status: "Occupied",
        currentOrderId: order._id,
        seatedAt: new Date(),
      }
    );
    emit("table:update", { id: tableId.toString() }, outlet._id.toString());
  }

  emit("order:new", order.toJSON(), outlet._id.toString());
  emit("inventory:update", {}, outlet._id.toString());
  const pendingNote = initialStatus === "Pending"
    ? " · awaiting receptionist review"
    : "";
  await notify({
    outletId: outlet._id.toString(),
    type: "order.new",
    level: initialStatus === "Pending" ? "warn" : "info",
    title:
      initialStatus === "Pending"
        ? `New QR order ${code} · review & forward`
        : `New order ${code}`,
    body: `${items.length} items · Rs ${total.toLocaleString()} · ${input.channel}${
      input.tableCode ? ` · ${input.tableCode}` : ""
    }${pendingNote}`,
    link: `/orders`,
    // Customer-placed orders land on the receptionist's desk first.
    // Staff-entered orders go straight to the kitchen.
    targetRoles:
      initialStatus === "Pending"
        ? ["admin", "manager", "receptionist"]
        : ["admin", "manager", "kitchen"],
  });

  // check for newly-low ingredients after auto-deduction
  const touchedIds = new Set<string>();
  for (const i of items) {
    const m = menuMap.get(i.menuItemId.toString());
    for (const r of m?.recipe ?? []) touchedIds.add(r.ingredientId.toString());
  }
  for (const id of touchedIds) {
    const ing = await IngModel.findById(id);
    if (ing && ing.par > 0 && ing.stock > 0 && ing.stock < ing.par) {
      const recent = await Notification.findOne({
        outletId: outlet._id,
        type: "inventory.low",
        title: `${ing.name} low stock`,
        createdAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) },
      });
      if (!recent) {
        await notify({
          outletId: outlet._id.toString(),
          type: "inventory.low",
          level: "warn",
          title: `${ing.name} low stock`,
          body: `${ing.stock} ${ing.unit} left · par ${ing.par}`,
          link: "/inventory",
          targetRoles: ["admin", "manager", "kitchen"],
        });
      }
    } else if (ing && ing.stock <= 0) {
      await notify({
        outletId: outlet._id.toString(),
        type: "inventory.out",
        level: "error",
        title: `${ing.name} out of stock`,
        body: `86-list: hide dependent items`,
        link: "/inventory",
        targetRoles: ["admin", "manager", "kitchen"],
      });
    }
  }
  (order as any).loyalty = loyalty
    ? {
        name: loyalty.customer.name,
        tier: loyalty.customer.tier,
        prevTier: loyalty.prevTier,
        points: loyalty.customer.points,
        pointsEarned: loyalty.pointsEarned,
        visits: loyalty.customer.visits,
        isNew: loyalty.isNew,
        tierUp: loyalty.customer.tier !== loyalty.prevTier,
      }
    : null;

  await dispatchWebhook(outlet._id.toString(), "order.created", order.toJSON());
  if (loyalty?.isNew) {
    await dispatchWebhook(outlet._id.toString(), "customer.created", {
      name: loyalty.customer.name,
      phone: loyalty.customer.phone,
      email: loyalty.customer.email,
    });
  }
  return order;
}

export async function forwardOrder(id: string, by?: string) {
  let order;
  try {
    order = await Order.findById(id);
  } catch {
    throw Object.assign(new Error("Invalid order id"), { status: 404 });
  }
  if (!order) throw Object.assign(new Error("Not found"), { status: 404 });
  if (order.status !== "Pending")
    throw Object.assign(new Error("Order is not pending review"), {
      status: 409,
    });
  order.status = "Queued";
  order.events.push({
    status: "Queued",
    at: new Date(),
    by: by as any,
    note: "Forwarded to kitchen",
  });
  await order.save();
  emit("order:update", order.toJSON(), order.outletId.toString());
  await notify({
    outletId: order.outletId.toString(),
    type: "order.new",
    level: "info",
    title: `${order.code} forwarded to kitchen`,
    body: `${order.items.length} items${
      order.tableCode ? ` · ${order.tableCode}` : ""
    }`,
    link: "/kds",
    targetRoles: ["admin", "manager", "kitchen"],
  });
  return order;
}

export async function forwardAddendum(id: string, by?: string) {
  let order;
  try {
    order = await Order.findById(id);
  } catch {
    throw Object.assign(new Error("Invalid order id"), { status: 404 });
  }
  if (!order) throw Object.assign(new Error("Not found"), { status: 404 });
  const pending = order.items.filter((i: any) => i.status === "Pending");
  if (pending.length === 0)
    throw Object.assign(new Error("No pending addendum items"), { status: 409 });

  // Deduct inventory for the newly-approved items via recipe BOM.
  const menuIds = pending.map((i: any) => i.menuItemId?.toString()).filter(Boolean);
  const menus = await MenuItem.find({ _id: { $in: menuIds } });
  const menuMap = new Map(menus.map((m: any) => [m._id.toString(), m]));
  for (const item of pending as any[]) {
    const m: any = menuMap.get(item.menuItemId?.toString() ?? "");
    for (const rec of m?.recipe ?? []) {
      await Ingredient.updateOne(
        { _id: rec.ingredientId },
        { $inc: { stock: -(rec.qty * item.qty) } }
      );
    }
  }

  // Promote each pending item to Queued so KDS can see it and assign an
  // item-level ETA immediately for customer visibility.
  const defaultItemEta =
    order.eta && order.eta > new Date()
      ? order.eta
      : new Date(Date.now() + 12 * 60 * 1000);
  for (const item of order.items as any[]) {
    if (item.status === "Pending") {
      item.status = "Queued";
      item.eta = defaultItemEta;
    }
  }
  // If the kitchen had already finished the earlier round, reopen the ticket
  // so the new items make it onto the line.
  if (["Ready", "Served"].includes(order.status)) {
    order.status = "In Progress";
    order.readyAt = undefined as any;
    order.servedAt = undefined as any;
  }
  order.events.push({
    status: `Addendum forwarded (${pending.length} items)`,
    at: new Date(),
    by: by as any,
  });
  await order.save();
  emit("order:update", order.toJSON(), order.outletId.toString());
  emit("inventory:update", {}, order.outletId.toString());
  await notify({
    outletId: order.outletId.toString(),
    type: "order.new",
    level: "info",
    title: `${order.code} · ${pending.length} new item${
      pending.length === 1 ? "" : "s"
    } forwarded`,
    body: `Kitchen may need to extend ETA${
      order.tableCode ? ` · ${order.tableCode}` : ""
    }`,
    link: "/kds",
    targetRoles: ["admin", "manager", "kitchen"],
  });
  return order;
}

export async function adjustEta(
  id: string,
  opts: { addMinutes?: number; absoluteMinutes?: number },
  by?: string
) {
  let order;
  try {
    order = await Order.findById(id);
  } catch {
    throw Object.assign(new Error("Invalid order id"), { status: 404 });
  }
  if (!order) throw Object.assign(new Error("Not found"), { status: 404 });
  const now = new Date();
  if (opts.absoluteMinutes && opts.absoluteMinutes > 0) {
    order.eta = new Date(now.getTime() + opts.absoluteMinutes * 60 * 1000);
    applyItemEta(order, order.eta);
  } else if (opts.addMinutes) {
    const base = order.eta && order.eta > now ? order.eta : now;
    order.eta = new Date(base.getTime() + opts.addMinutes * 60 * 1000);
    applyItemEta(order, order.eta);
  } else {
    throw Object.assign(new Error("Provide addMinutes or absoluteMinutes"), {
      status: 400,
    });
  }
  order.events.push({
    status: `ETA adjusted (${
      opts.addMinutes ? `+${opts.addMinutes}m` : `${opts.absoluteMinutes}m`
    })`,
    at: now,
    by: by as any,
  });
  await order.save();
  emit("order:update", order.toJSON(), order.outletId.toString());
  return order;
}

export async function adjustItemEta(
  orderId: string,
  itemId: string,
  opts: { addMinutes?: number; absoluteMinutes?: number },
  by?: string
) {
  let order;
  try {
    order = await Order.findById(orderId);
  } catch {
    throw Object.assign(new Error("Invalid order id"), { status: 404 });
  }
  if (!order) throw Object.assign(new Error("Not found"), { status: 404 });

  const rawItemId = String(itemId ?? "").trim();
  const item: any = (order.items as any[]).find((x: any) => {
    const lineId =
      x?._id != null ? String(x._id) : x?.id != null ? String(x.id) : "";
    return lineId && lineId === rawItemId;
  });
  if (!item) throw Object.assign(new Error("Order item not found"), { status: 404 });
  if (item.status === "Pending")
    throw Object.assign(new Error("Item is pending approval"), { status: 409 });
  if (item.status === "Ready")
    throw Object.assign(new Error("Item is already ready"), { status: 409 });

  const now = new Date();
  if (opts.absoluteMinutes && opts.absoluteMinutes > 0) {
    item.eta = new Date(now.getTime() + opts.absoluteMinutes * 60 * 1000);
  } else if (opts.addMinutes && opts.addMinutes > 0) {
    const base = item.eta && item.eta > now ? item.eta : now;
    item.eta = new Date(base.getTime() + opts.addMinutes * 60 * 1000);
  } else {
    throw Object.assign(new Error("Provide addMinutes or absoluteMinutes"), {
      status: 400,
    });
  }

  if (item.status === "Queued") item.status = "In Progress";
  order.events.push({
    status: `Item ETA adjusted (${item.name})`,
    at: now,
    by: by as any,
  });
  await order.save();
  emit("order:update", order.toJSON(), order.outletId.toString());
  return order;
}

// ─── Delivery ──────────────────────────────────────────────────────────────

async function ensureRiderAvailable(riderId: string) {
  const rider = await User.findById(riderId);
  if (!rider) throw Object.assign(new Error("Rider not found"), { status: 404 });
  if (rider.role !== "rider")
    throw Object.assign(new Error("User is not a rider"), { status: 400 });
  if (!rider.clockedInAt)
    throw Object.assign(new Error("Rider is off-shift"), { status: 409 });
  if (rider.onBreak)
    throw Object.assign(new Error("Rider is on break"), { status: 409 });
  const busy = await Order.findOne({
    riderId: rider._id,
    status: { $in: ["Ready", "Served"] },
    sessionClosed: { $ne: true },
  });
  if (busy)
    throw Object.assign(
      new Error(`Rider is already on delivery ${busy.code}`),
      { status: 409 }
    );
  return rider;
}

function canAssignOrClaimRider(order: any): boolean {
  if (["Ready", "Queued", "In Progress"].includes(order.status)) return true;
  // Kitchen may have hit "Served" by mistake before assignment — still dispatchable
  if (
    order.channel === "Delivery" &&
    order.status === "Served" &&
    !order.pickedUpAt &&
    !order.riderId
  )
    return true;
  return false;
}

export async function assignRider(
  orderId: string,
  riderId: string,
  by?: string
) {
  const order = await Order.findById(orderId);
  if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
  if (order.channel !== "Delivery")
    throw Object.assign(new Error("Not a delivery order"), { status: 400 });
  if (!canAssignOrClaimRider(order))
    throw Object.assign(
      new Error(`Can't assign a rider to a ${order.status} order`),
      { status: 409 }
    );
  const rider = await ensureRiderAvailable(riderId);
  order.riderId = rider._id as any;
  order.riderName = rider.name;
  order.assignedAt = new Date();
  order.events.push({
    status: `Assigned to rider ${rider.name}`,
    at: new Date(),
    by: by as any,
  });
  await order.save();
  emit("order:update", order.toJSON(), order.outletId.toString());
  await notify({
    outletId: order.outletId.toString(),
    type: "system",
    level: "info",
    title: `You've been assigned ${order.code}`,
    body: `${order.deliveryAddress ?? "Delivery"} · Rs ${(
      order.total ?? 0
    ).toLocaleString()}${order.cashOnDelivery ? " · COD" : ""}`,
    link: "/delivery",
    targetUserId: rider._id.toString(),
  });
  return order;
}

export async function claimDelivery(orderId: string, riderId: string) {
  const order = await Order.findById(orderId);
  if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
  if (order.channel !== "Delivery")
    throw Object.assign(new Error("Not a delivery order"), { status: 400 });
  if (order.riderId)
    throw Object.assign(new Error("Already assigned"), { status: 409 });
  if (!canAssignOrClaimRider(order))
    throw Object.assign(new Error("Order not claimable"), { status: 409 });
  const rider = await ensureRiderAvailable(riderId);
  order.riderId = rider._id as any;
  order.riderName = rider.name;
  order.assignedAt = new Date();
  order.events.push({
    status: `Claimed by rider ${rider.name}`,
    at: new Date(),
  });
  await order.save();
  emit("order:update", order.toJSON(), order.outletId.toString());
  await notify({
    outletId: order.outletId.toString(),
    type: "system",
    level: "info",
    title: `${rider.name} claimed ${order.code}`,
    body: `${order.deliveryAddress ?? "Delivery"} · Rs ${(
      order.total ?? 0
    ).toLocaleString()}`,
    link: "/orders",
    targetRoles: ["admin", "manager", "receptionist"],
  });
  return order;
}

export async function unassignRider(orderId: string, by?: string) {
  const order = await Order.findById(orderId);
  if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
  if (!order.riderId)
    throw Object.assign(new Error("No rider assigned"), { status: 409 });
  if (["Served", "Completed"].includes(order.status))
    throw Object.assign(
      new Error("Can't unassign after pickup"),
      { status: 409 }
    );
  const prev = order.riderName;
  order.riderId = undefined as any;
  order.riderName = undefined;
  order.assignedAt = undefined as any;
  order.events.push({
    status: `Unassigned from ${prev}`,
    at: new Date(),
    by: by as any,
  });
  await order.save();
  emit("order:update", order.toJSON(), order.outletId.toString());
  return order;
}

export async function deliveryPickup(orderId: string, by?: string) {
  const order = await Order.findById(orderId);
  if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
  if (order.channel !== "Delivery")
    throw Object.assign(new Error("Not a delivery order"), { status: 400 });
  if (!order.riderId)
    throw Object.assign(
      new Error("Order must be assigned to a rider first"),
      { status: 409 }
    );
  const readyForHandoff =
    order.status === "Ready" ||
    (order.status === "Served" && !order.pickedUpAt);
  if (!readyForHandoff)
    throw Object.assign(
      new Error("Food isn't ready for pickup yet"),
      { status: 409 }
    );
  const now = new Date();
  order.status = "Served"; // "Served" = picked up & en route
  order.servedAt = now;
  order.pickedUpAt = now;
  order.events.push({
    status: "Picked up by rider",
    at: now,
    by: by as any,
  });
  await order.save();
  emit("order:update", order.toJSON(), order.outletId.toString());
  await notify({
    outletId: order.outletId.toString(),
    type: "order.ready",
    level: "info",
    title: `${order.code} en route`,
    body: `${order.riderName ?? "Rider"} headed to ${
      order.deliveryAddress ?? "customer"
    }`,
    link: "/orders",
    targetRoles: ["admin", "manager", "receptionist"],
  });
  return order;
}

export async function deliveryDelivered(
  orderId: string,
  by?: string,
  opts?: { paymentCollected?: boolean }
) {
  const order = await Order.findById(orderId);
  if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
  if (order.status !== "Served")
    throw Object.assign(
      new Error("Order is not in transit"),
      { status: 409 }
    );
  const now = new Date();
  order.status = "Completed";
  order.closedAt = now;
  order.deliveredAt = now;
  if (order.cashOnDelivery && opts?.paymentCollected) {
    order.paymentStatus = "Paid";
    order.paymentMethod = "Cash";
  }
  order.events.push({
    status: "Delivered",
    at: now,
    by: by as any,
    note: order.cashOnDelivery && opts?.paymentCollected ? "COD collected" : undefined,
  });
  await order.save();
  emit("order:update", order.toJSON(), order.outletId.toString());
  await notify({
    outletId: order.outletId.toString(),
    type: "order.completed",
    level: "success",
    title: `${order.code} delivered`,
    body: `${order.riderName ?? "Rider"} · Rs ${(
      order.total ?? 0
    ).toLocaleString()}${
      order.cashOnDelivery && opts?.paymentCollected ? " · COD collected" : ""
    }`,
    link: "/orders",
    targetRoles: ["admin", "manager", "receptionist"],
  });
  return order;
}

export async function deliveryFailed(
  orderId: string,
  reason: string,
  by?: string
) {
  const order = await Order.findById(orderId);
  if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
  if (!["Ready", "Served"].includes(order.status))
    throw Object.assign(
      new Error("Order not in a deliverable state"),
      { status: 409 }
    );
  const now = new Date();
  order.failureReason = reason;
  order.events.push({
    status: `Delivery failed · ${reason}`,
    at: now,
    by: by as any,
  });
  // Keep status as-is (Ready or Served) and mark for manual intervention.
  // Manager can then reassign or cancel.
  await order.save();
  emit("order:update", order.toJSON(), order.outletId.toString());
  await notify({
    outletId: order.outletId.toString(),
    type: "system",
    level: "error",
    title: `${order.code} delivery failed`,
    body: `${reason}${
      order.riderName ? ` · rider ${order.riderName}` : ""
    } · needs resolution`,
    link: "/orders",
    targetRoles: ["admin", "manager", "receptionist"],
  });
  return order;
}

export async function closeTableSession(tableId: string, outletId: string) {
  const since = new Date(Date.now() - 6 * 60 * 60 * 1000);
  await Order.updateMany(
    {
      tableId,
      placedAt: { $gte: since },
      sessionClosed: { $ne: true },
    },
    { $set: { sessionClosed: true } }
  );
  await Table.updateOne(
    { _id: tableId },
    {
      status: "Free",
      currentOrderId: null,
      seatedAt: null,
      guests: null,
      waiterId: null,
    }
  );
  emit("table:update", { id: tableId.toString() }, outletId);
  emit("order:update", { tableId: tableId.toString() }, outletId);
}

export async function transitionOrder(
  id: string,
  to: "In Progress" | "Ready" | "Served" | "Completed" | "Cancelled",
  by?: string,
  opts?: { etaMinutes?: number }
) {
  const order = await Order.findById(id);
  if (!order) throw Object.assign(new Error("Not found"), { status: 404 });
  if (to === "Served" && order.channel === "Delivery") {
    throw Object.assign(
      new Error(
        "Delivery: food stays at Ready until a rider is assigned and taps Pick up on the Delivery page — do not mark Served from the kitchen."
      ),
      { status: 409 }
    );
  }
  const now = new Date();
  order.status = to;
  if (to === "In Progress" && !order.acceptedAt) {
    order.acceptedAt = now;
    const etaMin = Number(opts?.etaMinutes);
    if (etaMin && etaMin > 0 && etaMin < 240) {
      order.eta = new Date(now.getTime() + etaMin * 60 * 1000);
      applyItemEta(order, order.eta, true);
    }
    for (const item of order.items as any[]) {
      if (item.status === "Queued") item.status = "In Progress";
    }
  }
  if (to === "Ready") {
    order.readyAt = now;
    for (const item of order.items as any[]) {
      if (item.status !== "Pending") {
        item.status = "Ready";
        item.eta = undefined;
      }
    }
  }
  if (to === "Served") order.servedAt = now;
  if (to === "Completed") {
    order.closedAt = now;
  }
  order.events.push({ status: to, at: now, by: by as any });
  await order.save();

  // Completing an order is the end of the transaction — free the table and
  // close the customer session so the next guest starts fresh.
  if (to === "Completed" && order.tableId) {
    await closeTableSession(
      order.tableId.toString(),
      order.outletId.toString()
    );
  }
  emit("order:update", order.toJSON(), order.outletId.toString());
  if (to === "Ready") {
    // Who's on the hook for pickup depends on the channel:
    //   Dine-in   → waiter brings it to the table
    //   Delivery  → rider picks it up for dispatch
    //   Takeaway  → receptionist hands off to the guest at the counter
    const channel = order.channel ?? "Dine-in";
    let readyTargets: string[];
    let readyBody: string;
    let readyLink: string;
    if (channel === "Delivery") {
      readyTargets = ["admin", "manager", "rider"];
      readyBody = `Delivery pickup · assign rider`;
      readyLink = "/delivery";
    } else if (channel === "Dine-in") {
      readyTargets = ["admin", "manager", "waiter"];
      readyBody = order.tableCode
        ? `Serve to ${order.tableCode}`
        : `Serve to customer`;
      readyLink = "/waiter";
    } else {
      // Takeaway + Phone
      readyTargets = ["admin", "manager", "receptionist"];
      readyBody = `Counter pickup · ${
        order.customerName ?? "guest"
      }`;
      readyLink = "/orders";
    }
    await notify({
      outletId: order.outletId.toString(),
      type: "order.ready",
      level: "success",
      title: `${order.code} ready`,
      body: readyBody,
      link: readyLink,
      targetRoles: readyTargets,
    });
    await dispatchWebhook(order.outletId.toString(), "order.ready", order.toJSON());
  }
  if (to === "Cancelled") {
    await dispatchWebhook(order.outletId.toString(), "order.cancelled", order.toJSON());
  }
  return order;
}

export async function payOrder(
  id: string,
  method: "Cash" | "Card" | "JazzCash" | "Easypaisa" | "Stripe" | "BankTransfer"
) {
  const order = await Order.findById(id);
  if (!order) throw Object.assign(new Error("Not found"), { status: 404 });
  const now = new Date();
  order.paymentStatus = "Paid";
  order.paymentMethod = method;

  // If the customer has already received their food, paying ends the
  // transaction — close the order and free the table in one step. If food
  // hasn't been served yet (pre-pay case), we just record the payment and
  // leave the order/table alone.
  const servedAlready = ["Served", "Completed"].includes(order.status);
  if (servedAlready && order.status === "Served") {
    order.status = "Completed";
    order.closedAt = now;
    order.events.push({
      status: "Completed",
      at: now,
      note: `Closed via payment · ${method}`,
    });
  }
  await order.save();

  if (servedAlready && order.tableId) {
    await closeTableSession(
      order.tableId.toString(),
      order.outletId.toString()
    );
  }
  emit("order:update", order.toJSON(), order.outletId.toString());
  await dispatchWebhook(order.outletId.toString(), "order.paid", order.toJSON());
  return order;
}
