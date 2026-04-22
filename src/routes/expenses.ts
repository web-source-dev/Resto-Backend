import { Router } from "express";
import { Expense, EXPENSE_CATEGORIES } from "../models/Expense";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, requireRole } from "../middleware/auth";
import { notify } from "../services/notify";

const r = Router();
r.use(authMiddleware);

// Managers and receptionists can log everyday expenses; only
// admin/manager can approve large ones and hit the summary endpoints.
const canLog = requireRole("admin", "manager", "receptionist");
const canManage = requireRole("admin", "manager");

// Auto-approve threshold — spends above this need a manager.
const AUTO_APPROVE_BELOW = 5000;

r.get(
  "/categories",
  asyncHandler(async (_req: AuthedRequest, res) => {
    res.json({ categories: EXPENSE_CATEGORIES });
  })
);

r.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const q: any = { outletId: req.outletId };
    if (req.query.category) q.category = req.query.category;
    if (req.query.from || req.query.to) {
      q.at = {};
      if (req.query.from) (q.at as any).$gte = new Date(String(req.query.from));
      if (req.query.to) (q.at as any).$lte = new Date(String(req.query.to));
    }
    const items = await Expense.find(q)
      .sort({ at: -1 })
      .limit(Number(req.query.limit ?? 100));
    res.json({ items });
  })
);

r.post(
  "/",
  canLog,
  asyncHandler(async (req: AuthedRequest, res) => {
    const {
      category,
      subcategory,
      description,
      amount,
      paymentMethod,
      vendor,
      receiptUrl,
      recurring,
      at,
    } = req.body;
    if (!category || !amount)
      return res.status(400).json({ error: "category + amount required" });
    const amt = Number(amount);
    const approved = amt < AUTO_APPROVE_BELOW;
    const item = await Expense.create({
      outletId: req.outletId,
      category,
      subcategory,
      description,
      amount: amt,
      paymentMethod: paymentMethod ?? "Cash",
      vendor,
      receiptUrl,
      recurring: !!recurring,
      approved,
      loggedById: (req.user as any)?._id,
      loggedByName: (req.user as any)?.name,
      at: at ? new Date(at) : new Date(),
    });
    await notify({
      outletId: req.outletId!,
      type: "expense.new",
      level: approved ? "info" : "warn",
      title: approved
        ? `Expense logged · ${category}`
        : `Expense needs approval · ${category}`,
      body: `Rs ${amt.toLocaleString()}${
        subcategory ? ` · ${subcategory}` : ""
      }${vendor ? ` · ${vendor}` : ""}${
        (req.user as any)?.name ? ` · by ${(req.user as any).name}` : ""
      }`,
      link: "/expenses",
      targetRoles: ["admin", "manager"],
    });
    res.status(201).json({ item });
  })
);

r.patch(
  "/:id",
  canManage,
  asyncHandler(async (req: AuthedRequest, res) => {
    const item = await Expense.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      req.body,
      { new: true }
    );
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json({ item });
  })
);

r.post(
  "/:id/approve",
  canManage,
  asyncHandler(async (req: AuthedRequest, res) => {
    const item = await Expense.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      { approved: true },
      { new: true }
    );
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json({ item });
  })
);

r.delete(
  "/:id",
  canManage,
  asyncHandler(async (req: AuthedRequest, res) => {
    await Expense.deleteOne({ _id: req.params.id, outletId: req.outletId });
    res.json({ ok: true });
  })
);

r.get(
  "/summary",
  asyncHandler(async (req: AuthedRequest, res) => {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const items = await Expense.find({
      outletId: req.outletId,
      at: { $gte: since },
    });
    let today = 0;
    let month = 0;
    let thirty = 0;
    let pending = 0;
    const byCategory: Record<string, { count: number; amount: number }> = {};
    for (const e of items) {
      thirty += e.amount ?? 0;
      if (e.at >= todayStart) today += e.amount ?? 0;
      if (e.at >= monthStart) month += e.amount ?? 0;
      if (!e.approved) pending += 1;
      byCategory[e.category] ??= { count: 0, amount: 0 };
      byCategory[e.category].count += 1;
      byCategory[e.category].amount += e.amount ?? 0;
    }
    res.json({ today, month, thirty, pending, byCategory });
  })
);

export default r;
