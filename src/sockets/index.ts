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
      next();
    } catch {
      next(new Error("invalid token"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const outletId = (socket as any).outletId ?? "public";
    socket.join(`outlet:${outletId}`);
    socket.on("disconnect", () => {});
  });

  return io;
}

export function emit(event: string, payload: any, outletId?: string) {
  if (!io) return;
  if (outletId) io.to(`outlet:${outletId}`).emit(event, payload);
  else io.emit(event, payload);
}
