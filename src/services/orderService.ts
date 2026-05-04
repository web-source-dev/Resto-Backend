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
import { audit } from "./audit";

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

/** Order ETA = latest item ETA (parallel prep), not the sum of line times. */
function syncOrderEtaFromItems(order: any) {
  let maxTs = 0;
  for (const item of order.items as any[]) {
    if (item.status === "Pending" || item.status === "Ready" || item.status === "Cancelled") continue;
    if (!item.eta) continue;
    const t = new Date(item.eta).getTime();
    if (!Number.isFinite(t)) continue;
    if (t > maxTs) maxTs = t;
  }
  if (maxTs > 0) order.eta = new Date(maxTs);
  else order.eta = undefined;
}

/**
 * Naive total recompute — mirrors the inline formula already used by the
 * QR addendum path so behaviour stays identical. Cancelled items are
 * excluded from subtotal so refunds don't carry tax/service. Coupon
 * discounts are intentionally NOT re-applied here (matches existing qr.ts
 * behaviour; full repricing on every line edit is a separate concern).
 */
function recomputeOrderTotals(order: any, outlet: any) {
  const subtotal = (order.items as any[])
    .filter((i) => i.status !== "Cancelled")
    .reduce((s, x) => s + (x.price ?? 0) * (x.qty ?? 0), 0);
  const taxRate = outlet?.taxRate ?? 0;
  const serviceRate = outlet?.serviceRate ?? 0;
  order.subtotal = subtotal;
  order.tax = Math.round(subtotal * taxRate);
  order.service = Math.round(subtotal * serviceRate);
  order.total = order.subtotal + order.tax + order.service;
}

/**
 * Pre-flight stock check for a batch of items about to be queued. Walks
 * each menu item's recipe BOM and asserts every ingredient has enough
 * stock for the requested qty. Throws 409 with the first short ingredient
 * named, so callers don't half-deduct then fail. Items with no recipe
 * (e.g. pure-resale beverages) skip the check.
 */
async function assertItemsInStock(
  menuMap: Map<string, any>,
  items: { menuItemId: any; qty: number; name?: string }[]
) {
  // Aggregate required qty per ingredient across all items in the batch so
  // two lines of the same dish don't each pass the check independently.
  const required = new Map<string, { needed: number; itemName: string }>();
  for (const it of items) {
    const m: any = menuMap.get(String(it.menuItemId));
    if (!m?.recipe?.length) continue;
    for (const r of m.recipe) {
      const key = String(r.ingredientId);
      const prev = required.get(key);
      const needed = (prev?.needed ?? 0) + Number(r.qty) * Number(it.qty);
      required.set(key, { needed, itemName: it.name ?? m.name });
    }
  }
  if (required.size === 0) return;
  const ings = await Ingredient.find({ _id: { $in: [...required.keys()] } });
  for (const ing of ings as any[]) {
    const r = required.get(String(ing._id));
    if (!r) continue;
    if ((ing.stock ?? 0) < r.needed) {
      throw Object.assign(
        new Error(`Out of stock: ${ing.name} (needed for ${r.itemName})`),
        { status: 409 }
      );
    }
  }
}

/**
 * Apply a stock delta atomically with two guarantees:
 *   1. Result is rounded to 4 decimal places, so float drift from many
 *      small `$inc` ops doesn't accumulate (the bug behind values like
 *      "7.149999999999997 kg left").
 *   2. Result is clamped at 0 — order BOM consumption can't push stock
 *      negative even when there's no pre-flight check (e.g. `createOrder`).
 *
 * Uses Mongo's aggregation-pipeline update so it's a single round-trip and
 * race-safe.
 */
async function applyStockDelta(ingredientId: any, delta: number) {
  if (!Number.isFinite(delta) || delta === 0) return;
  await Ingredient.updateOne({ _id: ingredientId }, [
    {
      $set: {
        stock: {
          $round: [
            {
              $max: [
                0,
                { $add: [{ $ifNull: ["$stock", 0] }, delta] },
              ],
            },
            4,
          ],
        },
      },
    },
  ]);
  // Keep MenuItem.stockStatus consistent so the QR public menu and KDS
  // 86-list reflect reality. Cheap because it only touches menus that
  // reference this ingredient.
  await recomputeMenuStockStatusForIngredient(ingredientId);
}

