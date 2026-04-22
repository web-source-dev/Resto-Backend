import { Router } from "express";
import { Order } from "../models/Order";
import { MenuItem } from "../models/MenuItem";
import { Customer } from "../models/Customer";
import { User } from "../models/User";
import { Ingredient } from "../models/Ingredient";
import { Table } from "../models/Table";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest } from "../middleware/auth";

const r = Router();
r.use(authMiddleware);

function esc(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

r.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) return res.json({ results: [] });
    const rx = new RegExp(esc(q), "i");
    const limit = 6;
    const outletId = req.outletId;

    const [orders, items, customers, staff, ingredients, tables] = await Promise.all([
      Order.find({
        outletId,
        $or: [{ code: rx }, { customerName: rx }, { tableCode: rx }],
      })
        .sort({ placedAt: -1 })
        .limit(limit),
      MenuItem.find({ outletId, name: rx }).limit(limit),
      Customer.find({ outletId, $or: [{ name: rx }, { phone: rx }] }).limit(limit),
      User.find({ outletId, $or: [{ name: rx }, { email: rx }] }).limit(limit),
      Ingredient.find({ outletId, $or: [{ name: rx }, { sku: rx }] }).limit(limit),
      Table.find({ outletId, code: rx }).limit(limit),
    ]);

    const results = [
      ...orders.map((o: any) => ({
        type: "Order",
        id: o.id,
        title: o.code,
        sub: `${o.channel} · ${o.status} · Rs ${o.total}`,
        link: "/orders",
      })),
      ...items.map((i: any) => ({
        type: "Menu",
        id: i.id,
        title: i.name,
        sub: `Rs ${i.price} · ${i.active ? "active" : "inactive"}`,
        link: "/menu",
      })),
      ...customers.map((c: any) => ({
        type: "Customer",
        id: c.id,
        title: c.name,
        sub: `${c.tier} · ${c.phone ?? "no phone"}`,
        link: "/customers",
      })),
      ...staff.map((u: any) => ({
        type: "Staff",
        id: u.id,
        title: u.name,
        sub: `${u.role} · ${u.email}`,
        link: "/staff",
      })),
      ...ingredients.map((i: any) => ({
        type: "Ingredient",
        id: i.id,
        title: i.name,
        sub: `${i.stock} ${i.unit} · par ${i.par}`,
        link: "/inventory",
      })),
      ...tables.map((t: any) => ({
        type: "Table",
        id: t.id,
        title: t.code,
        sub: `${t.zone} · ${t.status}`,
        link: "/tables",
      })),
    ];

    res.json({ results });
  })
);

export default r;
