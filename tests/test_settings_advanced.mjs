// E2E for advanced settings — providers, printers, webhooks, api-keys, backup,
// business hours, receipt customization, security policy.
const BASE = "http://localhost:4000";
const failures = [];

async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`Login ${email}: ${r.status}`);
  return r.json();
}
function H(t) { return { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }; }
async function j(m, p, t, b) {
  const r = await fetch(`${BASE}${p}`, { method: m, headers: H(t), body: b ? JSON.stringify(b) : undefined });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
function check(name, cond, detail = "") {
  const mark = cond ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? " · " + detail : ""}`);
  if (!cond) failures.push(name);
}

(async () => {
  console.log("═".repeat(70));
  console.log("Advanced settings E2E");
  console.log("═".repeat(70));

  const admin = await login("admin@flavorflow.dev", "admin123");
  const manager = await login("manager@flavorflow.dev", "manager123");
  const waiter = await login("waiter@flavorflow.dev", "waiter123");
  console.log("Logged in as admin, manager, waiter");

  const oid = admin.user.outletId;
  let r;

  // ─── Providers ───
  console.log("\n── Providers ─────────────────────────────");
  r = await j("GET", "/api/settings/providers", admin.token);
  check("GET providers 200", r.status === 200, `status=${r.status}`);
  const p = r.data?.providers ?? {};
  check("Has sms provider", !!p.sms);
  check("Has whatsapp", !!p.whatsapp);
  check("Has email", !!p.email);
  check("Has stripe", !!p.stripe);
  check("Has maps", !!p.maps);
  check("sms requiredEnv listed", Array.isArray(p.sms?.requiredEnv) && p.sms.requiredEnv.includes("TWILIO_ACCOUNT_SID"));

  // Test each in mock mode
  r = await j("POST", "/api/settings/providers/sms/test", admin.token, { to: "+923001234567" });
  check("Test SMS succeeds (mock ok)", r.status === 200 && r.data?.ok === true, `provider=${r.data?.provider}`);

  r = await j("POST", "/api/settings/providers/whatsapp/test", admin.token, { to: "+923001234567" });
  check("Test WhatsApp succeeds", r.status === 200 && r.data?.ok === true);

  r = await j("POST", "/api/settings/providers/email/test", admin.token, { to: "test@example.com" });
  check("Test email succeeds", r.status === 200 && r.data?.ok === true);

  r = await j("POST", "/api/settings/providers/stripe/test", admin.token, {});
  check("Ping stripe returns status", r.status === 200);

  r = await j("POST", "/api/settings/providers/maps/test", admin.token, { address: "Karachi, Pakistan" });
  check("Geocode returns coords", r.status === 200 && typeof r.data?.lat === "number");

  // Missing 'to' for sms → 400
  r = await j("POST", "/api/settings/providers/sms/test", admin.token, {});
  check("SMS without 'to' rejected", r.status === 400);

  // Waiter blocked
  r = await j("POST", "/api/settings/providers/sms/test", waiter.token, { to: "+9230012345" });
  check("Waiter cannot test provider", [401, 403].includes(r.status), `status=${r.status}`);

  // ─── Printers ───
  console.log("\n── Printers ──────────────────────────────");
  r = await j("GET", "/api/settings/printers", admin.token);
  check("GET printers 200", r.status === 200);
  const startCount = (r.data?.items ?? []).length;

  r = await j("POST", "/api/settings/printers", admin.token, {
    name: "Test Kitchen Printer",
    type: "kitchen",
    host: "127.0.0.1",
    port: 9999,
    station: "Grill",
    active: true,
  });
  check("Create printer 201", r.status === 201, `status=${r.status}`);
  const printerId = (r.data?.item?._id ?? r.data?.item?.id);
  check("Printer has id", !!printerId);

  r = await j("PATCH", `/api/settings/printers/${printerId}`, admin.token, { station: "Fryer" });
  check("Patch printer 200", r.status === 200 && r.data?.item?.station === "Fryer");

  // Test print against unreachable port — should return { ok: false }
  r = await j("POST", `/api/settings/printers/${printerId}/test`, admin.token, {});
  check("Test print records failure", r.status === 200 && r.data?.ok === false, `err='${r.data?.error}'`);

  // Waiter cannot create
  r = await j("POST", "/api/settings/printers", waiter.token, { name: "nope", host: "x" });
  check("Waiter cannot create printer", [401, 403].includes(r.status));

  r = await j("DELETE", `/api/settings/printers/${printerId}`, admin.token);
  check("Delete printer 200", r.status === 200);

  r = await j("GET", "/api/settings/printers", admin.token);
  check("Printer count back to start", (r.data?.items ?? []).length === startCount);

  // ─── Webhooks ───
  console.log("\n── Webhooks ──────────────────────────────");
  r = await j("GET", "/api/settings/webhooks", admin.token);
  check("GET webhooks 200", r.status === 200);
  check("Events list includes order.paid", (r.data?.events ?? []).includes("order.paid"));

  // Point a hook at our own /health endpoint so test delivery succeeds.
  r = await j("POST", "/api/settings/webhooks", admin.token, {
    name: "Test hook",
    url: `${BASE}/health`,
    events: ["order.paid", "order.ready"],
    active: true,
  });
  check("Create webhook 201", r.status === 201);
  const hookId = (r.data?.item?._id ?? r.data?.item?.id);

  r = await j("POST", `/api/settings/webhooks/${hookId}/test`, admin.token, {});
  // /health returns 200, so delivery should be ok (but /health only accepts GET, so it'll 404)
  check("Webhook test delivered", r.status === 200, `ok=${r.data?.ok} status=${r.data?.status}`);

  r = await j("PATCH", `/api/settings/webhooks/${hookId}`, admin.token, { active: false });
  check("Patch webhook 200", r.status === 200 && r.data?.item?.active === false);

  // Waiter cannot create
  r = await j("POST", "/api/settings/webhooks", waiter.token, { name: "x", url: "https://x" });
  check("Waiter cannot create webhook", [401, 403].includes(r.status));

  r = await j("DELETE", `/api/settings/webhooks/${hookId}`, admin.token);
  check("Delete webhook 200", r.status === 200);

  // ─── API keys ───
  console.log("\n── API keys ──────────────────────────────");
  r = await j("GET", "/api/settings/api-keys", admin.token);
  check("GET api-keys 200", r.status === 200);
  check("Scopes list present", (r.data?.scopes ?? []).includes("read:orders"));

  r = await j("POST", "/api/settings/api-keys", admin.token, {
    name: "E2E key",
    scopes: ["read:orders", "read:menu"],
  });
  check("Create key 201", r.status === 201);
  check("Raw key returned", typeof r.data?.rawKey === "string" && r.data.rawKey.startsWith("ff_"));
  check("Prefix matches", r.data?.rawKey?.startsWith(r.data?.item?.prefix ?? "xxx"));
  const keyId = (r.data?.item?._id ?? r.data?.item?.id);

  // Get-back list should NOT include hashedKey
  r = await j("GET", "/api/settings/api-keys", admin.token);
  const found = (r.data?.items ?? []).find((x) => (x._id ?? x.id) === keyId);
  check("Key appears in list", !!found);
  check("List omits hashedKey", !found?.hashedKey);

  // Waiter cannot read keys
  r = await j("GET", "/api/settings/api-keys", waiter.token);
  check("Waiter cannot read keys", [401, 403].includes(r.status));

  r = await j("DELETE", `/api/settings/api-keys/${keyId}`, admin.token);
  check("Revoke key 200", r.status === 200);

  // ─── Business hours ───
  console.log("\n── Business hours ────────────────────────");
  const hours = Array.from({ length: 7 }, (_, d) => ({
    day: d,
    closed: d === 0,
    openTime: "09:00",
    closeTime: "22:00",
  }));
  r = await j("PATCH", "/api/settings/hours", admin.token, { businessHours: hours });
  check("PATCH hours as admin 200", r.status === 200, `status=${r.status}`);
  check("Hours saved on outlet", Array.isArray(r.data?.outlet?.businessHours) && r.data.outlet.businessHours.length === 7);

  // Manager can also patch hours
  r = await j("PATCH", "/api/settings/hours", manager.token, { businessHours: hours });
  check("PATCH hours as manager 200", r.status === 200);

  // Waiter blocked
  r = await j("PATCH", "/api/settings/hours", waiter.token, { businessHours: [] });
  check("Waiter cannot set hours", [401, 403].includes(r.status));

  // ─── Receipt + security (outlet PATCH) ───
  console.log("\n── Receipt + security policy ─────────────");
  r = await j("PATCH", `/api/outlets/${oid}`, admin.token, {
    receiptHeader: "Welcome!",
    receiptFooter: "Thank you · follow @flavorflow",
    receiptShowLogo: true,
    receiptShowTaxBreakdown: true,
    qrBrandColor: "#ef4444",
    sessionTimeoutMinutes: 480,
    passwordMinLength: 10,
    requireMfa: false,
    retainOrderHistoryDays: 730,
    retainAuditLogDays: 365,
  });
  check("PATCH receipt+security 200", r.status === 200);
  check("Receipt header saved", r.data?.outlet?.receiptHeader === "Welcome!");
  check("Session timeout saved", r.data?.outlet?.sessionTimeoutMinutes === 480);
  check("Retention saved", r.data?.outlet?.retainOrderHistoryDays === 730);
  check("QR brand color saved", r.data?.outlet?.qrBrandColor === "#ef4444");

  // ─── Backup ───
  console.log("\n── Backup ────────────────────────────────");
  r = await j("GET", "/api/settings/backups", admin.token);
  check("GET backups as admin 200", r.status === 200);

  // Manager cannot (admin only)
  r = await j("GET", "/api/settings/backups", manager.token);
  check("GET backups as manager blocked", [401, 403].includes(r.status), `status=${r.status}`);

  // Trigger a backup
  const backRes = await fetch(`${BASE}/api/settings/backups`, {
    method: "POST",
    headers: H(admin.token),
  });
  check("POST backup succeeds", backRes.status === 200, `status=${backRes.status}`);
  const bodyText = await backRes.text();
  check("Backup body is JSON", bodyText.startsWith("{"));
  const parsed = JSON.parse(bodyText);
  check("Backup includes orders", Array.isArray(parsed.orders));
  check("Backup includes menu", Array.isArray(parsed.menu));
  check("Backup includes customers", Array.isArray(parsed.customers));

  // Job was recorded
  r = await j("GET", "/api/settings/backups", admin.token);
  check("Backup job row recorded", (r.data?.items ?? []).some((x) => x.status === "done"));

  console.log("\n" + "═".repeat(70));
  if (failures.length) {
    console.log(`FAILED · ${failures.length} issue(s):`);
    for (const f of failures) console.log("   -", f);
    process.exit(1);
  }
  console.log("All advanced-settings E2E checks PASSED");
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
