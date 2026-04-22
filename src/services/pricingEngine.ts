import { Promotion } from "../models/Promotion";
import { PricingRule } from "../models/PricingRule";
import { Customer } from "../models/Customer";
import { MenuItem } from "../models/MenuItem";

export type DiscountLine = {
  source:
    | "coupon"
    | "combo"
    | "happy-hour"
    | "weekend-surcharge"
    | "delivery-markup"
    | "loyalty-redemption"
    | "tier"
    | "first-order";
  code?: string;
  label: string;
  amount: number; // negative = discount, positive = surcharge
};

export type PricedItem = {
  menuItemId: string;
  name: string;
  qty: number;
  price: number;
  mods?: string[];
  note?: string;
  categoryId?: string;
  isCombo?: boolean;
};

export type PricingInput = {
  outletId: string;
  channel: "Dine-in" | "Takeaway" | "Delivery" | "Phone";
  items: PricedItem[];
  customerId?: string;
  couponCode?: string;
  redeemPoints?: number;
  taxRate: number;
  serviceRate: number;
  when?: Date;
};

export type PricingResult = {
  subtotal: number;
  discountAmount: number; // total of all negative discountLines (positive number)
  surchargeAmount: number; // total of positive lines
  discountLines: DiscountLine[];
  tax: number;
  service: number;
  total: number;
  pointsRedeemed: number;
  couponValidation?: { ok: boolean; reason?: string };
  triggeredPromotionIds: string[];
};

