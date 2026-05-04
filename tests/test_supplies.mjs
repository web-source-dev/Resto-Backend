// E2E test for the supplies tracking flow.
// Verifies: stock deduction, denormalized supplies array on order,
// stock-out 409, role gates, suppliesCost virtual.
//
// Prereqs: backend on :4000, seed run, supplies populated
// (node tests/setup_supplies.mjs once).

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
  console.log("\n=== Supplies tracking E2E ===\n");

  const admin = (await login("admin@flavorflow.dev", "admin123")).token;
  const waiter = (await login("bilal@flavorflow.dev", "password")).token;
  const kitchen = (await login("kashif@flavorflow.dev", "password")).token;

  // Find a Packaging and a Disposables ingredient.
  const inv = await j("GET", "/api/inventory", admin);
  const napkin = (inv.data?.items ?? []).find(
    (i) => i.category === "Disposables" && /napkin/i.test(i.name)
  );
  const box = (inv.data?.items ?? []).find(
    (i) => i.category === "Packaging" && /takeaway box/i.test(i.name)
  );
  if (!napkin || !box) {
    throw new Error("Run `node tests/setup_supplies.mjs` first to seed supply ingredients");
  }
  console.log(`Using: ${napkin.name} (stock ${napkin.stock}) + ${box.name} (stock ${box.stock})\n`);
  const napkinBefore = napkin.stock ?? 0;
  const boxBefore = box.stock ?? 0;

  // Create a base order (retry past nextCode collision).
  let create;
  const menu = await j("GET", "/api/menu/items?active=true", admin);
  const item = (menu.data?.items ?? [])[0];
  for (let attempt = 0; attempt < 5; attempt++) {
    create = await j("POST", "/api/orders", admin, {
      channel: "Dine-in",
      items: [{ menuItemId: item.id, qty: 1 }],
      customerName: "E2E Supplies",
    });
    if (create.status === 201) break;
  }
  check("base order created (201)", create.status === 201);
  const orderId = create.data?.order?.id;

  // ─── 1. Kitchen role can't log supplies (front-of-house concern) ───
  const kitchenLog = await j("POST", `/api/orders/${orderId}/supplies`, kitchen, {
    supplies: [{ ingredientId: napkin.id, qty: 2 }],
  });
  check("kitchen cannot log supplies (403)", kitchenLog.status === 403,
    `(got ${kitchenLog.status})`);

  // ─── 2. Waiter logs 3 napkins + 1 box ───
  const log = await j("POST", `/api/orders/${orderId}/supplies`, waiter, {
    supplies: [
      { ingredientId: napkin.id, qty: 3 },
      { ingredientId: box.id, qty: 1 },
    ],
  });
  check("waiter log supplies (200)", log.status === 200, `(got ${log.status})`);
  const o1 = log.data?.order;
  check("order.supplies array has both lines", (o1?.supplies ?? []).length === 2);
  const napkinLog = (o1?.supplies ?? []).find((s) => s.name === napkin.name);
  check("napkin line has qty=3", napkinLog?.qty === 3);
  check("napkin line snapshotted name + unit", napkinLog?.unit === napkin.unit);
  check("napkin line snapshotted costPerUnit", napkinLog?.costPerUnit === napkin.costPerUnit);
  const expectedCost = 3 * napkin.costPerUnit + 1 * box.costPerUnit;
  check(
    "suppliesCost virtual sums correctly",
    Math.abs((o1?.suppliesCost ?? 0) - expectedCost) < 0.01,
    `(got ${o1?.suppliesCost}, expected ${expectedCost})`
  );

  // ─── 3. Inventory was actually deducted ───
  const invAfter = await j("GET", "/api/inventory", admin);
  const napkinAfter = (invAfter.data?.items ?? []).find((i) => i.id === napkin.id);
  const boxAfter = (invAfter.data?.items ?? []).find((i) => i.id === box.id);
  check(
    "napkin stock dropped by 3",
    Math.abs((napkinAfter?.stock ?? 0) - (napkinBefore - 3)) < 0.01,
    `(was ${napkinBefore}, now ${napkinAfter?.stock})`
  );
  check(
    "box stock dropped by 1",
    Math.abs((boxAfter?.stock ?? 0) - (boxBefore - 1)) < 0.01,
    `(was ${boxBefore}, now ${boxAfter?.stock})`
  );

  // ─── 4. Stock-out is rejected before any deduction ───
  const huge = await j("POST", `/api/orders/${orderId}/supplies`, waiter, {
    supplies: [{ ingredientId: napkin.id, qty: 999999 }],
  });
  check("over-stock request rejected (409)", huge.status === 409,
    `(got ${huge.status})`);
  check(
    "error message names the offending supply",
    String(huge.data?.error ?? "").toLowerCase().includes(napkin.name.toLowerCase()),
    `(got ${huge.data?.error})`
  );

  // ─── 5. Inventory unchanged after rejection ───
  const invFinal = await j("GET", "/api/inventory", admin);
  const napkinFinal = (invFinal.data?.items ?? []).find((i) => i.id === napkin.id);
  check(
    "napkin stock unchanged after rejected request",
    Math.abs((napkinFinal?.stock ?? 0) - (napkinAfter?.stock ?? 0)) < 0.01,
    `(was ${napkinAfter?.stock}, now ${napkinFinal?.stock})`
  );

  // ─── 6. Empty supplies[] is rejected ───
  const empty = await j("POST", `/api/orders/${orderId}/supplies`, waiter, { supplies: [] });
  check("empty supplies[] rejected (400)", empty.status === 400,
    `(got ${empty.status})`);

  console.log(`\n=== ${failures.length === 0 ? "PASS" : "FAIL"} ===`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
