import bcrypt from "bcryptjs";
import { Outlet } from "../models/Outlet";
import { User } from "../models/User";
import { Table } from "../models/Table";
import { Category } from "../models/Category";
import { Ingredient } from "../models/Ingredient";
import { MenuItem } from "../models/MenuItem";
import { Customer } from "../models/Customer";
import { Order } from "../models/Order";
import { Wastage } from "../models/Wastage";
import { Review } from "../models/Review";
import { Reservation } from "../models/Reservation";
import { Expense } from "../models/Expense";
import { Promotion } from "../models/Promotion";
import { PricingRule } from "../models/PricingRule";
import { AnomalyRule } from "../models/AnomalyRule";
import { AnomalyEvent } from "../models/AnomalyEvent";
import { NotificationTemplate } from "../models/NotificationTemplate";
import { AuditLog } from "../models/AuditLog";

function d(offsetMin: number) {
  return new Date(Date.now() + offsetMin * 60 * 1000);
}

function rand<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export async function maybeSeed() {
  if ((await Outlet.countDocuments()) > 0) {
    console.log("[seed] already populated, skipping");
    return;
  }

  console.log("[seed] populating initial data…");

  const outlet = await Outlet.create({
    name: "Dinova — Gulberg Outlet",
    address: "M.M. Alam Road, Gulberg III, Lahore",
    phone: "+92 42 3577 8899",
    taxRate: 0.16,
    serviceRate: 0.05,
  });

  const adminPw = await bcrypt.hash("admin123", 10);
  const admin = await User.create({
    outletId: outlet._id,
    name: "Gian Baio",
    email: "admin@dinova.dev",
    passwordHash: adminPw,
    role: "admin",
    phone: "+92 300 0000001",
    hourlyRate: 0,
    hireDate: new Date("2024-01-15"),
    rating: 4.9,
  });

  const staffSeed = [
    { name: "Bilal Ahmed", email: "bilal@dinova.dev", role: "waiter", phone: "+92 333 1111111", shift: "Lunch · 11a–5p", rating: 4.8, hr: 350 },
    { name: "Sana Iqbal", email: "sana@dinova.dev", role: "waiter", phone: "+92 333 2222222", shift: "Lunch · 11a–5p", rating: 4.6, hr: 320 },
    { name: "Ali Raza", email: "ali@dinova.dev", role: "waiter", phone: "+92 333 3333333", shift: "Lunch · 11a–5p", rating: 4.3, hr: 300 },
    { name: "Kashif Nawaz", email: "kashif@dinova.dev", role: "kitchen", phone: "+92 333 4444444", shift: "Full · 10a–10p", rating: 4.7, hr: 480 },
    { name: "Faizan Aslam", email: "faizan@dinova.dev", role: "kitchen", phone: "+92 333 5555555", shift: "Full · 10a–10p", rating: 4.5, hr: 380 },
    { name: "Hina Rasheed", email: "hina@dinova.dev", role: "receptionist", phone: "+92 333 6666666", shift: "Lunch · 11a–5p", rating: 4.9, hr: 340 },
    // Uses the rider@dinova.dev email so ensureUsers refreshes it instead of duplicating.
    { name: "Imran Shah", email: "rider@dinova.dev", role: "rider", phone: "+92 333 7777777", shift: "Peak · 5p–11p", rating: 4.4, hr: 280 },
  ];
  const defaultPw = await bcrypt.hash("password", 10);
  const staff: any[] = [];
  for (const s of staffSeed) {
    const u = await User.create({
      outletId: outlet._id,
      name: s.name,
      email: s.email,
      passwordHash: defaultPw,
      role: s.role as any,
      phone: s.phone,
      currentShift: s.shift,
      rating: s.rating,
      hourlyRate: s.hr,
      hireDate: new Date("2024-06-01"),
      // Everyone including the rider starts clocked in so the delivery page has
      // demo data out of the gate.
      clockedInAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });
    staff.push(u);
  }

  // Tables
  const tableDefs = [
    { code: "T-01", capacity: 4, zone: "Indoor" },
    { code: "T-02", capacity: 4, zone: "Indoor" },
    { code: "T-03", capacity: 2, zone: "Indoor" },
    { code: "T-04", capacity: 6, zone: "Indoor" },
    { code: "T-05", capacity: 2, zone: "Indoor" },
    { code: "T-06", capacity: 4, zone: "Indoor" },
    { code: "T-07", capacity: 4, zone: "Outdoor" },
    { code: "T-08", capacity: 2, zone: "Outdoor" },
    { code: "T-09", capacity: 6, zone: "Outdoor" },
    { code: "T-10", capacity: 4, zone: "Outdoor" },
    { code: "T-11", capacity: 8, zone: "VIP" },
    { code: "T-12", capacity: 6, zone: "VIP" },
  ];
  const tables: any[] = [];
  for (const t of tableDefs) {
    const tbl = await Table.create({ outletId: outlet._id, ...t });
    tables.push(tbl);
  }

  // Categories
  const catDefs = [
    { name: "Burgers", sortOrder: 1 },
    { name: "Pizza", sortOrder: 2 },
    { name: "Biryani & Rice", sortOrder: 3 },
    { name: "Wraps & Rolls", sortOrder: 4 },
    { name: "Sides", sortOrder: 5 },
    { name: "Salads", sortOrder: 6 },
    { name: "Beverages", sortOrder: 7 },
    { name: "Desserts", sortOrder: 8 },
  ];
  const cats: Record<string, any> = {};
  for (const c of catDefs) {
    cats[c.name] = await Category.create({ outletId: outlet._id, ...c });
  }

  // Ingredients
  const ingDefs = [
    { sku: "MOZ-001", name: "Mozzarella cheese", category: "Dairy", unit: "kg", stock: 1.2, par: 5, costPerUnit: 1850, days: 4 },
    { sku: "BUN-002", name: "Burger buns", category: "Bakery", unit: "pcs", stock: 184, par: 120, costPerUnit: 28, days: 2 },
    { sku: "CHK-003", name: "Chicken breast", category: "Meat", unit: "kg", stock: 12.4, par: 15, costPerUnit: 720, days: 1 },
    { sku: "BEEF-004", name: "Beef mince", category: "Meat", unit: "kg", stock: 8.2, par: 10, costPerUnit: 1450, days: 1 },
    { sku: "PTO-005", name: "Potatoes", category: "Produce", unit: "kg", stock: 62, par: 40, costPerUnit: 90, days: 9 },
    { sku: "OIL-006", name: "Cooking oil", category: "Pantry", unit: "L", stock: 28, par: 20, costPerUnit: 580, days: 60 },
    { sku: "LET-007", name: "Lettuce", category: "Produce", unit: "kg", stock: 0, par: 5, costPerUnit: 220, days: 5 },
    { sku: "TOM-008", name: "Tomatoes", category: "Produce", unit: "kg", stock: 14, par: 10, costPerUnit: 180, days: 3 },
    { sku: "RICE-009", name: "Basmati rice", category: "Pantry", unit: "kg", stock: 48, par: 25, costPerUnit: 340, days: 180 },
    { sku: "PEP-010", name: "Pepperoni", category: "Meat", unit: "kg", stock: 2.1, par: 4, costPerUnit: 2400, days: 7 },
    { sku: "DGH-011", name: "Pizza dough", category: "Bakery", unit: "pcs", stock: 36, par: 20, costPerUnit: 80, days: 2 },
    { sku: "CHE-012", name: "Cheddar cheese", category: "Dairy", unit: "kg", stock: 3.4, par: 3, costPerUnit: 1650, days: 10 },
    { sku: "ONN-013", name: "Onions", category: "Produce", unit: "kg", stock: 28, par: 15, costPerUnit: 120, days: 15 },
    { sku: "CKL-014", name: "Coca-Cola 500ml", category: "Beverages", unit: "pcs", stock: 84, par: 40, costPerUnit: 60, days: 180 },
    { sku: "COF-015", name: "Coffee beans", category: "Pantry", unit: "kg", stock: 4.8, par: 3, costPerUnit: 2800, days: 120 },
    // Non-recipe consumables — tracked the same way as food ingredients so
    // POs, low-stock alerts, and supplier variance work for free. Categories
    // (Packaging / Disposables / Condiments / Cleaning) drive the supplies
    // picker on the order modal.
    { sku: "BOX-S-101", name: "Takeaway box (small)", category: "Packaging", unit: "pcs", stock: 480, par: 200, costPerUnit: 13, days: 365 },
    { sku: "BOX-L-102", name: "Takeaway box (large)", category: "Packaging", unit: "pcs", stock: 320, par: 150, costPerUnit: 22, days: 365 },
    { sku: "FOIL-103", name: "Foil tray", category: "Packaging", unit: "pcs", stock: 240, par: 100, costPerUnit: 18, days: 365 },
    { sku: "BAG-104", name: "Paper bag (delivery)", category: "Packaging", unit: "pcs", stock: 600, par: 250, costPerUnit: 9, days: 365 },
    { sku: "NAP-201", name: "Paper napkin", category: "Disposables", unit: "pcs", stock: 4200, par: 2000, costPerUnit: 1.5, days: 365 },
    { sku: "TIS-202", name: "Tissue paper roll", category: "Disposables", unit: "pcs", stock: 60, par: 30, costPerUnit: 95, days: 365 },
    { sku: "SPN-203", name: "Plastic spoon", category: "Disposables", unit: "pcs", stock: 1100, par: 500, costPerUnit: 2, days: 365 },
    { sku: "FRK-204", name: "Plastic fork", category: "Disposables", unit: "pcs", stock: 950, par: 500, costPerUnit: 2, days: 365 },
    { sku: "STR-205", name: "Plastic straw", category: "Disposables", unit: "pcs", stock: 1800, par: 800, costPerUnit: 1, days: 365 },
    { sku: "KET-301", name: "Ketchup sachet", category: "Condiments", unit: "pcs", stock: 2400, par: 1000, costPerUnit: 4, days: 540 },
    { sku: "MAY-302", name: "Mayo sachet", category: "Condiments", unit: "pcs", stock: 1600, par: 800, costPerUnit: 5, days: 540 },
    { sku: "CHL-303", name: "Chilli sauce sachet", category: "Condiments", unit: "pcs", stock: 1200, par: 600, costPerUnit: 5, days: 540 },
    { sku: "SLT-304", name: "Salt sachet", category: "Condiments", unit: "pcs", stock: 2000, par: 800, costPerUnit: 0.5, days: 720 },
  ];
  const ings: Record<string, any> = {};
  for (const i of ingDefs) {
    const ing = await Ingredient.create({
      outletId: outlet._id,
      sku: i.sku,
      name: i.name,
      category: i.category,
      unit: i.unit,
      stock: i.stock,
      par: i.par,
      costPerUnit: i.costPerUnit,
      expiresAt: new Date(Date.now() + i.days * 24 * 60 * 60 * 1000),
    });
    ings[i.sku] = ing;
  }

  // Menu items with recipes
  const menuDefs = [
    { name: "Zinger Burger", cat: "Burgers", price: 600, plate: 228, station: "Grill", tags: ["Bestseller", "Spicy"], sold7d: 142,
      recipe: [["BUN-002", 1], ["CHK-003", 0.15], ["LET-007", 0.02], ["TOM-008", 0.03]] },
    { name: "Beef Burger", cat: "Burgers", price: 720, plate: 298, station: "Grill", tags: ["Spicy"], sold7d: 94,
      recipe: [["BUN-002", 1], ["BEEF-004", 0.15], ["CHE-012", 0.02], ["ONN-013", 0.02]] },
    { name: "Chicken Biryani", cat: "Biryani & Rice", price: 700, plate: 364, station: "Grill", tags: [], sold7d: 96,
      recipe: [["RICE-009", 0.25], ["CHK-003", 0.18], ["ONN-013", 0.05]] },
    { name: "Pepperoni Pizza (M)", cat: "Pizza", price: 1200, plate: 540, station: "Oven", tags: ["Bestseller"], sold7d: 74,
      recipe: [["DGH-011", 1], ["MOZ-001", 0.12], ["PEP-010", 0.08], ["TOM-008", 0.05]] },
    { name: "Margherita Pizza (M)", cat: "Pizza", price: 950, plate: 380, station: "Oven", tags: ["Veg"], sold7d: 52,
      recipe: [["DGH-011", 1], ["MOZ-001", 0.12], ["TOM-008", 0.05]] },
    { name: "Loaded Fries", cat: "Sides", price: 400, plate: 116, station: "Fryer", tags: ["Veg"], sold7d: 128,
      recipe: [["PTO-005", 0.25], ["CHE-012", 0.03], ["OIL-006", 0.05]] },
    { name: "Beef Shawarma", cat: "Wraps & Rolls", price: 600, plate: 336, station: "Grill", tags: [], sold7d: 58,
      recipe: [["BEEF-004", 0.12], ["ONN-013", 0.03], ["TOM-008", 0.02]] },
    { name: "Caesar Salad", cat: "Salads", price: 550, plate: 192, station: "Cold", tags: ["Veg", "Healthy"], sold7d: 23,
      recipe: [["LET-007", 0.1], ["CHK-003", 0.08], ["CHE-012", 0.02]] },
    { name: "Cold Coffee", cat: "Beverages", price: 400, plate: 72, station: "Drinks", tags: ["Veg"], sold7d: 69,
      recipe: [["COF-015", 0.015]] },
    { name: "Mint Margarita", cat: "Beverages", price: 350, plate: 80, station: "Drinks", tags: ["Veg"], sold7d: 42,
      recipe: [] },
    { name: "Mozzarella Sticks", cat: "Sides", price: 450, plate: 180, station: "Fryer", tags: [], sold7d: 0,
      recipe: [["MOZ-001", 0.08], ["OIL-006", 0.04]] },
    { name: "Chocolate Brownie", cat: "Desserts", price: 350, plate: 90, station: "Cold", tags: ["New"], sold7d: 31,
      recipe: [] },
    { name: "Chicken Wings (6pc)", cat: "Sides", price: 550, plate: 220, station: "Fryer", tags: ["Spicy"], sold7d: 64,
      recipe: [["CHK-003", 0.35], ["OIL-006", 0.05]] },
    { name: "Veggie Wrap", cat: "Wraps & Rolls", price: 480, plate: 180, station: "Cold", tags: ["Veg"], sold7d: 28,
      recipe: [["LET-007", 0.08], ["TOM-008", 0.04], ["CHE-012", 0.02]] },
    { name: "Fish & Chips", cat: "Sides", price: 850, plate: 380, station: "Fryer", tags: [], sold7d: 18,
      recipe: [["PTO-005", 0.2], ["OIL-006", 0.1]] },
  ];
  const items: any[] = [];
  for (const m of menuDefs) {
    const recipe = (m.recipe as [string, number][]).map(([sku, qty]) => ({
      ingredientId: ings[sku]._id,
      qty,
    }));
    const item = await MenuItem.create({
      outletId: outlet._id,
      categoryId: cats[m.cat]._id,
      name: m.name,
      price: m.price,
      plateCost: m.plate,
      station: m.station,
      tags: m.tags,
      sold7d: m.sold7d,
      recipe,
      active: m.name !== "Mozzarella Sticks",
      stockStatus: m.name === "Pepperoni Pizza (M)" ? "Low" : m.name === "Mozzarella Sticks" ? "Out" : "OK",
    });
    items.push(item);
  }

  // Customers
  const custDefs = [
    { name: "Ayesha Khan", phone: "+92 300 1234567", tier: "Gold", visits: 34, ltv: 84200, fave: "Zinger Burger", points: 842 },
    { name: "Bilal Akhtar", phone: "+92 333 9876543", tier: "Silver", visits: 18, ltv: 42100, fave: "Pepperoni Pizza", points: 421 },
    { name: "Hina Rasheed", phone: "+92 321 1122334", tier: "Gold", visits: 52, ltv: 128400, fave: "Cold Coffee", points: 1284 },
    { name: "Kashif Malik", phone: "+92 345 5566778", tier: "Bronze", visits: 6, ltv: 8400, fave: "Chicken Biryani", points: 84 },
    { name: "Fatima Rauf", phone: "+92 300 2233445", tier: "Silver", visits: 22, ltv: 48900, fave: "Caesar Salad", points: 489 },
    { name: "Rehman Shah", phone: "+92 333 7788990", tier: "Gold", visits: 41, ltv: 96700, fave: "Loaded Fries", points: 967 },
    { name: "Zainab Iqbal", phone: "+92 321 4455667", tier: "Bronze", visits: 3, ltv: 4200, fave: "Beef Burger", points: 42 },
    { name: "Asad Ejaz", phone: "+92 300 9988776", tier: "Silver", visits: 15, ltv: 36400, fave: "Chicken Wings", points: 364 },
  ];
  const customers: any[] = [];
  for (const c of custDefs) {
    const cu = await Customer.create({
      outletId: outlet._id,
      ...c,
      lastVisitAt: new Date(Date.now() - Math.random() * 6 * 24 * 60 * 60 * 1000),
    });
    customers.push(cu);
  }

  // Orders — today: some active, some served/completed spread through the day
  const todayStart = new Date();
  todayStart.setHours(8, 0, 0, 0);
  const channels = ["Dine-in", "Takeaway", "Delivery"] as const;
  const waiters = staff.filter((s) => s.role === "waiter");
  let code = 1900;

  async function makeOrder(opts: {
    minutesAgo: number;
    status: "Queued" | "In Progress" | "Ready" | "Served" | "Completed";
    channel?: typeof channels[number];
    tableCode?: string;
    priority?: "Normal" | "Rush" | "VIP";
    forceItems?: { item: any; qty: number; mods?: string[]; note?: string }[];
    customer?: any;
    deliveryAddress?: string;
    deliveryNote?: string;
    cashOnDelivery?: boolean;
    rider?: any;
  }) {
    code += 1;
    const placedAt = new Date(Date.now() - opts.minutesAgo * 60 * 1000);
    const channel = opts.channel ?? rand([...channels]);
    const chosen: { item: any; qty: number; mods?: string[]; note?: string }[] =
      opts.forceItems ??
      Array.from({ length: 1 + Math.floor(Math.random() * 4) }).map(() => ({
        item: rand(items),
        qty: 1 + Math.floor(Math.random() * 2),
      }));
    const orderItems = chosen.map((c) => ({
      menuItemId: c.item._id,
      name: c.item.name,
      qty: c.qty,
      price: c.item.price,
      mods: c.mods ?? [],
      note: c.note,
      status: "Queued",
    }));
    const subtotal = orderItems.reduce((s, i) => s + i.price * i.qty, 0);
    const tax = Math.round(subtotal * 0.16);
    const service = Math.round(subtotal * 0.05);
    const total = subtotal + tax + service;
    const tableCode = channel === "Dine-in" ? opts.tableCode ?? rand(tableDefs).code : undefined;
    const tbl = tableCode ? tables.find((t) => t.code === tableCode) : null;
    const waiter = channel === "Dine-in" ? rand(waiters) : undefined;
    const order = await Order.create({
      outletId: outlet._id,
      code: `#A-${code}`,
      channel,
      tableCode,
      tableId: tbl?._id,
      customerName: opts.customer?.name ?? (channel === "Dine-in" ? "Walk-in" : rand(customers).name),
      customerPhone: opts.customer?.phone ?? (channel === "Delivery" ? "+92 300 1234000" : undefined),
      customerId: opts.customer?._id,
      waiterId: waiter?._id,
      items: orderItems,
      subtotal,
      tax,
      service,
      total,
      status: opts.status,
      paymentStatus: ["Served", "Completed"].includes(opts.status) ? "Paid" : "Pending",
      paymentMethod: ["Served", "Completed"].includes(opts.status) ? rand(["Cash", "Card", "JazzCash"] as const) : undefined,
      priority: opts.priority ?? "Normal",
      placedAt,
      acceptedAt: opts.status !== "Queued" ? new Date(placedAt.getTime() + 2 * 60 * 1000) : undefined,
      readyAt: ["Ready", "Served", "Completed"].includes(opts.status) ? new Date(placedAt.getTime() + 12 * 60 * 1000) : undefined,
      servedAt: ["Served", "Completed"].includes(opts.status) ? new Date(placedAt.getTime() + 16 * 60 * 1000) : undefined,
      closedAt: opts.status === "Completed" ? new Date(placedAt.getTime() + 45 * 60 * 1000) : undefined,
      deliveryAddress: opts.deliveryAddress,
      deliveryNote: opts.deliveryNote,
      cashOnDelivery: !!opts.cashOnDelivery,
      riderId: opts.rider?._id,
      riderName: opts.rider?.name,
      assignedAt: opts.rider ? new Date(placedAt.getTime() + 10 * 60 * 1000) : undefined,
      pickedUpAt: opts.status === "Served" ? new Date(placedAt.getTime() + 14 * 60 * 1000) : undefined,
      deliveredAt: channel === "Delivery" && opts.status === "Completed"
        ? new Date(placedAt.getTime() + 35 * 60 * 1000)
        : undefined,
      events: [{ status: opts.status, at: new Date() }],
    });
    // if dine-in active, occupy table
    if (tbl && ["In Progress", "Queued", "Ready"].includes(opts.status)) {
      tbl.status = "Occupied";
      tbl.currentOrderId = order._id;
      tbl.seatedAt = placedAt;
      tbl.guests = 2 + Math.floor(Math.random() * 3);
      tbl.waiterId = waiter?._id;
      await tbl.save();
    }
  }

  // Delivery orders in various states — ensures Delivery page is populated
  const riderUser = staff.find((u: any) => u.role === "rider");
  const dZinger = items.find((i: any) => i.name === "Zinger Burger");
  const dPizza = items.find((i: any) => i.name === "Pepperoni Pizza (M)");
  const dBiryani = items.find((i: any) => i.name === "Chicken Biryani");
  const dColdCoffee = items.find((i: any) => i.name === "Cold Coffee");

  // 1. Ready delivery, unassigned — awaiting dispatch
  await makeOrder({
    minutesAgo: 8,
    status: "Ready",
    channel: "Delivery",
    deliveryAddress: "14-A Main Boulevard, DHA Phase 5, Lahore",
    deliveryNote: "Gate code 1234 · ring twice",
    cashOnDelivery: true,
    customer: customers[0],
    forceItems: [
      { item: dZinger, qty: 2, mods: ["Extra spicy"] },
      { item: dColdCoffee, qty: 2 },
    ],
  });

  // 2. Ready delivery, assigned but not picked up — rider heading to counter
  await makeOrder({
    minutesAgo: 12,
    status: "Ready",
    channel: "Delivery",
    deliveryAddress: "Flat 3B, 22 Mall Road, Gulberg II, Lahore",
    cashOnDelivery: false,
    rider: riderUser,
    customer: customers[1],
    forceItems: [
      { item: dPizza, qty: 1 },
      { item: dColdCoffee, qty: 1 },
    ],
  });

  // 3. Served delivery = en route — picked up, heading to customer
  await makeOrder({
    minutesAgo: 22,
    status: "Served",
    channel: "Delivery",
    deliveryAddress: "House 45, Street 7, Johar Town · near Emporium Mall",
    cashOnDelivery: true,
    rider: riderUser,
    customer: customers[2],
    forceItems: [
      { item: dBiryani, qty: 3 },
      { item: dColdCoffee, qty: 2 },
    ],
  });

  // Active orders
  await makeOrder({ minutesAgo: 10, status: "In Progress", channel: "Dine-in", tableCode: "T-07", forceItems: [
    { item: items.find((i: any) => i.name === "Zinger Burger"), qty: 2, mods: ["+ Cheese", "No mayo"] },
    { item: items.find((i: any) => i.name === "Loaded Fries"), qty: 1, note: "extra spicy" },
  ] });
  await makeOrder({ minutesAgo: 4, status: "In Progress", channel: "Dine-in", tableCode: "T-12", priority: "VIP", forceItems: [
    { item: items.find((i: any) => i.name === "Pepperoni Pizza (M)"), qty: 1 },
    { item: items.find((i: any) => i.name === "Cold Coffee"), qty: 2 },
    { item: items.find((i: any) => i.name === "Chicken Wings (6pc)"), qty: 1, mods: ["BBQ sauce"] },
  ] });
  await makeOrder({ minutesAgo: 2, status: "Queued", channel: "Delivery", forceItems: [
    { item: items.find((i: any) => i.name === "Beef Shawarma"), qty: 1, mods: ["No onion"] },
  ] });
  await makeOrder({ minutesAgo: 21, status: "In Progress", channel: "Dine-in", tableCode: "T-04", priority: "Rush", forceItems: [
    { item: items.find((i: any) => i.name === "Beef Burger"), qty: 2 },
    { item: items.find((i: any) => i.name === "Chicken Biryani"), qty: 1 },
    { item: items.find((i: any) => i.name === "Mint Margarita"), qty: 1 },
  ] });
  await makeOrder({ minutesAgo: 7, status: "Ready", channel: "Takeaway", forceItems: [
    { item: items.find((i: any) => i.name === "Zinger Burger"), qty: 1 },
    { item: items.find((i: any) => i.name === "Loaded Fries"), qty: 1 },
  ] });
  await makeOrder({ minutesAgo: 1, status: "Queued", channel: "Dine-in", tableCode: "T-02", forceItems: [
    { item: items.find((i: any) => i.name === "Caesar Salad"), qty: 2 },
    { item: items.find((i: any) => i.name === "Mint Margarita"), qty: 1 },
  ] });

  // QR-placed orders awaiting receptionist review. Without these the
  // /api/orders?pending=true inbox is empty on a fresh deploy and the
  // manager's "needs review" queue looks broken.
  const burgerItem = items.find((i: any) => i.name === "Beef Burger");
  const fryItem = items.find((i: any) => i.name === "Loaded Fries");
  const colaItem = items.find((i: any) => i.name === "Cold Coffee");
  if (burgerItem && fryItem && colaItem) {
    code += 1;
    const placedAt = new Date(Date.now() - 90 * 1000);
    const t11 = tables.find((t) => t.code === "T-11");
    const pendingItems = [
      { menuItemId: burgerItem._id, name: burgerItem.name, qty: 1, price: burgerItem.price, mods: [], status: "Pending" as const },
      { menuItemId: fryItem._id, name: fryItem.name, qty: 1, price: fryItem.price, mods: [], status: "Pending" as const },
    ];
    const sub1 = pendingItems.reduce((s, i) => s + i.price * i.qty, 0);
    await Order.create({
      outletId: outlet._id,
      code: `#A-${code}`,
      channel: "Dine-in",
      tableCode: "T-11",
      tableId: t11?._id,
      customerName: "Guest at T-11",
      customerPhone: "+92 333 8000001",
      source: "customer",
      items: pendingItems,
      subtotal: sub1,
      tax: Math.round(sub1 * 0.16),
      service: Math.round(sub1 * 0.05),
      total: sub1 + Math.round(sub1 * 0.16) + Math.round(sub1 * 0.05),
      status: "Pending",
      paymentStatus: "Pending",
      placedAt,
      events: [{ status: "Pending", at: placedAt }],
    });

    // A second case: a Queued order with an item-level Pending addendum on
    // top — exercises the "items.status: Pending" branch of the inbox query.
    code += 1;
    const placedAt2 = new Date(Date.now() - 6 * 60 * 1000);
    const queued: any[] = [
      { menuItemId: burgerItem._id, name: burgerItem.name, qty: 2, price: burgerItem.price, mods: [], status: "Queued" },
      { menuItemId: colaItem._id, name: colaItem.name, qty: 2, price: colaItem.price, mods: [], status: "Queued" },
    ];
    const addendum = [
      { menuItemId: fryItem._id, name: fryItem.name, qty: 1, price: fryItem.price, mods: [], status: "Pending" as const, addendum: true, addedAt: new Date() },
    ];
    const t06 = tables.find((t) => t.code === "T-06");
    const sub2 = [...queued, ...addendum].reduce((s: number, i: any) => s + i.price * i.qty, 0);
    await Order.create({
      outletId: outlet._id,
      code: `#A-${code}`,
      channel: "Dine-in",
      tableCode: "T-06",
      tableId: t06?._id,
      customerName: "Guest at T-06",
      customerPhone: "+92 333 8000002",
      source: "customer",
      items: [...queued, ...addendum],
      subtotal: sub2,
      tax: Math.round(sub2 * 0.16),
      service: Math.round(sub2 * 0.05),
      total: sub2 + Math.round(sub2 * 0.16) + Math.round(sub2 * 0.05),
      status: "Queued",
      paymentStatus: "Pending",
      placedAt: placedAt2,
      acceptedAt: new Date(placedAt2.getTime() + 60 * 1000),
      events: [
        { status: "Queued", at: placedAt2 },
        { status: "Addendum requested (1 items)", at: new Date() },
      ],
    });
  }

  // Completed today (throughout day)
  for (let i = 0; i < 45; i++) {
    await makeOrder({ minutesAgo: 60 + i * 15, status: "Completed" });
  }

  // Previous days (for week bars + trend)
  for (let daysAgo = 1; daysAgo <= 30; daysAgo++) {
    const count = 25 + Math.floor(Math.random() * 30);
    for (let i = 0; i < count; i++) {
      const mins = daysAgo * 1440 + Math.floor(Math.random() * 1000);
      await makeOrder({ minutesAgo: mins, status: "Completed" });
    }
  }

  // Set some table statuses
  const occupied = await Order.find({
    outletId: outlet._id,
    status: { $in: ["Queued", "In Progress", "Ready"] },
    tableId: { $ne: null },
  });
  const occupiedTableIds = new Set(occupied.map((o: any) => o.tableId?.toString()));
  await Table.updateOne({ outletId: outlet._id, code: "T-05" }, { status: "Cleaning" });
  await Table.updateOne({ outletId: outlet._id, code: "T-06" }, { status: "Reserved", reservedFor: d(60) });
  await Table.updateOne({ outletId: outlet._id, code: "T-11" }, { status: "Reserved", reservedFor: d(90) });

  // Wastage logs
  const wastageDefs = [
    { item: "MOZ-001", qty: 0.35, unit: "kg", reason: "Spoiled", shift: "Lunch", staff: staff[3] },
    { item: "CHK-003", qty: 0.5, unit: "kg", reason: "Overcooked", shift: "Lunch", staff: staff[4] },
    { item: "BUN-002", qty: 6, unit: "pcs", reason: "Shift-end discard", shift: "Breakfast", staff: staff[0] },
  ];
  for (const w of wastageDefs) {
    const ing = ings[w.item];
    await Wastage.create({
      outletId: outlet._id,
      ingredientId: ing._id,
      itemName: ing.name,
      qty: w.qty,
      unit: w.unit,
      reason: w.reason,
      cost: Math.round(ing.costPerUnit * w.qty),
      shift: w.shift,
      staffId: w.staff._id,
      staffName: w.staff.name,
      approved: w.reason !== "Overcooked",
      at: new Date(Date.now() - Math.random() * 3 * 60 * 60 * 1000),
    });
  }

  // Menu-item wastage
  const zinger = items.find((i: any) => i.name === "Zinger Burger");
  await Wastage.create({
    outletId: outlet._id,
    menuItemId: zinger._id,
    itemName: "Zinger Burger",
    qty: 1,
    unit: "pc",
    reason: "Customer return",
    cost: zinger.plateCost,
    shift: "Lunch",
    staffId: staff[0]._id,
    staffName: staff[0].name,
    approved: true,
    at: new Date(Date.now() - 40 * 60 * 1000),
  });

  // Reviews
  await Review.create({ outletId: outlet._id, customerId: customers[0]._id, customerName: "Ayesha K.", rating: 5, text: "Burger was fire 🔥 and served in 14 min — fastest QSR in Gulberg.", channel: "In-app" });
  await Review.create({ outletId: outlet._id, customerId: customers[1]._id, customerName: "Bilal A.", rating: 4, text: "Good flavor, fries a bit cold on arrival.", channel: "In-app" });
  await Review.create({ outletId: outlet._id, customerName: "Anonymous", rating: 2, text: "Waited 40 mins for takeaway — nobody updated me.", channel: "In-app", recovery: true });
  await Review.create({ outletId: outlet._id, customerId: customers[2]._id, customerName: "Hina R.", rating: 5, text: "Love the loyalty program. Gold tier really pays off.", channel: "Google" });

  // Reservations
  await Reservation.create({ outletId: outlet._id, tableId: tables.find((t: any) => t.code === "T-06")!._id, customerName: "Arshad family", phone: "+92 300 1111222", party: 4, at: d(90), status: "Booked" });
  await Reservation.create({ outletId: outlet._id, tableId: tables.find((t: any) => t.code === "T-11")!._id, customerName: "Mr. Rehman", phone: "+92 333 2222333", party: 8, at: d(120), status: "Booked", depositPaid: 5000 });
  await Reservation.create({ outletId: outlet._id, customerName: "Fatima R.", phone: "+92 321 4455667", party: 2, at: d(180), status: "Booked" });

  // Expenses — a realistic sample month so the page has content on first load
  const expenseDefs: {
    category: string;
    subcategory?: string;
    description?: string;
    amount: number;
    vendor?: string;
    paymentMethod?: string;
    recurring?: boolean;
    daysAgo: number;
  }[] = [
    { category: "Rent", subcategory: "Monthly rent", amount: 180000, vendor: "M.M. Alam Property Co.", paymentMethod: "BankTransfer", recurring: true, daysAgo: 2 },
    { category: "Utilities", subcategory: "Electricity · Apr bill", amount: 42300, vendor: "LESCO", paymentMethod: "BankTransfer", recurring: true, daysAgo: 4 },
    { category: "Utilities", subcategory: "Gas · Apr bill", amount: 18450, vendor: "SNGPL", paymentMethod: "BankTransfer", recurring: true, daysAgo: 5 },
    { category: "Utilities", subcategory: "Internet · PTCL fibre", amount: 4800, vendor: "PTCL", paymentMethod: "Card", recurring: true, daysAgo: 6 },
    { category: "Staff Meals", subcategory: "Weekly staff food allowance", amount: 12000, paymentMethod: "Cash", recurring: true, daysAgo: 3 },
    { category: "Staff Meals", subcategory: "Weekly staff food allowance", amount: 12500, paymentMethod: "Cash", recurring: true, daysAgo: 10 },
    { category: "Supplies", subcategory: "Cleaning & sanitation", amount: 8600, vendor: "HyClean Supplies", paymentMethod: "Cash", daysAgo: 7 },
    { category: "Packaging", subcategory: "Takeaway boxes · 500 units", amount: 6500, vendor: "PackPro Lahore", paymentMethod: "Cash", daysAgo: 8 },
    { category: "Maintenance", subcategory: "Fryer service + part", amount: 9400, vendor: "RestoTech Repairs", paymentMethod: "Cash", daysAgo: 11 },
    { category: "Marketing", subcategory: "Instagram boosted posts", amount: 7500, vendor: "Meta Ads", paymentMethod: "Card", daysAgo: 12 },
    { category: "Transport", subcategory: "Rider fuel · weekly", amount: 5400, vendor: "Shell", paymentMethod: "Cash", recurring: true, daysAgo: 5 },
    { category: "Licenses & Insurance", subcategory: "Food safety permit renewal", amount: 15000, vendor: "PFA", paymentMethod: "BankTransfer", daysAgo: 18 },
    { category: "Other", subcategory: "Misc. supplies", description: "light bulbs, printer ink", amount: 1800, paymentMethod: "Cash", daysAgo: 14 },
  ];

  for (const e of expenseDefs) {
    await Expense.create({
      outletId: outlet._id,
      category: e.category,
      subcategory: e.subcategory,
      description: e.description,
      amount: e.amount,
      vendor: e.vendor,
      paymentMethod: e.paymentMethod ?? "Cash",
      recurring: !!e.recurring,
      approved: e.amount < 5000,
      loggedById: admin._id,
      loggedByName: admin.name,
      at: new Date(Date.now() - e.daysAgo * 24 * 60 * 60 * 1000),
    });
  }

  // ─── Promotions + combos + pricing rules ───────────────────────────────
  const twoWeeks = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  await Promotion.create([
    {
      outletId: outlet._id,
      code: "WELCOME100",
      name: "Welcome · first order",
      type: "first-order",
      value: 20,
      segment: "New",
      redemptionLimit: 0,
      validTo: twoWeeks,
      active: true,
      createdBy: admin._id,
      description: "20% off for first-time customers",
    },
    {
      outletId: outlet._id,
      code: "GOLD10",
      name: "Gold tier thank-you",
      type: "percent",
      value: 10,
      segment: "Gold",
      minBasket: 1000,
      active: true,
      createdBy: admin._id,
    },
    {
      outletId: outlet._id,
      code: "FRIDAYNIGHT",
      name: "Friday night flat",
      type: "flat",
      value: 250,
      segment: "All",
      minBasket: 1500,
      redemptionLimit: 100,
      active: true,
      createdBy: admin._id,
    },
  ]);

  // Combos — need ids from items above
  const zingerItem = items.find((i: any) => i.name === "Zinger Burger");
  const friesItem = items.find((i: any) => i.name === "Loaded Fries");
  const coldCoffeeItem = items.find((i: any) => i.name === "Cold Coffee");
  const pizzaItem = items.find((i: any) => i.name === "Pepperoni Pizza (M)");
  const burgersCat = Object.values(cats).find((c: any) => c.name === "Burgers") as any;
  const pizzaCat = Object.values(cats).find((c: any) => c.name === "Pizza") as any;
  if (zingerItem && friesItem && coldCoffeeItem && burgersCat) {
    await MenuItem.create({
      outletId: outlet._id,
      categoryId: burgersCat._id,
      name: "Zinger Combo",
      price: 900, // vs 600+400+400 = 1400
      plateCost: 0,
      station: "Grill",
      tags: ["Bestseller"],
      active: true,
      isCombo: true,
      comboItems: [
        { menuItemId: zingerItem._id, qty: 1 },
        { menuItemId: friesItem._id, qty: 1 },
        { menuItemId: coldCoffeeItem._id, qty: 1 },
      ],
    });
  }
  if (pizzaItem && coldCoffeeItem && pizzaCat) {
    await MenuItem.create({
      outletId: outlet._id,
      categoryId: pizzaCat._id,
      name: "Pizza Duo Combo",
      price: 1500, // vs 1200+400+400 = 2000
      plateCost: 0,
      station: "Oven",
      tags: ["New"],
      active: true,
      isCombo: true,
      comboItems: [
        { menuItemId: pizzaItem._id, qty: 1 },
        { menuItemId: coldCoffeeItem._id, qty: 2 },
      ],
    });
  }

  // Pricing rules
  await PricingRule.create([
    {
      outletId: outlet._id,
      name: "Weekday happy hour",
      type: "happy-hour",
      adjustmentPct: -15,
      daysOfWeek: [1, 2, 3, 4, 5], // Mon–Fri
      startTime: "16:00",
      endTime: "19:00",
      active: true,
    },
    {
      outletId: outlet._id,
      name: "Weekend surcharge",
      type: "weekend-surcharge",
      adjustmentPct: 5,
      daysOfWeek: [0, 6],
      active: false,
    },
    {
      outletId: outlet._id,
      name: "Delivery markup",
      type: "delivery-markup",
      adjustmentPct: 8,
      channel: "Delivery",
      active: true,
    },
  ]);

  // Anomaly detection — seed rules + visible events so Reports is populated.
  await AnomalyRule.create([
    {
      outletId: outlet._id,
      name: "Revenue drop vs same-weekday avg",
      metric: "revenue",
      compareTo: "same-weekday",
      deviationPct: 20,
      severity: "warn",
    },
    {
      outletId: outlet._id,
      name: "Order volume crash",
      metric: "order-volume",
      compareTo: "same-weekday",
      deviationPct: 30,
      severity: "error",
    },
    {
      outletId: outlet._id,
      name: "Revenue surge (trailing 7d)",
      metric: "revenue",
      compareTo: "trailing-7d",
      deviationPct: 30,
      severity: "info",
    },
  ]);
  await AnomalyEvent.create([
    {
      outletId: outlet._id,
      title: "Revenue 22% below Wednesday avg",
      body: "Today: Rs 98,400 · baseline: Rs 126,150 across last 3 Wednesdays",
      severity: "warn",
      metric: "revenue",
      observed: 98400,
      baseline: 126150,
      deviationPct: -22,
      detectedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      link: "/reports",
    },
    {
      outletId: outlet._id,
      title: "Delivery fail-rate spike",
      body: "Failures 9% today · baseline 2% over last 7 days",
      severity: "error",
      metric: "delivery-fail-rate",
      observed: 9,
      baseline: 2,
      deviationPct: 350,
      detectedAt: new Date(Date.now() - 30 * 60 * 1000),
      link: "/delivery",
    },
    {
      outletId: outlet._id,
      title: "Order volume +35% vs 7-day avg",
      body: "Peaks on Fri/Sat · capacity watch",
      severity: "info",
      metric: "order-volume",
      observed: 412,
      baseline: 305,
      deviationPct: 35,
      detectedAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
      link: "/reports",
    },
  ]);

  // Notification templates
  await NotificationTemplate.create([
    {
      outletId: outlet._id,
      name: "Order ready (SMS)",
      channel: "SMS",
      event: "order.ready",
      body: "Hey {{customerName}}, your Dinova order {{orderCode}} is ready! 🎉",
      active: true,
    },
    {
      outletId: outlet._id,
      name: "Order delivered (WhatsApp)",
      channel: "WhatsApp",
      event: "order.delivered",
      body: "{{customerName}}, your order {{orderCode}} has been delivered. Enjoy! Rate us: dinova.dev/r/{{orderCode}}",
      active: true,
    },
    {
      outletId: outlet._id,
      name: "Digital receipt",
      channel: "Email",
      event: "order.confirmed",
      subject: "Your Dinova receipt · {{orderCode}}",
      body: "Thanks for dining with us, {{customerName}}.\n\nOrder {{orderCode}}\nTotal: {{total}}\n\nWe hope to see you soon.",
      active: true,
    },
    {
      outletId: outlet._id,
      name: "Review ask",
      channel: "WhatsApp",
      event: "review.request",
      body: "{{customerName}}, thanks for visiting Dinova today! We'd love your feedback — just tap: dinova.dev/r/{{orderCode}} 🙏",
      active: true,
    },
  ]);

  // Sample audit log entries so the Settings page has content
  await AuditLog.create([
    {
      outletId: outlet._id,
      userId: admin._id,
      userName: admin.name,
      action: "outlet.update",
      targetType: "Outlet",
      targetId: String(outlet._id),
      before: { taxRate: 0.15 },
      after: { taxRate: 0.16 },
      at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    },
    {
      outletId: outlet._id,
      userId: admin._id,
      userName: admin.name,
      action: "promotion.create",
      targetType: "Promotion",
      targetId: "seed",
      after: { code: "WELCOME100", type: "first-order", value: 20 },
      at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    },
    {
      outletId: outlet._id,
      userId: admin._id,
      userName: admin.name,
      action: "user.role.change",
      targetType: "User",
      before: { role: "waiter" },
      after: { role: "receptionist" },
      at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    },
  ]);

  console.log("[seed] done. admin login: admin@dinova.dev / admin123");
}

if (require.main === module) {
  (async () => {
    const { connectDB, disconnectDB } = await import("../config/db");
    await connectDB();
    await maybeSeed();
    await disconnectDB();
    process.exit(0);
  })();
}
