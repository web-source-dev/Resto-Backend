// E2E tests for the Settings page backend endpoints.
const BASE = "http://localhost:4000";
const failures = [];

async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`Login ${email} failed: ${r.status}`);
  return r.json();
}

function H(token) {
  return { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };
}

async function j(method, path, token, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: H(token),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

function check(name, cond, detail = "") {
  const mark = cond ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? " · " + detail : ""}`);
  if (!cond) failures.push(name);
}

(async () => {
  console.log("=".repeat(70));
  console.log("Settings page E2E");
  console.log("=".repeat(70));

  const admin = await login("admin@flavorflow.dev", "admin123");
  const manager = await login("manager@flavorflow.dev", "manager123");
  const waiter = await login("waiter@flavorflow.dev", "waiter123");
  const recept = await login("receptionist@flavorflow.dev", "recept123");
  console.log("Logged in roles: admin, manager, receptionist, waiter");

  const outletId = admin.user.outletId;

  // ── Outlet PATCH + audit ──
  console.log("\n── Outlet PATCH + audit log ─────────────");

  let r = await j("GET", "/api/outlets/current", admin.token);
  check("GET /api/outlets/current 200", r.status === 200, `status=${r.status}`);
  const before = r.data.outlet || {};
  const origName = before.name;
  const origRate = before.taxRate;

  const newName = "FlavorFlow · Verified";
  const newRate = 13.5;
  r = await j("PATCH", `/api/outlets/${outletId}`, admin.token, { name: newName, taxRate: newRate });
  check("PATCH outlet as admin 200", r.status === 200, `status=${r.status}`);
  const updated = (r.data && r.data.outlet) || {};
  check("Outlet name updated", updated.name === newName, `got '${updated.name}'`);
  check("Outlet taxRate updated", updated.taxRate === newRate, `got ${updated.taxRate}`);

  r = await j("PATCH", `/api/outlets/${outletId}`, manager.token, { serviceRate: 6.5 });
  check("PATCH outlet as manager 200", r.status === 200, `status=${r.status}`);

  r = await j("PATCH", `/api/outlets/${outletId}`, waiter.token, { name: "nope" });
  check("PATCH outlet as waiter blocked", [401, 403].includes(r.status), `status=${r.status}`);

  r = await j("PATCH", `/api/outlets/${outletId}`, recept.token, { name: "nope" });
  check("PATCH outlet as receptionist blocked", [401, 403].includes(r.status), `status=${r.status}`);

  if (origName) {
    await j("PATCH", `/api/outlets/${outletId}`, admin.token, { name: origName, taxRate: origRate });
  }

  // ── Notification templates ──
  console.log("\n── Notification templates ───────────────");

  r = await j("GET", "/api/settings/templates", admin.token);
  check("GET templates 200", r.status === 200, `status=${r.status}`);
  const items = (r.data && r.data.items) || [];
  check("Templates list present", Array.isArray(items), `count=${items.length}`);
  check("Channels list present", (r.data?.channels || []).includes("SMS"));
  check("Events list present", (r.data?.events || []).includes("order.ready"));

  r = await j("POST", "/api/settings/templates", admin.token, {
    name: "E2E Verify SMS",
    channel: "SMS",
    event: "order.confirmed",
    body: "Hi {{customerName}}, your order {{orderCode}} confirmed. Total {{total}}.",
  });
  check("POST template 201", r.status === 201, `status=${r.status}`);
  const tpl = (r.data && r.data.item) || {};
  const tplId = tpl._id || tpl.id;
  check("Template has id", !!tplId);

  r = await j("POST", "/api/settings/templates", waiter.token, {
    name: "nope", channel: "SMS", body: "nope",
  });
  check("POST template as waiter blocked", [401, 403].includes(r.status), `status=${r.status}`);

  r = await j("PATCH", `/api/settings/templates/${tplId}`, admin.token, {
    body: "Hi {{customerName}}, your order {{orderCode}} is ready.",
  });
  check("PATCH template 200", r.status === 200, `status=${r.status}`);

  r = await j("POST", `/api/settings/templates/${tplId}/test`, admin.token, {
    vars: { customerName: "Ali", orderCode: "#A-077" },
  });
  check("POST template test 200", r.status === 200, `status=${r.status}`);
  const rendered = (r.data && r.data.rendered) || "";
  check("Template vars substituted", rendered.includes("Ali") && rendered.includes("#A-077"),
    `rendered='${rendered}'`);

  r = await j("DELETE", `/api/settings/templates/${tplId}`, admin.token);
  check("DELETE template 200", r.status === 200, `status=${r.status}`);

  // ── Audit log ──
  console.log("\n── Audit log ─────────────────────────────");

  r = await j("GET", "/api/settings/audit?limit=20", admin.token);
  check("GET audit as admin 200", r.status === 200, `status=${r.status}`);
  const entries = (r.data && r.data.items) || [];
  check("Audit log has entries", entries.length > 0, `count=${entries.length}`);
  const actions = new Set(entries.map((e) => e.action));
  check("Audit captured outlet.update", actions.has("outlet.update"),
    `actions=${[...actions].join(",")}`);

  r = await j("GET", "/api/settings/audit", manager.token);
  check("GET audit as manager 200", r.status === 200, `status=${r.status}`);

  r = await j("GET", "/api/settings/audit", waiter.token);
  check("GET audit as waiter blocked", [401, 403].includes(r.status), `status=${r.status}`);

  console.log("\n" + "=".repeat(70));
  if (failures.length) {
    console.log(`FAILED · ${failures.length} issue(s): ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("All settings E2E checks PASSED");
})().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