/**
 * Re-evaluate `stockStatus` (OK / Low / Out) on every MenuItem whose recipe
 * references this ingredient. Called whenever an ingredient's stock or par
 * changes via order BOM, supplies usage, wastage, /adjust, PATCH, or PO
 * receipt. Without this, `MenuItem.stockStatus` is set once at seed time
 * and silently drifts — items show "Out" while the kitchen has plenty of
 * the underlying ingredient.
 */
export async function recomputeMenuStockStatusForIngredient(ingredientId: any) {
  const menus = await MenuItem.find({ "recipe.ingredientId": ingredientId });
  if (menus.length === 0) return;
  // Collect all ingredient ids any of these menus need so we can batch-fetch.
  const ingIds = new Set<string>();
  for (const m of menus as any[]) {
    for (const r of m.recipe ?? []) ingIds.add(String(r.ingredientId));
  }
  const ings = await Ingredient.find({ _id: { $in: [...ingIds] } });
  const ingMap = new Map(ings.map((i: any) => [String(i._id), i]));
  for (const m of menus as any[]) {
    let status: "OK" | "Low" | "Out" = "OK";
    for (const rec of m.recipe ?? []) {
      const ing: any = ingMap.get(String(rec.ingredientId));
      if (!ing) continue;
      if ((ing.stock ?? 0) <= 0) {
        status = "Out";
        break;
      }
      if ((ing.stock ?? 0) < (ing.par ?? 0)) status = "Low";
    }
    if (m.stockStatus !== status) {
      await MenuItem.updateOne({ _id: m._id }, { $set: { stockStatus: status } });
    }
  }
}

async function deductRecipeBom(menuMap: Map<string, any>, items: any[]) {
  for (const item of items) {
    const m: any = menuMap.get(String(item.menuItemId ?? ""));
    for (const rec of m?.recipe ?? []) {
      await applyStockDelta(rec.ingredientId, -(rec.qty * item.qty));
    }
  }
}

