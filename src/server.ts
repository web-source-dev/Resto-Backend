import express from "express";
import cors from "cors";
import http from "http";
import rateLimit from "express-rate-limit";
import { env } from "./config/env";
import { connectDB } from "./config/db";
import { errorHandler } from "./middleware/errorHandler";
import { emit, initSockets } from "./sockets";

import authRoutes from "./routes/auth";
import overviewRoutes from "./routes/overview";
import ordersRoutes from "./routes/orders";
import tablesRoutes from "./routes/tables";
import menuRoutes from "./routes/menu";
import inventoryRoutes from "./routes/inventory";
import wastageRoutes from "./routes/wastage";
import staffRoutes from "./routes/staff";
import customersRoutes from "./routes/customers";
import reportsRoutes from "./routes/reports";
import notificationsRoutes from "./routes/notifications";
import searchRoutes from "./routes/search";
import campaignsRoutes from "./routes/campaigns";
import suppliersRoutes from "./routes/suppliers";
import qrRoutes from "./routes/qr";
import expensesRoutes from "./routes/expenses";
import deliveryRoutes from "./routes/delivery";
import promotionsRoutes from "./routes/promotions";
import shiftsRoutes from "./routes/shifts";
import attendanceRoutes from "./routes/attendance";
import leaveRoutes from "./routes/leave";
import waitlistRoutes from "./routes/waitlist";
import anomaliesRoutes from "./routes/anomalies";
import outletsRoutes from "./routes/outlets";
import settingsRoutes from "./routes/settings";
import pushRoutes from "./routes/push";
import { detectAnomalies } from "./services/anomalyDetector";

async function main() {
  const uri = await connectDB();
  console.log("[db] connected:", uri.slice(0, 60));

  const app = express();
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true,
    })
  );
  app.use(express.json({ limit: "2mb" }));

  // Emit a generic realtime invalidation event for all successful write requests.
  // Frontend hooks can subscribe once and refresh active views automatically.
  app.use((req, res, next) => {
    const method = req.method.toUpperCase();
    const isWrite =
      method === "POST" ||
      method === "PUT" ||
      method === "PATCH" ||
      method === "DELETE";
    if (!isWrite || !req.path.startsWith("/api/")) return next();

    const originalJson = res.json.bind(res);
    res.json = ((body: any) => {
      if (res.statusCode < 400) {
        const outletId = (req as any).outletId;
        const resource = req.path.split("/").filter(Boolean)[1] ?? "unknown";
        // Guest QR routes have no JWT → no req.outletId. Broadcasting globally would
        // refresh every outlet and miss nothing — but we skip here and let qr routes
        // emit `data:changed` scoped to the correct outlet.
        if (!outletId && req.path.startsWith("/api/qr")) {
          return originalJson(body);
        }
        emit(
          "data:changed",
          {
            method,
            resource,
            path: req.path,
            ts: Date.now(),
          },
          outletId
        );
      }
      return originalJson(body);
    }) as typeof res.json;
    next();
  });

  app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

  // rate limiting — protect auth + public QR routes
  const authLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const qrLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.use("/api/auth/login", authLimiter);
  app.use("/api/qr", qrLimiter);

  app.use("/api/auth", authRoutes);
  app.use("/api/overview", overviewRoutes);
  app.use("/api/orders", ordersRoutes);
  app.use("/api/tables", tablesRoutes);
  app.use("/api/menu", menuRoutes);
  app.use("/api/inventory", inventoryRoutes);
  app.use("/api/wastage", wastageRoutes);
  app.use("/api/staff", staffRoutes);
  app.use("/api/customers", customersRoutes);
  app.use("/api/reports", reportsRoutes);
  app.use("/api/notifications", notificationsRoutes);
  app.use("/api/search", searchRoutes);
  app.use("/api/campaigns", campaignsRoutes);
  app.use("/api/suppliers", suppliersRoutes);
  app.use("/api/qr", qrRoutes);
  app.use("/api/expenses", expensesRoutes);
  app.use("/api/delivery", deliveryRoutes);
  app.use("/api/promotions", promotionsRoutes);
  app.use("/api/shifts", shiftsRoutes);
  app.use("/api/attendance", attendanceRoutes);
  app.use("/api/leave", leaveRoutes);
  app.use("/api/waitlist", waitlistRoutes);
  app.use("/api/anomalies", anomaliesRoutes);
  app.use("/api/outlets", outletsRoutes);
  app.use("/api/settings", settingsRoutes);
  app.use("/api/push", pushRoutes);

  // Background: run anomaly detection every hour (no cron needed)
  setInterval(() => {
    detectAnomalies().catch((err) =>
      console.error("[anomaly-detector]", err)
    );
  }, 60 * 60 * 1000);

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(errorHandler);

  const server = http.createServer(app);
  initSockets(server);

  server.listen(env.PORT, () => {
    console.log(`[api] listening on http://localhost:${env.PORT}`);
  });
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
