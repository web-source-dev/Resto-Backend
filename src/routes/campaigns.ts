import { Router } from "express";
import { Campaign } from "../models/Campaign";
import { Customer } from "../models/Customer";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, requireRole } from "../middleware/auth";
import { notify } from "../services/notify";

const r = Router();
r.use(authMiddleware);
const canWrite = requireRole("admin", "manager");

r.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const items = await Campaign.find({ outletId: req.outletId })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ items });
  })
);

r.post(
  "/",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { name, channel, segment, message, send } = req.body;
    const filter: any = { outletId: req.outletId };
    if (segment && segment !== "All") {
      if (["Gold", "Silver", "Bronze"].includes(segment)) filter.tier = segment;
      else if (segment === "New") filter.visits = { $lte: 3 };
      else if (segment === "Lapsed")
        filter.lastVisitAt = {
          $lte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        };
    }
    const count = await Customer.countDocuments(filter);
    const doc = await Campaign.create({
      outletId: req.outletId,
      name,
      channel,
      segment: segment ?? "All",
      message,
      status: send ? "Sent" : "Draft",
      sentAt: send ? new Date() : undefined,
      sentCount: send ? count : undefined,
      createdBy: (req.user as any)?._id,
    });
    if (send) {
      await notify({
        outletId: req.outletId!,
        type: "campaign.sent",
        level: "success",
        title: `Campaign "${name}" sent`,
        body: `${count} ${segment ?? "All"} customers reached via ${channel}`,
        link: "/customers",
        targetRoles: ["admin", "manager"],
      });
    }
    res.status(201).json({ campaign: doc, reach: count });
  })
);

r.get(
  "/segments",
  asyncHandler(async (req: AuthedRequest, res) => {
    const outletId = req.outletId;
    const [total, gold, silver, bronze, newC, lapsed] = await Promise.all([
      Customer.countDocuments({ outletId }),
      Customer.countDocuments({ outletId, tier: "Gold" }),
      Customer.countDocuments({ outletId, tier: "Silver" }),
      Customer.countDocuments({ outletId, tier: "Bronze" }),
      Customer.countDocuments({ outletId, visits: { $lte: 3 } }),
      Customer.countDocuments({
        outletId,
        lastVisitAt: { $lte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      }),
    ]);
    res.json({ total, gold, silver, bronze, new: newC, lapsed });
  })
);

export default r;