async function restoreRecipeBom(menuMap: Map<string, any>, items: any[]) {
  for (const item of items) {
    const m: any = menuMap.get(String(item.menuItemId ?? ""));
    for (const rec of m?.recipe ?? []) {
      await applyStockDelta(rec.ingredientId, rec.qty * item.qty);
    }
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
      await applyStockDelta(r.ingredientId, -(r.qty * i.qty));
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

export async function forwardAddendum(id: string, by?: string, byName?: string) {
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

  const menuIds = pending.map((i: any) => i.menuItemId?.toString()).filter(Boolean);
  const menus = await MenuItem.find({ _id: { $in: menuIds } });
  const menuMap = new Map(menus.map((m: any) => [m._id.toString(), m]));

  // Pre-flight stock check across the whole pending batch — if any
  // ingredient is short, fail before mutating inventory so the receptionist
  // can either swap the item or 86 it.
  await assertItemsInStock(menuMap, pending as any);

  // Deduct inventory for the newly-approved items via recipe BOM.
  await deductRecipeBom(menuMap, pending as any);

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
  syncOrderEtaFromItems(order);
  // If the kitchen had already finished the earlier round, reopen the ticket
  // so the new items make it onto the line.
  if (["Ready", "Served"].includes(order.status)) {
    order.status = "In Progress";
    order.readyAt = undefined as any;
    order.servedAt = undefined as any;
  }
  // QR-initiated orders sit at "Pending" until the receptionist reviews. If a
  // customer added items BEFORE that review, forwarding the addendum should
  // also advance the parent — otherwise the customer's tracking page shows
  // "Pending" while the kitchen is already cooking the lines.
  if (order.status === "Pending") {
    order.status = "Queued";
  }
  // If the bill was already paid, reopen it. paidAmount stays so the UI can
  // show balanceDue. Refunded bills aren't reopened — those are closed cases.
  if (order.paymentStatus === "Paid") {
    order.paymentStatus = "Pending";
    order.events.push({
      status: "Bill reopened (addendum on paid order)",
      at: new Date(),
      by: by as any,
    });
  }
  const reopenedPaid = order.paymentStatus === "Pending" && (order.paidAmount ?? 0) > 0;
  order.events.push({
    status: `Addendum forwarded (${pending.length} items)`,
    at: new Date(),
    by: by as any,
  });
  await order.save();
  await audit({
    outletId: order.outletId.toString(),
    userId: by,
    userName: byName,
    action: "order.addendum.forward",
    targetType: "Order",
    targetId: String(order._id),
    after: {
      code: order.code,
      pendingCount: pending.length,
      reopenedPaidBill: reopenedPaid,
    },
  });
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

/**
 * Staff-initiated addendum: a waiter/receptionist takes a verbal request from
 * a guest and types it in. Bypasses the receptionist review queue (staff
 * already approved by entering it) and goes straight to Queued so the KDS
 * sees it immediately.
 */
export async function appendItemsByStaff(args: {
  orderId: string;
  items: { menuItemId: string; qty: number; mods?: string[]; note?: string }[];
  by?: string;
  byName?: string;
}) {
  let order: any;
  try {
    order = await Order.findById(args.orderId);
  } catch {
    throw Object.assign(new Error("Invalid order id"), { status: 404 });
  }
  if (!order) throw Object.assign(new Error("Not found"), { status: 404 });
  if (["Completed", "Cancelled"].includes(order.status))
    throw Object.assign(new Error("Order is already closed"), { status: 409 });
  if (!Array.isArray(args.items) || args.items.length === 0)
    throw Object.assign(new Error("items[] required"), { status: 400 });

  const outlet = await Outlet.findById(order.outletId);
  const menus = await MenuItem.find({
    _id: { $in: args.items.map((i) => i.menuItemId) },
  });
  const menuMap = new Map(menus.map((m: any) => [m._id.toString(), m]));

  const now = new Date();
  // Match the existing forwardAddendum policy: if the order's ETA is already
  // in the future, slot new lines onto that ETA so KDS doesn't promise the
  // guest something earlier than the dish that's already cooking.
  const defaultItemEta =
    order.eta && order.eta > now
      ? order.eta
      : new Date(now.getTime() + 12 * 60 * 1000);

  const newItems = args.items.map((i) => {
    const m: any = menuMap.get(String(i.menuItemId));
    if (!m)
      throw Object.assign(new Error(`Unknown menu item ${i.menuItemId}`), {
        status: 400,
      });
    return {
      menuItemId: m._id,
      name: m.name,
      qty: Number(i.qty) || 1,
      price: m.price,
      mods: i.mods ?? [],
      note: i.note,
      status: "Queued" as const,
      addendum: true,
      addedAt: now,
      eta: defaultItemEta,
    };
  });

  // Pre-flight stock check before any mutation.
  await assertItemsInStock(menuMap, newItems as any);

  // Push, deduct inventory, recompute totals.
  order.items.push(...(newItems as any));
  await deductRecipeBom(menuMap, newItems as any);
  recomputeOrderTotals(order, outlet);

  // Reopen the ticket if the previous round was already done.
  if (["Ready", "Served"].includes(order.status)) {
    order.status = "In Progress";
    order.readyAt = undefined;
    order.servedAt = undefined;
  } else if (order.status === "Pending" || order.status === "Queued") {
    // Leave as-is — these states already include unprepared items.
  }
  // Reopen the bill if it was paid; paidAmount stays so balanceDue surfaces.
  if (order.paymentStatus === "Paid") {
    order.paymentStatus = "Pending";
    order.events.push({
      status: "Bill reopened (addendum on paid order)",
      at: now,
      by: args.by as any,
    });
  }
  syncOrderEtaFromItems(order);
  order.events.push({
    status: `Items added by staff (${newItems.length})${
      args.byName ? ` · ${args.byName}` : ""
    }`,
    at: now,
    by: args.by as any,
  });
  await order.save();

  emit("order:update", order.toJSON(), order.outletId.toString());
  emit("inventory:update", {}, order.outletId.toString());
  await notify({
    outletId: order.outletId.toString(),
    type: "order.new",
    level: "info",
    title: `${order.code} · ${newItems.length} new item${
      newItems.length === 1 ? "" : "s"
    } added`,
    body: `Kitchen has new items${
      order.tableCode ? ` · ${order.tableCode}` : ""
    }`,
    link: "/kds",
    targetRoles: ["admin", "manager", "kitchen"],
  });
  await audit({
    outletId: order.outletId.toString(),
    userId: args.by,
    userName: args.byName,
    action: "order.append",
    targetType: "Order",
    targetId: String(order._id),
    after: {
      code: order.code,
      added: newItems.map((i: any) => ({ name: i.name, qty: i.qty, price: i.price })),
      newTotal: order.total,
    },
  });
  return order;
}

/**
 * Constants & helpers for non-recipe supply tracking. Reuses the Ingredient
 * collection (so POs, low-stock alerts, and supplier variance work for free)
 * and tags rows by category.
 */
export const SUPPLY_CATEGORIES = [
  "Packaging",
  "Condiments",
  "Disposables",
  "Cleaning",
] as const;

/**
 * Record ad-hoc supply usage on an order. For predictable per-dish usage
 * (every burger gets a napkin) put the supply in the menu's recipe BOM
 * instead — that auto-deducts. This endpoint is for variable cases:
 * leftover packing, refills, special-request sachets.
 */
export async function recordSupplyUsage(args: {
  orderId: string;
  supplies: { ingredientId: string; qty: number; reason?: string }[];
  by?: string;
  byName?: string;
}) {
  let order: any;
  try {
    order = await Order.findById(args.orderId);
  } catch {
    throw Object.assign(new Error("Invalid order id"), { status: 404 });
  }
  if (!order) throw Object.assign(new Error("Not found"), { status: 404 });
  if (!Array.isArray(args.supplies) || args.supplies.length === 0)
    throw Object.assign(new Error("supplies[] required"), { status: 400 });

  const ids = args.supplies.map((s) => s.ingredientId);
  const ings = await Ingredient.find({
    _id: { $in: ids },
    outletId: order.outletId,
  });
  const ingMap = new Map<string, any>(ings.map((i: any) => [String(i._id), i]));

  // Validate everything before mutating any stock.
  for (const line of args.supplies) {
    const ing = ingMap.get(String(line.ingredientId));
    if (!ing)
      throw Object.assign(new Error(`Unknown supply ${line.ingredientId}`), {
        status: 400,
      });
    const qty = Number(line.qty);
    if (!Number.isFinite(qty) || qty <= 0)
      throw Object.assign(new Error(`Invalid qty for ${ing.name}`), {
        status: 400,
      });
    if ((ing.stock ?? 0) < qty)
      throw Object.assign(
        new Error(
          `Out of stock: ${ing.name} (have ${ing.stock ?? 0} ${ing.unit ?? ""}, need ${qty})`
        ),
        { status: 409 }
      );
  }

  // Deduct + denormalize each line onto the order for cost reporting.
  const now = new Date();
  for (const line of args.supplies) {
    const ing: any = ingMap.get(String(line.ingredientId));
    const qty = Number(line.qty);
    await applyStockDelta(ing._id, -qty);
    order.supplies.push({
      ingredientId: ing._id,
      name: ing.name,
      qty,
      unit: ing.unit,
      costPerUnit: ing.costPerUnit ?? 0,
      at: now,
      by: args.by as any,
      byName: args.byName,
      reason: line.reason,
    });
  }

  const summary = args.supplies
    .map((s) => {
      const ing = ingMap.get(String(s.ingredientId));
      return `${s.qty} ${ing?.unit ?? ""} ${ing?.name ?? ""}`.trim();
    })
    .join(", ");
  order.events.push({
    status: `Supplies used · ${summary}`,
    at: now,
    by: args.by as any,
  });
  await order.save();

  emit("order:update", order.toJSON(), order.outletId.toString());
  emit("inventory:update", {}, order.outletId.toString());
  await audit({
    outletId: order.outletId.toString(),
    userId: args.by,
    userName: args.byName,
    action: "order.supplies",
    targetType: "Order",
    targetId: String(order._id),
    after: {
      code: order.code,
      supplies: args.supplies.map((s) => {
        const ing: any = ingMap.get(String(s.ingredientId));
        return {
          name: ing?.name,
          qty: s.qty,
          unit: ing?.unit,
          costPerUnit: ing?.costPerUnit,
          reason: s.reason,
        };
      }),
    },
  });
  return order;
}

/**
 * Cancel a single line item. Cannot cancel a line that is already Ready —
 * the food's already cooked, so that's a comp/refund, not a cancel. Cancels
 * an in-flight item: kitchen is told to pull it off the line and inventory
 * deducted by the BOM is restored.
 */
export async function cancelOrderItem(args: {
  orderId: string;
  itemId: string;
  by?: string;
  byName?: string;
  reason?: string;
}) {
  let order: any;
  try {
    order = await Order.findById(args.orderId);
  } catch {
    throw Object.assign(new Error("Invalid order id"), { status: 404 });
  }
  if (!order) throw Object.assign(new Error("Not found"), { status: 404 });

  const item = (order.items as any[]).find(
    (i) => String(i._id) === String(args.itemId)
  );
  if (!item) throw Object.assign(new Error("Item not found"), { status: 404 });
  if (item.status === "Cancelled")
    throw Object.assign(new Error("Item already cancelled"), { status: 409 });
  if (item.status === "Ready")
    throw Object.assign(
      new Error("Cannot cancel a Ready item — refund or comp instead"),
      { status: 409 }
    );
  // Once the kitchen has started cooking, ingredients are committed and the
  // line is on a station. Telling the guest "kitchen's already on it — order
  // something else if you've changed your mind" is the right move; cancelling
  // mid-prep wastes food. Only Pending/Queued (kitchen hasn't started) can be
  // pulled.
  if (item.status === "In Progress")
    throw Object.assign(
      new Error(
        "Item is already being prepared — ask the guest to add a new item instead"
      ),
      { status: 409 }
    );

  // Pending items haven't deducted yet (review queue). Queued items have.
  // In Progress is now blocked above so we never reach this for it.
  const wasDeducted = item.status === "Queued";
  if (wasDeducted && item.menuItemId) {
    const m = await MenuItem.findById(item.menuItemId);
    const menuMap = new Map<string, any>();
    if (m) menuMap.set(String(m._id), m);
    await restoreRecipeBom(menuMap, [item]);
  }

  const now = new Date();
  item.status = "Cancelled";
  item.cancelledAt = now;
  if (args.reason) item.cancelReason = args.reason;

  const outlet = await Outlet.findById(order.outletId);
  recomputeOrderTotals(order, outlet);
  syncOrderEtaFromItems(order);
  order.events.push({
    status: `Item cancelled · ${item.name}${
      args.reason ? ` · ${args.reason}` : ""
    }`,
    at: now,
    by: args.by as any,
  });
  await order.save();

  emit("order:update", order.toJSON(), order.outletId.toString());
  if (wasDeducted) emit("inventory:update", {}, order.outletId.toString());
  await audit({
    outletId: order.outletId.toString(),
    userId: args.by,
    userName: args.byName,
    action: "order.item.cancel",
    targetType: "Order",
    targetId: String(order._id),
    before: {
      itemId: String(item._id),
      name: item.name,
      qty: item.qty,
      price: item.price,
      stockWasDeducted: wasDeducted,
    },
    after: {
      code: order.code,
      reason: args.reason,
      newTotal: order.total,
    },
  });
  await notify({
    outletId: order.outletId.toString(),
    type: "order.new",
    level: "warn",
    title: `${order.code} · item cancelled`,
    body: `${item.name}${args.reason ? ` · ${args.reason}` : ""}${
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
    const items: any[] = (order.items as any[]) ?? [];
    const bumpable = items.filter(
      (it) =>
        it.eta &&
        !["Pending", "Ready"].includes(it.status)
    );
    if (bumpable.length > 0) {
      const ms = opts.addMinutes * 60 * 1000;
      for (const it of bumpable) {
        it.eta = new Date(new Date(it.eta).getTime() + ms);
      }
      syncOrderEtaFromItems(order);
    } else {
      const base = order.eta && order.eta > now ? order.eta : now;
      order.eta = new Date(base.getTime() + opts.addMinutes * 60 * 1000);
      applyItemEta(order, order.eta);
    }
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
  syncOrderEtaFromItems(order);
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
  // Reject the cash-collected flag on non-COD orders. Without this, a rider
  // who taps "collected" on a card-prepaid order silently loses the cash —
  // the server used to ignore the flag (paymentStatus stayed Pending) and
  // the rider had no signal that anything went wrong.
  if (opts?.paymentCollected && !order.cashOnDelivery) {
    throw Object.assign(
      new Error("paymentCollected is only valid on cash-on-delivery orders"),
      { status: 400 }
    );
  }
  const now = new Date();
  order.status = "Completed";
  order.closedAt = now;
  order.deliveredAt = now;
  if (order.cashOnDelivery && opts?.paymentCollected) {
    order.paymentStatus = "Paid";
    order.paymentMethod = "Cash";
    (order as any).paidAmount = order.total ?? 0;
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
  const previousRiderName = order.riderName;
  const previousRiderId = order.riderId;
  order.failureReason = reason;
  // Release the rider so they can claim their next delivery. Without this,
  // a failed delivery left `riderId` set and any subsequent `claim` 409'd
  // with "Rider is already on delivery #X" — rider got stuck until manager
  // intervened. Roll the order back to Ready so dispatch can reassign.
  order.riderId = undefined as any;
  order.riderName = undefined as any;
  order.assignedAt = undefined as any;
  order.pickedUpAt = undefined as any;
  order.status = "Ready";
  order.events.push({
    status: `Delivery failed · ${reason}${
      previousRiderName ? ` · ${previousRiderName} released` : ""
    }`,
    at: now,
    by: by as any,
  });
  await order.save();
  emit("order:update", order.toJSON(), order.outletId.toString());
  await notify({
    outletId: order.outletId.toString(),
    type: "system",
    level: "error",
    title: `${order.code} delivery failed`,
    body: `${reason}${
      previousRiderName ? ` · rider ${previousRiderName}` : ""
    } · needs resolution`,
    link: "/orders",
    targetRoles: ["admin", "manager", "receptionist"],
  });
  // Personal note to the now-released rider so they know they're free again.
  if (previousRiderId) {
    await notify({
      outletId: order.outletId.toString(),
      type: "system",
      level: "warn",
      title: `${order.code} marked failed`,
      body: `You're free to claim a new delivery`,
      link: "/delivery",
      targetUserId: String(previousRiderId),
    });
  }
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
  opts?: { etaMinutes?: number; byName?: string }
) {
  const order = await Order.findById(id);
  if (!order) throw Object.assign(new Error("Not found"), { status: 404 });
  const fromStatus = order.status;
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
    // Line-level ETAs on KDS drive order.eta via syncOrderEtaFromItems (max of lines).
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
    syncOrderEtaFromItems(order);
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
  // Audit only state changes that are operationally interesting — Cancelled
  // and Completed are the high-stakes ones (refund / close-out). Logging
  // every In-Progress / Ready / Served transition would drown the activity
  // page; per-order events already capture those.
  if (to === "Cancelled" || to === "Completed") {
    await audit({
      outletId: order.outletId.toString(),
      userId: by,
      userName: opts?.byName,
      action: `order.transition.${to.toLowerCase().replace(/\s+/g, "")}`,
      targetType: "Order",
      targetId: String(order._id),
      before: { status: fromStatus },
      after: {
        code: order.code,
        status: to,
        total: order.total,
        paymentStatus: order.paymentStatus,
      },
    });
  }
  return order;
}

export async function payOrder(
  id: string,
  method: "Cash" | "Card" | "JazzCash" | "Easypaisa" | "Stripe" | "BankTransfer",
  by?: string,
  byName?: string
) {
  const order = await Order.findById(id);
  if (!order) throw Object.assign(new Error("Not found"), { status: 404 });
  const now = new Date();
  order.paymentStatus = "Paid";
  order.paymentMethod = method;
  // Snapshot what was actually collected. If an addendum re-opens this bill,
  // paymentStatus flips back to Pending but paidAmount stays, so the UI can
  // surface balanceDue = total - paidAmount without re-asking what was paid.
  (order as any).paidAmount = order.total ?? 0;

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
  await audit({
    outletId: order.outletId.toString(),
    userId: by,
    userName: byName,
    action: "order.pay",
    targetType: "Order",
    targetId: String(order._id),
    after: {
      code: order.code,
      method,
      amount: order.total,
      paidAmount: (order as any).paidAmount,
    },
  });
  return order;
}
