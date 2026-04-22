import { AnomalyRule } from "../models/AnomalyRule";
import { AnomalyEvent } from "../models/AnomalyEvent";
import { Order } from "../models/Order";
import { notify } from "./notify";
import mongoose from "mongoose";

type MetricResult = { observed: number; baseline: number; detail?: string };

function dayBounds(d: Date) {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

async function revenueForDay(outletId: any, d: Date): Promise<number> {
  const { start, end } = dayBounds(d);
  const orders = await Order.find({
    outletId,
    placedAt: { $gte: start, $lt: end },
    status: { $ne: "Cancelled" },
  });
  return orders.reduce((s, o) => s + (o.total ?? 0), 0);
}

async function orderCountForDay(outletId: any, d: Date): Promise<number> {
  const { start, end } = dayBounds(d);
  return Order.countDocuments({
    outletId,
    placedAt: { $gte: start, $lt: end },
    status: { $ne: "Cancelled" },
  });
}

// Pick the baseline date set based on rule.compareTo
function baselineDates(today: Date, compareTo: string): Date[] {
  if (compareTo === "same-weekday") {
    // last 3 same-weekday days
    return [1, 2, 3].map((n) => {
      const d = new Date(today);
      d.setDate(d.getDate() - 7 * n);
      return d;
    });
  }
  if (compareTo === "trailing-7d") {
    return Array.from({ length: 7 }).map((_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - (i + 1));
      return d;
    });
  }
  // trailing-30d
  return Array.from({ length: 30 }).map((_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (i + 1));
    return d;
  });
}

async function evalMetric(
  outletId: any,
  metric: string,
  compareTo: string
): Promise<MetricResult | null> {
  const today = new Date();
  const dates = baselineDates(today, compareTo);
  let observed = 0;
  let baseline = 0;
  if (metric === "revenue") {
    observed = await revenueForDay(outletId, today);
    const vals = await Promise.all(
      dates.map((d) => revenueForDay(outletId, d))
    );
    baseline = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  } else if (metric === "order-volume") {
    observed = await orderCountForDay(outletId, today);
    const vals = await Promise.all(
      dates.map((d) => orderCountForDay(outletId, d))
    );
    baseline = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  } else {
    return null;
  }
  return { observed: Math.round(observed), baseline: Math.round(baseline) };
}

export async function detectAnomalies(
  outletId?: string | null
): Promise<{ created: number }> {
  const filter: any = { active: true };
  if (outletId) filter.outletId = new mongoose.Types.ObjectId(outletId);
  const rules = await AnomalyRule.find(filter);
  let created = 0;
  for (const rule of rules) {
    const result = await evalMetric(
      rule.outletId,
      rule.metric,
      rule.compareTo
    );
    if (!result) continue;
    if (result.baseline === 0) continue;
    const deviationPct = Math.round(
      ((result.observed - result.baseline) / result.baseline) * 100
    );
    if (Math.abs(deviationPct) < rule.deviationPct) continue;

    // Dedupe: skip if an unresolved event for this rule exists for today
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const existing = await AnomalyEvent.findOne({
      outletId: rule.outletId,
      ruleId: rule._id,
      resolved: false,
      detectedAt: { $gte: since },
    });
    if (existing) continue;

    const direction = deviationPct < 0 ? "below" : "above";
    const title =
      rule.metric === "revenue"
        ? `Revenue ${Math.abs(deviationPct)}% ${direction} typical`
        : rule.metric === "order-volume"
        ? `Order volume ${Math.abs(deviationPct)}% ${direction} typical`
        : `${rule.name} trip`;
    const body =
      rule.metric === "revenue"
        ? `Today: Rs ${result.observed.toLocaleString()} · baseline: Rs ${result.baseline.toLocaleString()}`
        : `Today: ${result.observed} · baseline: ${Math.round(
            result.baseline
          )}`;

    const event = await AnomalyEvent.create({
      outletId: rule.outletId,
      ruleId: rule._id,
      ruleName: rule.name,
      metric: rule.metric,
      title,
      body,
      severity: rule.severity,
      observed: result.observed,
      baseline: result.baseline,
      deviationPct,
      link: "/reports",
    });
    created += 1;

    await notify({
      outletId: rule.outletId.toString(),
      type: "system",
      level: rule.severity,
      title: `Anomaly detected · ${title}`,
      body,
      link: "/reports",
      targetRoles: ["admin", "manager"],
    });
  }
  return { created };
}
