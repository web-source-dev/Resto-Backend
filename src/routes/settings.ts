import { Router } from "express";
import crypto from "crypto";
import {
  NotificationTemplate,
  TEMPLATE_CHANNELS,
  TEMPLATE_EVENTS,
} from "../models/NotificationTemplate";
import { AuditLog } from "../models/AuditLog";
import { Outlet } from "../models/Outlet";
import { Printer, PRINTER_TYPES } from "../models/Printer";
import { Webhook, WEBHOOK_EVENTS } from "../models/Webhook";
import { ApiKey, API_KEY_SCOPES } from "../models/ApiKey";
import { BackupJob } from "../models/BackupJob";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest, requireRole } from "../middleware/auth";
import { notify } from "../services/notify";
import { audit } from "../services/audit";
import {
  providerStatus,
  sendSms,
  sendWhatsapp,
  sendEmail,
  pingStripe,
  geocode,
  buildTestTicket,
  escposPrint,
} from "../services/providers";
import { testDeliver } from "../services/webhookDispatcher";

// Mongo models we'll dump for backup
import { Order } from "../models/Order";
import { MenuItem } from "../models/MenuItem";
import { Customer } from "../models/Customer";
import { Ingredient } from "../models/Ingredient";
import { Table } from "../models/Table";

const r = Router();
r.use(authMiddleware);
const canWrite = requireRole("admin", "manager");
const adminOnly = requireRole("admin");

// ═══ Notification templates ═══════════════════════════════════════════

r.get(
  "/templates",
  asyncHandler(async (req: AuthedRequest, res) => {
    const items = await NotificationTemplate.find({ outletId: req.outletId })
      .sort({ channel: 1, name: 1 });
    res.json({ items, channels: TEMPLATE_CHANNELS, events: TEMPLATE_EVENTS });
  })
);

r.post(
  "/templates",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const item = await NotificationTemplate.create({
      outletId: req.outletId,
      ...req.body,
    });
    res.status(201).json({ item });
  })
);

r.patch(
  "/templates/:id",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const item = await NotificationTemplate.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      req.body,
      { new: true }
    );
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json({ item });
  })
);

r.delete(
  "/templates/:id",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    await NotificationTemplate.deleteOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    res.json({ ok: true });
  })
);

r.post(
  "/templates/:id/test",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const template = await NotificationTemplate.findOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    if (!template) return res.status(404).json({ error: "Not found" });
    const vars = {
      customerName: "Test Guest",
      orderCode: "#A-TEST",
      total: "Rs 1,250",
      tableCode: "T-07",
      ...req.body.vars,
    };
    const rendered = String(template.body ?? "").replace(
      /\{\{(\w+)\}\}/g,
      (_, k) => (vars as any)[k] ?? `{{${k}}}`
    );
    // Route to the real channel if a `to` was provided, else drop in feed.
    const to = String(req.body.to ?? "").trim();
    let delivery: any = { channel: template.channel, provider: "feed" };
    if (to) {
      if (template.channel === "SMS") delivery = await sendSms(to, rendered);
      else if (template.channel === "WhatsApp")
        delivery = await sendWhatsapp(to, rendered);
      else if (template.channel === "Email")
        delivery = await sendEmail({
          to,
          subject: template.subject ?? template.name,
          body: rendered,
        });
    }
    await notify({
      outletId: req.outletId!,
      type: "system",
      level: "info",
      title: `Test · ${template.channel} · ${template.name}`,
      body: rendered,
      link: "/settings",
      targetRoles: ["admin", "manager"],
    });
    res.json({ rendered, channel: template.channel, delivery });
  })
);

// ═══ Audit log ════════════════════════════════════════════════════════

r.get(
  "/audit",
  adminOnly,
  asyncHandler(async (req: AuthedRequest, res) => {
    const q: any = { outletId: req.outletId };
    if (req.query.action) q.action = req.query.action;
    const items = await AuditLog.find(q)
      .sort({ at: -1 })
      .limit(Number(req.query.limit ?? 100));
    res.json({ items });
  })
);

// ═══ Providers (SMS · Email · WhatsApp · Stripe · Maps) ═══════════════

