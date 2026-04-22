import { AuditLog } from "../models/AuditLog";

export async function audit(args: {
  outletId: string;
  userId?: string;
  userName?: string;
  action: string; // e.g. "outlet.update", "promotion.create", "order.void"
  targetType?: string;
  targetId?: string;
  before?: any;
  after?: any;
}) {
  try {
    await AuditLog.create({
      outletId: args.outletId,
      userId: args.userId,
      userName: args.userName,
      action: args.action,
      targetType: args.targetType,
      targetId: args.targetId,
      before: args.before,
      after: args.after,
      at: new Date(),
    });
  } catch (err) {
    // Never let audit failures break the main action
    console.error("[audit] write failed", err);
  }
}
