import { Router } from "express";
import { AuditLog } from "../models/AuditLog";
import { User } from "../models/User";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, requireRole } from "../middleware/auth";
import { paginated } from "../utils/paginate";

const r = Router();
r.use(authMiddleware);

// Activity log is admin-only — gives the owner a single pane to see
// everything staff did (cancels, voids, stock adjustments, menu edits...).
const adminOnly = requireRole("admin");

r.get(
  "/",
  adminOnly,
  asyncHandler(async (req: AuthedRequest, res) => {
    const q: any = { outletId: req.outletId };
    // Filter by exact action ("order.item.cancel") or by prefix ("order.").
    if (req.query.action) {
      const a = String(req.query.action);
      if (a.endsWith(".")) q.action = { $regex: `^${a}` };
      else q.action = a;
    }
    if (req.query.userId) q.userId = req.query.userId;
    if (req.query.targetType) q.targetType = req.query.targetType;
    if (req.query.targetId) q.targetId = req.query.targetId;
    if (req.query.from || req.query.to) {
      q.at = {} as any;
      if (req.query.from) (q.at as any).$gte = new Date(String(req.query.from));
      if (req.query.to) (q.at as any).$lte = new Date(String(req.query.to));
    }
    const result = await paginated(AuditLog, q, {
      sort: { at: -1 },
      limit: Number(req.query.limit ?? 200),
      skip: Number(req.query.skip ?? 0),
    });
    res.json(result);
  })
);

// Distinct action prefixes for filter UI.
r.get(
  "/actions",
  adminOnly,
  asyncHandler(async (req: AuthedRequest, res) => {
    const actions = await AuditLog.distinct("action", { outletId: req.outletId });
    res.json({ actions: actions.sort() });
  })
);

// Distinct staff users that have appeared in the log, for filter UI.
r.get(
  "/users",
  adminOnly,
  asyncHandler(async (req: AuthedRequest, res) => {
    const ids = await AuditLog.distinct("userId", { outletId: req.outletId });
    const users = await User.find({ _id: { $in: ids } }).select("name role");
    res.json({
      users: users.map((u: any) => ({
        id: String(u._id),
        name: u.name,
        role: u.role,
      })),
    });
  })
);

export default r;
