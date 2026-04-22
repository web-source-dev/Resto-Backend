import { Notification } from "../models/Notification";
import { emit } from "../sockets";

export async function notify(args: {
  outletId: string;
  type: string;
  level?: "info" | "success" | "warn" | "error";
  title: string;
  body?: string;
  link?: string;
  targetRoles?: string[];
  // If set, only this specific user sees it — useful for 1:1 assignments
  // (e.g. "you've been assigned order #X").
  targetUserId?: string;
}) {
  const n = await Notification.create({
    outletId: args.outletId,
    type: args.type,
    level: args.level ?? "info",
    title: args.title,
    body: args.body,
    link: args.link,
    targetRoles: args.targetRoles ?? [],
    userId: args.targetUserId,
  });
  emit("notification:new", n.toJSON(), args.outletId);
  return n;
}
