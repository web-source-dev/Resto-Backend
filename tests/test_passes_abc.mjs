// E2E for Passes A–C:
//   A: float rounding, BOM stock clamp, elapsedMin freeze
//   B: stockStatus recompute, KPI numeric shadow fields, prev-null on reports
//   C: pagination metadata, body-key tolerance on /append + /supplies

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
  console.log("\n=== Passes A–C E2E ===\n");
  const admin = (await login("admin@dinova.dev", "admin123")).token;
  const waiter = (await login("bilal@dinova.dev", "password")).token;

  // ──────────────────────────────────────────────
  // PASS A
  // ──────────────────────────────────────────────
  console.log("PASS A — rounding, clamp, elapsedMin freeze");

  // A1: float rounding via /adjust
  const inv = await j("GET", "/api/inventory", admin);
  const ing = (inv.data?.items ?? []).find((i) => i.unit === "kg");
  if (ing) {
    // Apply a deliberately-noisy delta. Result should be rounded to ≤4 dp.
    await j("POST", `/api/inventory/${ing.id}/adjust`, admin, {
      delta: 0.123456789,
    });
    const after = await j("GET", "/api/inventory", admin);
    const ingAfter = (after.data?.items ?? []).find((i) => i.id === ing.id);
    const dp = String(ingAfter.stock).split(".")[1]?.length ?? 0;
    check(
      "stock stored with at most 4 decimal places",
      dp <= 4,
      `(stored as ${ingAfter.stock} → ${dp}dp)`
    );
  }

  // A2: BOM clamp at zero. Pick any ingredient, drive it to 0, then place
  // an order whose recipe consumes it — stock must clamp at 0 (not negative).
  const negTarget = (inv.data?.items ?? []).find(
    (i) => i.unit === "kg" && (i.stock ?? 0) > 0 && i.category !== "Packaging" && i.category !== "Disposables" && i.category !== "Condiments"
  );
  if (negTarget) {
    // Force stock to a tiny positive number so any order tips it negative.
    await j("PATCH", `/api/inventory/${negTarget.id}`, admin, { stock: 0.0001 });
    // Find a menu item that uses this ingredient (use the test order to attempt).
    const menu = await j("GET", "/api/menu/items", admin);
    const using = (menu.data?.items ?? []).find((m) =>
      (m.recipe ?? []).some((r) => String(r.ingredientId) === String(negTarget.id))
    );
    if (using) {
      // Place an order. nextCode collisions in seed mean we may need retries.
      let create;
      for (let attempt = 0; attempt < 5; attempt++) {
        create = await j("POST", "/api/orders", admin, {
          channel: "Dine-in",
          items: [{ menuItemId: using.id, qty: 1 }],
          customerName: "QA Clamp",
        });
        if (create.status === 201) break;
      }
      const after = await j("GET", "/api/inventory", admin);
      const ingNow = (after.data?.items ?? []).find((i) => i.id === negTarget.id);
      check(
        "BOM consumption clamps at 0 (no negative stock)",
        (ingNow?.stock ?? 0) >= 0,
        `(now ${ingNow?.stock})`
      );
    }
  }

  // A3: elapsedMin freezes at readyAt. Find a Completed order — its
  // elapsedMin must NOT be larger than (readyAt - placedAt) in minutes.
  const completed = await j("GET", "/api/orders?status=Completed&limit=5", admin);
  const sample = (completed.data?.items ?? completed.data?.orders ?? []).find(
    (o) => o.readyAt && o.placedAt
  );
  if (sample) {
    const expected = Math.round(
      (new Date(sample.readyAt).getTime() -
        new Date(sample.acceptedAt ?? sample.placedAt).getTime()) /
        60000
    );
    check(
      "elapsedMin matches frozen (readyAt - acceptedAt)",
      Math.abs((sample.elapsedMin ?? 0) - expected) <= 1,
      `(elapsed=${sample.elapsedMin}, expected≈${expected})`
    );
  } else {
    console.log("  (no completed-with-readyAt order to sample — skipping A3)");
  }

  // ──────────────────────────────────────────────
  // PASS B
  // ──────────────────────────────────────────────
  console.log("\nPASS B — stockStatus recompute, KPI shadows, prev-null");

  // B1: KPI numeric shadow fields exist
  const overview = await j("GET", "/api/overview", admin);
  const kpis = overview.data?.kpis ?? {};
  check("kpis.otsSeconds is a number", typeof kpis.otsSeconds === "number",
    `(got ${typeof kpis.otsSeconds})`);
  check("kpis.activeTablesCount is a number", typeof kpis.activeTablesCount === "number");
  check("kpis.totalTables is a number", typeof kpis.totalTables === "number");
  check("legacy kpis.ots string still present", typeof kpis.ots === "string");

  // B2: prev series carries `prevAvailable` flag and uses null when empty
  const trend = await j("GET", "/api/reports/trend?range=7d", admin);
  check("trend response has prevAvailable bool",
    typeof trend.data?.prevAvailable === "boolean");
  // First trend row's `prev` is either a number (if available) or null.
  const firstRow = (trend.data?.trend ?? [])[0];
  if (firstRow) {
    check(
      "trend rows: prev is number-or-null",
      firstRow.prev === null || typeof firstRow.prev === "number",
      `(got ${firstRow.prev} of type ${typeof firstRow.prev})`
    );
    if (!trend.data?.prevAvailable) {
      check("when prev unavailable, prev is null on each row", firstRow.prev === null);
    }
  }

  // B3: stockStatus recompute. Find a menu item; check current stockStatus
  // vs the truth about its recipe ingredients.
  const menuAll = await j("GET", "/api/menu/items", admin);
  const invAll = await j("GET", "/api/inventory", admin);
  const ingMap = new Map((invAll.data?.items ?? []).map((i) => [i.id, i]));
  const m = (menuAll.data?.items ?? []).find((mi) => (mi.recipe ?? []).length > 0);
  if (m) {
    let truth = "OK";
    for (const r of m.recipe ?? []) {
      const ig = ingMap.get(r.ingredientId);
      if (!ig) continue;
      if ((ig.stock ?? 0) <= 0) { truth = "Out"; break; }
      if ((ig.stock ?? 0) < (ig.par ?? 0)) truth = "Low";
    }
    check(
      `menu '${m.name}' stockStatus matches recipe truth (${truth})`,
      m.stockStatus === truth,
      `(stored=${m.stockStatus}, derived=${truth})`
    );
  }

  // ──────────────────────────────────────────────
  // PASS C
  // ──────────────────────────────────────────────
  console.log("\nPASS C — pagination metadata + body-key tolerance");

  // C1: /api/orders returns total + hasMore + items + legacy `orders`
  const ordList = await j("GET", "/api/orders?limit=5", admin);
  check("orders response has `items` array", Array.isArray(ordList.data?.items));
  check("orders response has legacy `orders` array", Array.isArray(ordList.data?.orders));
  check("orders response has total (number)", typeof ordList.data?.total === "number");
  check("orders response has hasMore (bool)", typeof ordList.data?.hasMore === "boolean");
  check(
    "orders limit honoured",
    (ordList.data?.items ?? []).length <= 5,
    `(returned ${(ordList.data?.items ?? []).length})`
  );
  check(
    "orders.hasMore=true when total > limit",
    !ordList.data?.hasMore || (ordList.data?.total ?? 0) > 5
  );

  // C2: /api/audit pagination + skip
  const auditA = await j("GET", "/api/audit?limit=3", admin);
  check("audit returns 3 items + total", auditA.data?.items?.length <= 3 && typeof auditA.data?.total === "number");
  if ((auditA.data?.total ?? 0) > 3) {
    const auditB = await j("GET", "/api/audit?limit=3&skip=3", admin);
    const idsA = new Set((auditA.data?.items ?? []).map((it) => it.id));
    const idsB = new Set((auditB.data?.items ?? []).map((it) => it.id));
    const overlap = [...idsA].filter((x) => idsB.has(x)).length;
    check("audit skip pages disjoint", overlap === 0, `(${overlap} overlap)`);
  }

  // C3: /api/notifications has total + hasMore + unread
  const noti = await j("GET", "/api/notifications?limit=5", admin);
  check("notifications has total", typeof noti.data?.total === "number");
  check("notifications has unread", typeof noti.data?.unread === "number");
  check("notifications has hasMore", typeof noti.data?.hasMore === "boolean");

  // C4: body-key tolerance on /append. POST `supplies` instead of `items`
  // — should still create the order line.
  const menuItems = await j("GET", "/api/menu/items?active=true", admin);
  const item = menuItems.data?.items?.[0];
  let create;
  for (let attempt = 0; attempt < 5; attempt++) {
    create = await j("POST", "/api/orders", admin, {
      channel: "Dine-in",
      items: [{ menuItemId: item.id, qty: 1 }],
      customerName: "QA BodyKey",
    });
    if (create.status === 201) break;
  }
  if (create?.status === 201) {
    const oid = create.data.order.id;
    // Send the WRONG key — should still work after our tolerance fix.
    const append = await j("POST", `/api/orders/${oid}/append`, waiter, {
      supplies: [{ menuItemId: item.id, qty: 1 }], // wrong key on purpose
    });
    check("/append accepts `supplies` body key (201)", append.status === 201,
      `(got ${append.status})`);
    check(
      "appended item appears even with wrong body key",
      (append.data?.order?.items ?? []).length > 1
    );

    // Same for /supplies — send `items` instead of `supplies`.
    const napkin = (await j("GET", "/api/inventory", admin)).data.items.find(
      (i) => /napkin/i.test(i.name)
    );
    if (napkin) {
      const sup = await j("POST", `/api/orders/${oid}/supplies`, waiter, {
        items: [{ ingredientId: napkin.id, qty: 1 }], // wrong key on purpose
      });
      check("/supplies accepts `items` body key (200)", sup.status === 200,
        `(got ${sup.status})`);
    }
  }

  console.log(`\n=== ${failures.length === 0 ? "PASS" : "FAIL"} ===`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
