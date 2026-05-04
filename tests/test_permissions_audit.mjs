// E2E test for the new permission gates and audit log.
// - Menu: only admin can write (manager/receptionist/kitchen/waiter blocked)
// - Inventory: only admin/manager can write (receptionist/kitchen blocked)
// - Audit: admin-only listing, entries are written for the key actions

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
const H = (t) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

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
  if (cond) console.log(`  ✓ ${name}`);
  else { console.log(`  ✗ ${name} ${detail}`); failures.push(name); }
}

async function main() {
  console.log("\n=== Permissions + audit E2E ===\n");

  const admin = (await login("admin@flavorflow.dev", "admin123")).token;
  const manager = (await login("admin@flavorflow.dev", "admin123")).token; // no manager seeded; admin doubles up only if needed
  const reception = (await login("hina@flavorflow.dev", "password")).token;
  const waiter = (await login("bilal@flavorflow.dev", "password")).token;
  const kitchen = (await login("kashif@flavorflow.dev", "password")).token;

  // ─── Menu route gates ───
  const menuPick = await j("GET", "/api/menu/items?active=true", admin);
  const menuItem = (menuPick.data?.items ?? [])[0];

  const adminPatch = await j("PATCH", `/api/menu/items/${menuItem.id}`, admin, {
    description: "audit-test " + Date.now(),
  });
  check("admin can edit menu item (200)", adminPatch.status === 200,
    `(got ${adminPatch.status})`);

  const recPatch = await j("PATCH", `/api/menu/items/${menuItem.id}`, reception, {
    description: "blocked",
  });
  check("receptionist cannot edit menu (403)", recPatch.status === 403,
    `(got ${recPatch.status})`);

  const waiterPatch = await j("PATCH", `/api/menu/items/${menuItem.id}`, waiter, {
    description: "blocked",
  });
  check("waiter cannot edit menu (403)", waiterPatch.status === 403,
    `(got ${waiterPatch.status})`);

  const kitchenPatch = await j("PATCH", `/api/menu/items/${menuItem.id}`, kitchen, {
    description: "blocked",
  });
  check("kitchen cannot edit menu (403)", kitchenPatch.status === 403,
    `(got ${kitchenPatch.status})`);

  // ─── Inventory route gates ───
  const inv = await j("GET", "/api/inventory", admin);
  const ingr = (inv.data?.items ?? []).find((i) => i.category !== "Packaging") ?? inv.data?.items?.[0];

  const adminAdjust = await j("POST", `/api/inventory/${ingr.id}/adjust`, admin, {
    delta: 0.001,
    reason: "audit test",
  });
  check("admin can adjust inventory (200)", adminAdjust.status === 200,
    `(got ${adminAdjust.status})`);

  const recAdjust = await j("POST", `/api/inventory/${ingr.id}/adjust`, reception, {
    delta: 0.001,
  });
  check("receptionist cannot adjust inventory (403)", recAdjust.status === 403,
    `(got ${recAdjust.status})`);

  const kitchenAdjust = await j("POST", `/api/inventory/${ingr.id}/adjust`, kitchen, {
    delta: 0.001,
  });
  check("kitchen cannot adjust inventory (403)", kitchenAdjust.status === 403,
    `(got ${kitchenAdjust.status})`);

  // ─── Audit listing role gate ───
  const recAudit = await j("GET", "/api/audit", reception);
  check("receptionist cannot read audit log (403)", recAudit.status === 403,
    `(got ${recAudit.status})`);
  const waiterAudit = await j("GET", "/api/audit", waiter);
  check("waiter cannot read audit log (403)", waiterAudit.status === 403,
    `(got ${waiterAudit.status})`);

  // ─── Audit entries were written ───
  const adminAudit = await j("GET", "/api/audit?action=menu.&limit=300", admin);
  check("admin can read audit log (200)", adminAudit.status === 200,
    `(got ${adminAudit.status})`);
  const menuEntry = (adminAudit.data?.items ?? []).find(
    (e) => e.action === "menu.item.update" && e.targetId === menuItem.id
  );
  check("audit entry exists for the admin menu edit", !!menuEntry);
  if (menuEntry) {
    check("audit entry has userName=admin", menuEntry.userName?.toLowerCase().includes("gian") || menuEntry.userName === "Gian Baio",
      `(got ${menuEntry.userName})`);
    check("audit entry has before + after diffs",
      !!menuEntry.before && !!menuEntry.after);
  }

  const invAudit = await j("GET", `/api/audit?action=inventory.&limit=300`, admin);
  const invEntry = (invAudit.data?.items ?? []).find(
    (e) => e.action === "inventory.adjust" && e.targetId === ingr.id
  );
  check("audit entry exists for the inventory adjust", !!invEntry);
  if (invEntry) {
    check(
      "inventory audit captured stock delta",
      invEntry.after?.delta === 0.001 || Math.abs(invEntry.after?.delta - 0.001) < 1e-6,
      `(got delta=${invEntry.after?.delta})`
    );
  }

  // ─── Distinct actions endpoint ───
  const acts = await j("GET", "/api/audit/actions", admin);
  check("actions endpoint returns array", Array.isArray(acts.data?.actions));
  check(
    "actions list includes inventory + menu prefixes",
    (acts.data?.actions ?? []).some((a) => a.startsWith("menu.")) &&
      (acts.data?.actions ?? []).some((a) => a.startsWith("inventory.")),
    `(got ${(acts.data?.actions ?? []).slice(0, 5).join(",")})`
  );

  console.log(`\n=== ${failures.length === 0 ? "PASS" : "FAIL"} ===`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