r.get(
  "/providers",
  asyncHandler(async (_req, res) => {
    res.json({ providers: providerStatus() });
  })
);

r.post(
  "/providers/:id/test",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = req.params.id;
    const { to, subject } = req.body ?? {};
    if (id === "sms") {
      if (!to) return res.status(400).json({ error: "Provide a 'to' phone number" });
      const result = await sendSms(to, "Dinova test SMS · settings ping");
      return res.json(result);
    }
    if (id === "whatsapp") {
      if (!to) return res.status(400).json({ error: "Provide a 'to' phone number" });
      const result = await sendWhatsapp(to, "Dinova test WhatsApp · settings ping");
      return res.json(result);
    }
    if (id === "email") {
      if (!to) return res.status(400).json({ error: "Provide a 'to' email" });
      const result = await sendEmail({
        to,
        subject: subject ?? "Dinova test email",
        body: "This is a test email from your Dinova settings page.",
      });
      return res.json(result);
    }
    if (id === "stripe") return res.json(await pingStripe());
    if (id === "maps")
      return res.json(await geocode(req.body?.address ?? "Karachi, Pakistan"));
    return res.status(404).json({ error: "Unknown provider" });
  })
);

// ═══ Printers (ESC/POS network) ═══════════════════════════════════════

r.get(
  "/printers",
  asyncHandler(async (req: AuthedRequest, res) => {
    const items = await Printer.find({ outletId: req.outletId }).sort({ name: 1 });
    res.json({ items, types: PRINTER_TYPES });
  })
);

r.post(
  "/printers",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const item = await Printer.create({ outletId: req.outletId, ...req.body });
    res.status(201).json({ item });
  })
);

r.patch(
  "/printers/:id",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const item = await Printer.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      req.body,
      { new: true }
    );
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json({ item });
  })
);

r.delete(
  "/printers/:id",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    await Printer.deleteOne({ _id: req.params.id, outletId: req.outletId });
    res.json({ ok: true });
  })
);

r.post(
  "/printers/:id/test",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const printer = await Printer.findOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    if (!printer) return res.status(404).json({ error: "Not found" });
    const outlet = await Outlet.findById(req.outletId);
    const payload = buildTestTicket(outlet?.name ?? "Dinova");
    const result = await escposPrint(printer.host, printer.port ?? 9100, payload);
    printer.lastTestAt = new Date();
    printer.lastTestOk = result.ok;
    printer.lastTestError = result.error;
    await printer.save();
    res.json(result);
  })
);

// ═══ Webhooks ═════════════════════════════════════════════════════════

r.get(
  "/webhooks",
  asyncHandler(async (req: AuthedRequest, res) => {
    const items = await Webhook.find({ outletId: req.outletId }).sort({ name: 1 });
    res.json({ items, events: WEBHOOK_EVENTS });
  })
);

r.post(
  "/webhooks",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const item = await Webhook.create({ outletId: req.outletId, ...req.body });
    res.status(201).json({ item });
  })
);

r.patch(
  "/webhooks/:id",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const item = await Webhook.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      req.body,
      { new: true }
    );
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json({ item });
  })
);

r.delete(
  "/webhooks/:id",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    await Webhook.deleteOne({ _id: req.params.id, outletId: req.outletId });
    res.json({ ok: true });
  })
);

r.post(
  "/webhooks/:id/test",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const hook = await Webhook.findOne({
      _id: req.params.id,
      outletId: req.outletId,
    });
    if (!hook) return res.status(404).json({ error: "Not found" });
    const result = await testDeliver(String(hook._id));
    res.json(result);
  })
);

// ═══ API keys ═════════════════════════════════════════════════════════

function hashKey(key: string) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

r.get(
  "/api-keys",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const items = await ApiKey.find({ outletId: req.outletId })
      .select("-hashedKey")
      .sort({ createdAt: -1 });
    res.json({ items, scopes: API_KEY_SCOPES });
  })
);

