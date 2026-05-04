import { Router } from "express";
import { Table } from "../models/Table";
import { Reservation } from "../models/Reservation";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, requireRole } from "../middleware/auth";
import { emit } from "../sockets";
import { closeTableSession } from "../services/orderService";

const canFree = requireRole("admin", "manager", "receptionist", "waiter");
const canManageTables = requireRole("admin", "manager", "receptionist");

const r = Router();
r.use(authMiddleware);

r.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tables = await Table.find({ outletId: req.outletId }).sort({ code: 1 });
    res.json({ tables });
  })
);

r.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const t = await Table.create({ outletId: req.outletId, ...req.body });
    emit("table:update", { id: t._id.toString() }, req.outletId);
    res.status(201).json({ table: t });
  })
);

r.patch(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const t = await Table.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      req.body,
      { new: true }
    );
    if (!t) return res.status(404).json({ error: "Not found" });
    emit("table:update", { id: t._id.toString() }, req.outletId);
    res.json({ table: t });
  })
);

r.delete(
  "/:id",
  canManageTables,
  asyncHandler(async (req: AuthedRequest, res) => {
    const t = await Table.findOne({ _id: req.params.id, outletId: req.outletId });
    if (!t) return res.status(404).json({ error: "Not found" });
    if (t.status !== "Free") {
      return res
        .status(400)
        .json({ error: "Only Free tables can be removed. Free it first." });
    }
    await t.deleteOne();
    emit("table:update", { id: req.params.id, deleted: true }, req.outletId);
    res.json({ ok: true });
  })
);

r.post(
  "/:id/status",
  asyncHandler(async (req: AuthedRequest, res) => {
    // Transitioning to Free should also end the customer's session — that
    // guarantees the next QR scan starts a fresh slate.
    if (req.body.status === "Free") {
      const t = await Table.findOne({
        _id: req.params.id,
        outletId: req.outletId,
      });
      if (!t) return res.status(404).json({ error: "Not found" });
      await closeTableSession(t._id.toString(), req.outletId!);
      const fresh = await Table.findById(req.params.id);
      return res.json({ table: fresh });
    }
    const t = await Table.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      { status: req.body.status },
      { new: true }
    );
    if (!t) return res.status(404).json({ error: "Not found" });
    emit("table:update", { id: t._id.toString() }, req.outletId);
    res.json({ table: t });
  })
);

// Explicit "end session" — closes any open orders at this table (marks them
// sessionClosed so they stop haunting customer-facing lookups) and marks the
// table Free. Used by receptionist when a guest leaves without reviewing.
r.post(
  "/:id/free",
  canFree,
  asyncHandler(async (req: AuthedRequest, res) => {
    const t = await Table.findOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    if (!t) return res.status(404).json({ error: "Not found" });
    await closeTableSession(t._id.toString(), req.outletId!);
    const fresh = await Table.findById(req.params.id);
    res.json({ table: fresh, ok: true });
  })
);

r.get(
  "/reservations/upcoming",
  asyncHandler(async (req: AuthedRequest, res) => {
    const reservations = await Reservation.find({
      outletId: req.outletId,
      status: "Booked",
      at: { $gte: new Date() },
    })
      .sort({ at: 1 })
      .limit(20);
    res.json({ reservations });
  })
);

r.post(
  "/reservations",
  asyncHandler(async (req: AuthedRequest, res) => {
    const reservation = await Reservation.create({
      outletId: req.outletId,
      ...req.body,
    });
    res.status(201).json({ reservation });
  })
);

export default r;
