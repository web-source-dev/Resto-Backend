import { Router } from "express";
import { Supplier } from "../models/Supplier";
import { PurchaseOrder } from "../models/PurchaseOrder";
import { Ingredient } from "../models/Ingredient";
import { GoodsReceived } from "../models/GoodsReceived";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, requireRole } from "../middleware/auth";
import { emit } from "../sockets";
import { notify } from "../services/notify";

const r = Router();
r.use(authMiddleware);
const canWrite = requireRole("admin", "manager");

r.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const items = await Supplier.find({ outletId: req.outletId }).sort({ name: 1 });
    res.json({ suppliers: items });
  })
);

r.post(
  "/",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const s = await Supplier.create({ outletId: req.outletId, ...req.body });
    res.status(201).json({ supplier: s });
  })
);

let poCounter = 2050;
async function nextPOCode() {
  const last = await PurchaseOrder.findOne().sort({ createdAt: -1 }).select("code");
  if (last?.code) {
    const n = parseInt(last.code.replace(/[^0-9]/g, ""), 10);
    if (!isNaN(n)) poCounter = Math.max(poCounter, n);
  }
  poCounter += 1;
  return `PO-${poCounter}`;
}

r.get(
  "/po",
  asyncHandler(async (req: AuthedRequest, res) => {
    const pos = await PurchaseOrder.find({ outletId: req.outletId })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ pos });
  })
);

r.post(
  "/po",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { supplierId, supplierName, lines, expectedAt, note } = req.body;
    const normalized = (lines ?? []).map((l: any) => ({
      ingredientId: l.ingredientId,
      name: l.name,
      qty: Number(l.qty),
      unit: l.unit,
      costPerUnit: Number(l.costPerUnit ?? 0),
      lineTotal: Math.round(Number(l.qty ?? 0) * Number(l.costPerUnit ?? 0)),
    }));
    const total = normalized.reduce((s: number, l: any) => s + (l.lineTotal ?? 0), 0);
    const code = await nextPOCode();
    const po = await PurchaseOrder.create({
      outletId: req.outletId,
      code,
      supplierId,
      supplierName,
      lines: normalized,
      total,
      status: "Sent",
      expectedAt,
      note,
      createdBy: (req.user as any)?._id,
    });
    res.status(201).json({ po });
  })
);

// Full GRN receive flow — accept a `receivedLines[]` payload with per-line
// received quantities and actual prices; computes variance + supplier
// performance metrics.
r.post(
  "/po/:id/receive",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const po = await PurchaseOrder.findOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    if (!po) return res.status(404).json({ error: "Not found" });

    const incoming: any[] = req.body.receivedLines ?? [];
    const grnLines: any[] = [];
    let totalQtyVar = 0;
    let totalPriceVar = 0;

    for (let i = 0; i < po.lines.length; i++) {
      const l: any = po.lines[i];
      const match =
        incoming.find(
          (x) => x.ingredientId && String(x.ingredientId) === String(l.ingredientId)
        ) ?? incoming[i] ?? {};
      const receivedQty = Number(match.receivedQty ?? l.qty ?? 0);
      const priceActual = Number(match.priceActual ?? l.costPerUnit ?? 0);
      const qtyVariance = receivedQty - (l.qty ?? 0);
      const priceVariance =
        (priceActual - (l.costPerUnit ?? 0)) * receivedQty;
      totalQtyVar += qtyVariance;
      totalPriceVar += priceVariance;
      grnLines.push({
        ingredientId: l.ingredientId,
        name: l.name,
        orderedQty: l.qty,
        receivedQty,
        unit: l.unit,
        priceOrdered: l.costPerUnit,
        priceActual,
        qtyVariance,
        priceVariance,
        qualityNotes: match.qualityNotes,
      });
      if (l.ingredientId && receivedQty > 0) {
        await Ingredient.updateOne(
          { _id: l.ingredientId },
          { $inc: { stock: receivedQty } }
        );
      }
    }

    const now = new Date();
    const onTime = po.expectedAt ? now <= po.expectedAt : true;
    const daysLate = po.expectedAt
      ? Math.max(
          0,
          Math.floor((now.getTime() - po.expectedAt.getTime()) / 86400000)
        )
      : 0;

    const grn = await GoodsReceived.create({
      outletId: req.outletId,
      poId: po._id,
      poCode: po.code,
      supplierId: po.supplierId,
      supplierName: po.supplierName,
      lines: grnLines,
      totalQtyVariance: totalQtyVar,
      totalPriceVariance: totalPriceVar,
      onTime,
      daysLate,
      receivedByUserId: (req.user as any)?._id,
      receivedByName: (req.user as any)?.name,
      receivedAt: now,
      note: req.body.note,
    });

    // Any line short of ordered qty = partial; else fully received
    const anyShort = grnLines.some((l) => l.receivedQty < (l.orderedQty ?? 0));
    po.status = anyShort ? "Partially Received" : "Received";
    po.receivedAt = now;
    await po.save();

    emit("inventory:update", {}, req.outletId);

    // Notify on variances
    const variancePct = po.total
      ? Math.abs(totalPriceVar / po.total) * 100
      : 0;
    if (Math.abs(totalQtyVar) > 0 || variancePct > 5 || !onTime) {
      await notify({
        outletId: req.outletId!,
        type: "inventory.low",
        level: "warn",
        title: `${po.code} variance · ${po.supplierName ?? "supplier"}`,
        body: `qty Δ ${totalQtyVar >= 0 ? "+" : ""}${totalQtyVar.toFixed(
          2
        )} · price Δ Rs ${Math.round(totalPriceVar).toLocaleString()}${
          !onTime ? ` · ${daysLate}d late` : ""
        }`,
        link: "/inventory",
        targetRoles: ["admin", "manager"],
      });
    }

    res.json({ po, grn });
  })
);

// Supplier performance: on-time %, price variance %, deliveries last 90 days.
r.get(
  "/:id/performance",
  asyncHandler(async (req: AuthedRequest, res) => {
    const supplier = await Supplier.findOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    if (!supplier) return res.status(404).json({ error: "Not found" });
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const grns = await GoodsReceived.find({
      outletId: req.outletId,
      supplierId: supplier._id,
      receivedAt: { $gte: since },
    }).sort({ receivedAt: -1 });
    const total = grns.length;
    const onTime = grns.filter((g) => g.onTime).length;
    const avgPriceVarPct = total
      ? Math.round(
          (grns.reduce((s, g) => s + (g.totalPriceVariance ?? 0), 0) /
            total /
            1000) * 100
        ) / 100
      : 0;
    res.json({
      supplier,
      deliveries: total,
      onTimePct: total ? Math.round((onTime / total) * 100) : 0,
      priceVariancePct: avgPriceVarPct,
      recent: grns.slice(0, 10),
    });
  })
);

r.get(
  "/grns",
  asyncHandler(async (req: AuthedRequest, res) => {
    const grns = await GoodsReceived.find({ outletId: req.outletId })
      .sort({ receivedAt: -1 })
      .limit(50);
    res.json({ grns });
  })
);

export default r;