r.post(
  "/api-keys",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const rawKey = `ff_${crypto.randomBytes(24).toString("hex")}`;
    const prefix = rawKey.slice(0, 11); // "ff_" + 8 chars
    const key = await ApiKey.create({
      outletId: req.outletId,
      name: req.body.name ?? "Untitled key",
      scopes: req.body.scopes ?? [],
      prefix,
      hashedKey: hashKey(rawKey),
      createdBy: (req.user as any)?._id,
      expiresAt: req.body.expiresAt,
    });
    await audit({
      outletId: req.outletId!,
      userId: (req.user as any)?._id?.toString(),
      userName: (req.user as any)?.name,
      action: "api_key.create",
      targetType: "ApiKey",
      targetId: String(key._id),
      after: { name: key.name, prefix: key.prefix, scopes: key.scopes },
    });
    // Return the raw key ONCE — UI must show it to the user now.
    res.status(201).json({
      item: {
        _id: key._id,
        name: key.name,
        prefix: key.prefix,
        scopes: key.scopes,
        createdAt: key.createdAt,
      },
      rawKey,
    });
  })
);

r.delete(
  "/api-keys/:id",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const key = await ApiKey.findOneAndUpdate(
      { _id: req.params.id, outletId: req.outletId },
      { revokedAt: new Date() },
      { new: true }
    );
    if (!key) return res.status(404).json({ error: "Not found" });
    await audit({
      outletId: req.outletId!,
      userId: (req.user as any)?._id?.toString(),
      userName: (req.user as any)?.name,
      action: "api_key.revoke",
      targetType: "ApiKey",
      targetId: String(key._id),
      after: { prefix: key.prefix },
    });
    res.json({ ok: true });
  })
);

// ═══ Business hours (convenience wrapper over outlet update) ═══════════

r.patch(
  "/hours",
  canWrite,
  asyncHandler(async (req: AuthedRequest, res) => {
    const hours = Array.isArray(req.body.businessHours) ? req.body.businessHours : [];
    const outlet = await Outlet.findByIdAndUpdate(
      req.outletId,
      { businessHours: hours },
      { new: true }
    );
    if (!outlet) return res.status(404).json({ error: "Outlet not found" });
    res.json({ outlet });
  })
);

// ═══ Backup export ════════════════════════════════════════════════════

r.get(
  "/backups",
  adminOnly,
  asyncHandler(async (req: AuthedRequest, res) => {
    const items = await BackupJob.find({ outletId: req.outletId })
      .sort({ startedAt: -1 })
      .limit(20);
    res.json({ items });
  })
);

r.post(
  "/backups",
  adminOnly,
  asyncHandler(async (req: AuthedRequest, res) => {
    const me = req.user as any;
    const job = await BackupJob.create({
      outletId: req.outletId,
      triggeredBy: me?._id,
      triggeredByName: me?.name,
      status: "running",
      startedAt: new Date(),
    });
    try {
      const scope = { outletId: req.outletId };
      const payload: Record<string, any[]> = {};
      const pairs: [string, any][] = [
        ["orders", Order],
        ["menu", MenuItem],
        ["customers", Customer],
        ["ingredients", Ingredient],
        ["tables", Table],
      ];
      let totalRecords = 0;
      for (const [label, Model] of pairs) {
        const docs = await Model.find(scope).lean();
        payload[label] = docs;
        totalRecords += docs.length;
      }
      const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
      job.status = "done";
      job.collections = pairs.map(([k]) => k);
      job.recordCount = totalRecords;
      job.sizeBytes = bytes;
      job.finishedAt = new Date();
      await job.save();
      await audit({
        outletId: req.outletId!,
        userId: me?._id?.toString(),
        userName: me?.name,
        action: "backup.create",
        targetType: "BackupJob",
        targetId: String(job._id),
        after: { records: totalRecords, sizeBytes: bytes },
      });
      res.setHeader("Content-Type", "application/json");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="dinova-backup-${Date.now()}.json"`
      );
      res.end(JSON.stringify({ createdAt: new Date(), ...payload }, null, 2));
    } catch (err: any) {
      job.status = "failed";
      job.error = err?.message ?? String(err);
      job.finishedAt = new Date();
      await job.save();
      res.status(500).json({ error: job.error });
    }
  })
);

export default r;