function hhmmToMinutes(s?: string | null) {
  if (!s) return null;
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

async function pricingRulesForNow(
  outletId: string,
  channel: string,
  when: Date
): Promise<DiscountLine[]> {
  const rules = await PricingRule.find({ outletId, active: true });
  const day = when.getDay();
  const minsNow = when.getHours() * 60 + when.getMinutes();
  const lines: DiscountLine[] = [];
  for (const r of rules) {
    if (r.daysOfWeek?.length && !r.daysOfWeek.includes(day)) continue;
    const start = hhmmToMinutes(r.startTime);
    const end = hhmmToMinutes(r.endTime);
    if (start !== null && end !== null) {
      if (minsNow < start || minsNow > end) continue;
    }
    if (r.channel && r.channel !== channel) continue;
    lines.push({
      source:
        r.type === "happy-hour"
          ? "happy-hour"
          : r.type === "weekend-surcharge"
          ? "weekend-surcharge"
          : "delivery-markup",
      label: r.name,
      amount: 0, // fill in later; engine applies to filtered subtotal
    });
    // Attach the rule for later application
    (lines[lines.length - 1] as any)._rule = r;
  }
  return lines;
}

export async function priceOrder(input: PricingInput): Promise<PricingResult> {
  const when = input.when ?? new Date();
  const subtotal = input.items.reduce((s, i) => s + i.price * i.qty, 0);
  const discountLines: DiscountLine[] = [];
  const triggeredPromotionIds: string[] = [];
  let couponValidation: PricingResult["couponValidation"] | undefined;

  // 1) Combo savings (informational — bundle price is already discounted vs parts)
  for (const it of input.items) {
    if (it.isCombo) {
      const m = await MenuItem.findById(it.menuItemId).populate(
        "comboItems.menuItemId"
      );
      if (!m || !m.isCombo) continue;
      const parts = m.comboItems ?? [];
      let partsTotal = 0;
      for (const p of parts) {
        const ref: any = p.menuItemId;
        if (ref && ref.price) partsTotal += ref.price * (p.qty ?? 1);
      }
      const savings = Math.max(0, partsTotal - m.price) * it.qty;
      if (savings > 0) {
        discountLines.push({
          source: "combo",
          label: `${m.name} combo savings`,
          amount: -savings,
        });
      }
    }
  }

  // 2) Pricing rules (happy-hour / weekend / delivery markup)
  const ruleLines = await pricingRulesForNow(
    input.outletId,
    input.channel,
    when
  );
  for (const line of ruleLines) {
    const rule = (line as any)._rule;
    const applicable = rule?.categoryId
      ? input.items.filter(
          (i) => (i.categoryId ?? "").toString() === rule.categoryId.toString()
        )
      : input.items;
    const base = applicable.reduce((s, i) => s + i.price * i.qty, 0);
    const adj = Math.round((base * rule.adjustmentPct) / 100);
    if (adj === 0) continue;
    discountLines.push({
      source: line.source,
      label: rule.name,
      amount: adj, // negative if adjustmentPct is negative
    });
  }

  // 3) Coupon
  if (input.couponCode) {
    const code = input.couponCode.trim().toUpperCase();
    const promo = await Promotion.findOne({
      outletId: input.outletId,
      code,
      active: true,
    });
    if (!promo) {
      couponValidation = { ok: false, reason: "Invalid or expired code" };
    } else if (promo.validFrom && promo.validFrom > when) {
      couponValidation = { ok: false, reason: "Not yet active" };
    } else if (promo.validTo && promo.validTo < when) {
      couponValidation = { ok: false, reason: "Expired" };
    } else if (
      promo.redemptionLimit &&
      promo.redemptionLimit > 0 &&
      (promo.usedCount ?? 0) >= promo.redemptionLimit
    ) {
      couponValidation = { ok: false, reason: "Redemption limit reached" };
    } else if (subtotal < (promo.minBasket ?? 0)) {
      couponValidation = {
        ok: false,
        reason: `Minimum basket Rs ${promo.minBasket?.toLocaleString()}`,
      };
    } else {
      let ok = true;
      if (promo.segment && promo.segment !== "All") {
        if (!input.customerId) {
          ok = false;
          couponValidation = {
            ok: false,
            reason: "Add your details to use this offer",
          };
        } else {
          const c = await Customer.findById(input.customerId);
          if (!c) {
            ok = false;
          } else if (["Gold", "Silver", "Bronze"].includes(promo.segment as string)) {
            if (c.tier !== promo.segment) {
              ok = false;
              couponValidation = {
                ok: false,
                reason: `${promo.segment} tier only`,
              };
            }
          } else if (promo.segment === "New") {
            if ((c.visits ?? 0) > 1) {
              ok = false;
              couponValidation = {
                ok: false,
                reason: "First-order offer only",
              };
            }
          } else if (promo.segment === "Lapsed") {
            const thirty = Date.now() - 30 * 24 * 60 * 60 * 1000;
            if (c.lastVisitAt && c.lastVisitAt.getTime() > thirty) {
              ok = false;
              couponValidation = {
                ok: false,
                reason: "Haven't been away long enough",
              };
            }
          }
        }
      }
      if (ok) {
        let discount = 0;
        let label = promo.name;
        if (promo.type === "percent" || promo.type === "first-order") {
          discount = Math.round((subtotal * (promo.value ?? 0)) / 100);
          label = `${promo.name} · ${promo.value}% off`;
        } else if (promo.type === "flat") {
          discount = Math.min(subtotal, promo.value ?? 0);
          label = `${promo.name} · Rs ${promo.value} off`;
        } else if (promo.type === "free-item" || promo.type === "bogo") {
          // For free-item: find the target in cart, deduct its price
          const target = input.items.find(
            (i) => i.menuItemId === promo.targetItemId?.toString()
          );
          if (target) {
            discount = target.price; // one unit free
            label = `${promo.name} · free ${target.name}`;
          } else {
            couponValidation = {
              ok: false,
              reason: `Add the required item to use this offer`,
            };
            ok = false;
          }
        }
        if (ok && discount > 0) {
          discountLines.push({
            source: promo.type === "first-order" ? "first-order" : "coupon",
            code,
            label,
            amount: -discount,
          });
          triggeredPromotionIds.push(promo._id.toString());
          couponValidation = { ok: true };
        }
      }
    }
  }

  // 4) Loyalty points redemption (1 point = Rs 1)
  let pointsRedeemed = 0;
  if (input.redeemPoints && input.redeemPoints > 0 && input.customerId) {
    const c = await Customer.findById(input.customerId);
    if (c && c.points && c.points > 0) {
      const maxRedeem = Math.min(
        subtotal,
        c.points,
        Math.floor(input.redeemPoints)
      );
      if (maxRedeem > 0) {
        pointsRedeemed = maxRedeem;
        discountLines.push({
          source: "loyalty-redemption",
          label: `${maxRedeem} loyalty points`,
          amount: -maxRedeem,
        });
      }
    }
  }

  // Totals
  const discountAmount = discountLines
    .filter((l) => l.amount < 0)
    .reduce((s, l) => s + -l.amount, 0);
  const surchargeAmount = discountLines
    .filter((l) => l.amount > 0)
    .reduce((s, l) => s + l.amount, 0);

  const taxableBase = Math.max(0, subtotal - discountAmount + surchargeAmount);
  const tax = Math.round(taxableBase * input.taxRate);
  const service = Math.round(taxableBase * input.serviceRate);
  const total = taxableBase + tax + service;

  return {
    subtotal,
    discountAmount,
    surchargeAmount,
    discountLines,
    tax,
    service,
    total,
    pointsRedeemed,
    couponValidation,
    triggeredPromotionIds,
  };
}

export async function commitPromotionUsage(
  promotionIds: string[]
) {
  if (promotionIds.length === 0) return;
  await Promotion.updateMany(
    { _id: { $in: promotionIds } },
    { $inc: { usedCount: 1 } }
  );
}
