import { Router } from "express";
import { Customer } from "../models/Customer";
import { Review } from "../models/Review";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, excludeRoles } from "../middleware/auth";

const r = Router();
r.use(authMiddleware);
// Customers carry phone/email PII — riders never need this; their delivery
// already has the customer name + phone denormalised onto the order.
r.use(excludeRoles("rider"));

r.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const customers = await Customer.find({ outletId: req.outletId })
      .sort({ ltv: -1 })
      .limit(Number(req.query.limit ?? 100));
    res.json({ customers });
  })
);

// Staff-side lookup: receptionist types a phone and gets the matched customer
// so they can prefill name/email + show a loyalty chip in the UI.
r.get(
  "/suggest",
  asyncHandler(async (req: AuthedRequest, res) => {
    const q = String(req.query.q ?? "").trim();
    const field = String(req.query.field ?? "name") as "name" | "phone" | "email";
    if (q.length < 2) return res.json({ suggestions: [] });

    const allowed = new Set(["name", "phone", "email"]);
    const safeField = allowed.has(field) ? field : "name";
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

    const customers = await Customer.find({
      outletId: req.outletId,
      [safeField]: re,
    })
      .sort({ updatedAt: -1 })
      .limit(8)
      .select("name phone email");

    const suggestions = customers
      .map((c: any) => ({
        name: c.name ?? "",
        phone: c.phone ?? "",
        email: c.email ?? "",
      }))
      .filter((s) => s[safeField]);

    res.json({ suggestions });
  })
);

r.get(
  "/lookup",
  asyncHandler(async (req: AuthedRequest, res) => {
    const phone = String(req.query.phone ?? "").trim();
    const email = String(req.query.email ?? "").trim().toLowerCase();
    if (!phone && !email)
      return res.json({ customer: null });
    const q: any = { outletId: req.outletId };
    if (phone) q.phone = phone;
    else q.email = email;
    const customer = await Customer.findOne(q);
    res.json({ customer });
  })
);

r.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const c = await Customer.create({ outletId: req.outletId, ...req.body });
    res.status(201).json({ customer: c });
  })
);

r.patch(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const c = await Customer.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      req.body,
      { new: true }
    );
    if (!c) return res.status(404).json({ error: "Not found" });
    res.json({ customer: c });
  })
);

r.get(
  "/reviews",
  asyncHandler(async (req: AuthedRequest, res) => {
    const reviews = await Review.find({ outletId: req.outletId })
      .sort({ createdAt: -1 })
      .limit(Number(req.query.limit ?? 50));
    res.json({ reviews });
  })
);

r.post(
  "/reviews",
  asyncHandler(async (req: AuthedRequest, res) => {
    const rev = await Review.create({
      outletId: req.outletId,
      ...req.body,
      recovery: Number(req.body.rating ?? 5) <= 3,
    });
    res.status(201).json({ review: rev });
  })
);

r.post(
  "/reviews/:id/resolve",
  asyncHandler(async (req: AuthedRequest, res) => {
    const rev = await Review.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      { resolved: true },
      { new: true }
    );
    res.json({ review: rev });
  })
);

r.get(
  "/summary",
  asyncHandler(async (req: AuthedRequest, res) => {
    const total = await Customer.countDocuments({ outletId: req.outletId });
    const reviews = await Review.find({ outletId: req.outletId });
    const avg = reviews.length
      ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length
      : 0;
    const pointsAgg = await Customer.aggregate([
      { $match: { outletId: (req.user as any).outletId } },
      { $group: { _id: null, points: { $sum: "$points" } } },
    ]);
    res.json({
      total,
      avgRating: Number(avg.toFixed(2)),
      reviews: reviews.length,
      pointsIssued: pointsAgg[0]?.points ?? 0,
    });
  })
);

export default r;
