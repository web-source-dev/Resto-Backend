import express from "express";
import cors from "cors";
import http from "http";
import rateLimit from "express-rate-limit";
import { env } from "./config/env";
import { connectDB } from "./config/db";
import { errorHandler } from "./middleware/errorHandler";
import { initSockets } from "./sockets";
import { maybeSeed } from "./seed/seed";
import { ensureTestUsers } from "./seed/ensureUsers";

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
import { detectAnomalies } from "./services/anomalyDetector";

async function main() {
  const uri = await connectDB();
  console.log("[db] connected:", uri.slice(0, 60));
  await maybeSeed();
  await ensureTestUsers();

  const app = express();
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true,
    })
  );
  app.use(express.json({ limit: "2mb" }));

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
