import { Server as HttpServer } from "http";
import { Server as IOServer, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

let io: IOServer;

export function initSockets(httpServer: HttpServer) {
  io = new IOServer(httpServer, {
    cors: { origin: env.CORS_ORIGIN, credentials: true },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(); // allow anonymous read-only subscribers for now
    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as any;
      (socket as any).userId = payload.sub;
      (socket as any).outletId = payload.outletId;
      (socket as any).role = payload.role;
      next();
    } catch {
      next(new Error("invalid token"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const outletId = (socket as any).outletId ?? "public";
    const userId = (socket as any).userId;
    const role = (socket as any).role;
    socket.join(`outlet:${outletId}`);
    if (userId) socket.join(`user:${userId}`);
    if (role && outletId !== "public") socket.join(`role:${outletId}:${role}`);
    socket.on("disconnect", () => {});
  });

  return io;
}

/** Maps domain events → generic invalidation so useApi refreshes without duplicate listeners. */
function resourceForEvent(event: string): string | null {
  if (event === "order:new" || event === "order:update") return "orders";
  if (event === "table:update") return "tables";
  if (event === "inventory:update") return "inventory";
  if (event === "wastage:new") return "wastage";
  if (event === "notification:new") return "notifications";
  return null;
}

export function emit(
  event: string,
  payload: any,
  outletId?: string,
  target?: { userId?: string; roles?: string[] }
) {
  if (!io) return;
  const oid = outletId ? String(outletId) : undefined;

  // Pick the narrowest delivery scope: personal > role list > outlet-wide.
  if (target?.userId) {
    io.to(`user:${String(target.userId)}`).emit(event, payload);
  } else if (target?.roles && target.roles.length > 0 && oid) {
    for (const role of target.roles) {
      io.to(`role:${oid}:${role}`).emit(event, payload);
    }
  } else if (oid) {
    io.to(`outlet:${oid}`).emit(event, payload);
  } else {
    io.emit(event, payload);
  }

  // data:changed is a cache-invalidation hint — keep it outlet-wide so all clients refetch
  // and let server-side role gating decide what they actually see.
  const resource = resourceForEvent(event);
  if (resource) {
    const dc = {
      method: "SOCKET",
      resource,
      path: `/api/${resource}`,
      ts: Date.now(),
    };
    if (oid) io.to(`outlet:${oid}`).emit("data:changed", dc);
    else io.emit("data:changed", dc);
  }
}
