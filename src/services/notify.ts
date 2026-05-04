import { Notification } from "../models/Notification";
import { emit } from "../sockets";
import { sendPushToOutlet } from "./push";

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
  // Realtime + push must respect the same targeting that the REST list endpoint
  // applies, so devices outside the audience never see/hear the notification.
  const target = {
    userId: args.targetUserId,
    roles: args.targetRoles,
  };
  emit("notification:new", n.toJSON(), args.outletId, target);
  await sendPushToOutlet(
    args.outletId,
    {
      title: args.title,
      body: args.body,
      url: args.link,
      tag: args.type,
      level: args.level ?? "info",
    },
    target
  );
  return n;
}
