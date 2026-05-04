import { Router } from "express";
import { AnomalyEvent } from "../models/AnomalyEvent";
import { AnomalyRule } from "../models/AnomalyRule";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, requireRole, excludeRoles } from "../middleware/auth";
import { detectAnomalies } from "../services/anomalyDetector";

const r = Router();
r.use(authMiddleware);
// Block riders from this resource — not relevant to delivery work and may
// contain PII or operational data they shouldn't see.
r.use(excludeRoles("rider"));
const canManage = requireRole("admin", "manager");

r.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const q: any = { outletId: req.outletId };
    if (req.query.open === "true") q.resolved = false;
    const items = await AnomalyEvent.find(q)
      .sort({ detectedAt: -1 })
      .limit(Number(req.query.limit ?? 30));
    res.json({ items });
  })
);

r.post(
  "/:id/resolve",
  canManage,
  asyncHandler(async (req: AuthedRequest, res) => {
    const item = await AnomalyEvent.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      {
        resolved: true,
        resolvedAt: new Date(),
        resolvedByUserId: (req.user as any)?._id,
      },
      { new: true }
    );
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json({ item });
  })
);

r.post(
  "/detect",
  canManage,
  asyncHandler(async (req: AuthedRequest, res) => {
    const result = await detectAnomalies(req.outletId);
    res.json(result);
  })
);

r.get(
  "/rules",
  asyncHandler(async (req: AuthedRequest, res) => {
    const items = await AnomalyRule.find({ outletId: req.outletId });
    res.json({ items });
  })
);

r.post(
  "/rules",
  canManage,
  asyncHandler(async (req: AuthedRequest, res) => {
    const item = await AnomalyRule.create({
      outletId: req.outletId,
      ...req.body,
    });
    res.status(201).json({ item });
  })
);

r.patch(
  "/rules/:id",
  canManage,
  asyncHandler(async (req: AuthedRequest, res) => {
    const item = await AnomalyRule.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      req.body,
      { new: true }
    );
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json({ item });
  })
);

r.delete(
  "/rules/:id",
  canManage,
  asyncHandler(async (req: AuthedRequest, res) => {
    await AnomalyRule.deleteOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    res.json({ ok: true });
  })
);

export default r;
