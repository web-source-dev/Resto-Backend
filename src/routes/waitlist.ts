import { Router } from "express";
import { Waitlist } from "../models/Waitlist";
import { Table } from "../models/Table";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, requireRole } from "../middleware/auth";
import { emit } from "../sockets";
import { notify } from "../services/notify";

const r = Router();
r.use(authMiddleware);
const canManage = requireRole("admin", "manager", "receptionist", "waiter");

r.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const q: any = { outletId: req.outletId };
    if (req.query.status) q.status = req.query.status;
    else q.status = "Waiting";
    const items = await Waitlist.find(q).sort({ requestedAt: 1 }).limit(50);
    res.json({ items });
  })
);

r.post(
  "/",
  canManage,
  asyncHandler(async (req: AuthedRequest, res) => {
    const {
      customerName,
      phone,
      party,
      quotedMinutes,
      note,
    } = req.body;
    if (!customerName)
      return res.status(400).json({ error: "customerName required" });
    const item = await Waitlist.create({
      outletId: req.outletId,
      customerName,
      phone,
      party: Number(party) || 2,
      quotedMinutes: quotedMinutes ? Number(quotedMinutes) : undefined,
      note,
    });
    emit("table:update", { waitlist: true }, req.outletId);
    res.status(201).json({ item });
  })
);

r.post(
  "/:id/notify",
  canManage,
  asyncHandler(async (req: AuthedRequest, res) => {
    const w = await Waitlist.findOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    if (!w) return res.status(404).json({ error: "Not found" });
    w.notifiedAt = new Date();
    await w.save();
    // Mock SMS via the notifications feed so FOH can see it went out
    await notify({
      outletId: req.outletId!,
      type: "system",
      level: "info",
      title: `SMS sent · ${w.customerName}`,
      body: `"Your table at FlavorFlow is almost ready — party of ${w.party}"`,
      link: "/tables",
      targetRoles: ["admin", "manager", "receptionist", "waiter"],
    });
    res.json({ item: w });
  })
);

r.post(
  "/:id/seat",
  canManage,
  asyncHandler(async (req: AuthedRequest, res) => {
    const w = await Waitlist.findOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    if (!w) return res.status(404).json({ error: "Not found" });
    const tableId = req.body.tableId;
    if (!tableId) return res.status(400).json({ error: "tableId required" });
    const table = await Table.findOne({
      _id: tableId,
      outletId: req.outletId,
    });
    if (!table) return res.status(404).json({ error: "Table not found" });
    if (table.status !== "Free")
      return res.status(409).json({ error: `Table is ${table.status}` });
    table.status = "Occupied";
    table.guests = w.party;
    table.seatedAt = new Date();
    await table.save();
    w.status = "Seated";
    w.seatedAt = new Date();
    w.tableId = table._id;
    w.tableCode = table.code;
    await w.save();
    emit("table:update", { id: table._id.toString() }, req.outletId);
    res.json({ item: w, table });
  })
);

r.post(
  "/:id/cancel",
  canManage,
  asyncHandler(async (req: AuthedRequest, res) => {
    const w = await Waitlist.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      { status: req.body.left ? "Left" : "Cancelled" },
      { new: true }
    );
    if (!w) return res.status(404).json({ error: "Not found" });
    res.json({ item: w });
  })
);

export default r;
