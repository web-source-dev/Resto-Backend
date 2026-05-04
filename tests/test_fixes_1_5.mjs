// E2E for the 5 hardening fixes:
//   #1 rider lockdown (channel scoping + cross-cutting reads + write gates)
//   #2 Mongoose CastError + ValidationError → 400
//   #3 forwardAddendum promotes Pending parent
//   #4 deliveryFailed releases the rider
//   #5 paymentCollected on non-COD → 400

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
  console.log("\n=== Fixes #1–#5 E2E ===\n");

  const admin = (await login("admin@flavorflow.dev", "admin123")).token;
  const rider = (await login("rider@flavorflow.dev", "password")).token;
  const reception = (await login("hina@flavorflow.dev", "password")).token;
  const kitchen = (await login("kashif@flavorflow.dev", "password")).token;

  // ────────────────────────────────────────────────────────────────────
  // #1 — Rider lockdown
  // ────────────────────────────────────────────────────────────────────
  console.log("#1 — Rider lockdown");

  // 1a. Listing orders shows only Delivery channel + claimable/own.
  const list = await j("GET", "/api/orders?limit=10000", rider);
  const channels = new Set((list.data?.orders ?? []).map((o) => o.channel));
  check("rider listing only contains Delivery", channels.size === 1 && channels.has("Delivery"),
    `(saw ${[...channels].join(",")})`);

  // 1b. Channel-override attempt is ignored.
  const tryDinein = await j("GET", "/api/orders?channel=Dine-in&limit=100", rider);
  const overrideChannels = new Set((tryDinein.data?.orders ?? []).map((o) => o.channel));
  check(
    "rider cannot override channel param",
    !overrideChannels.has("Dine-in") && !overrideChannels.has("Takeaway"),
    `(got ${[...overrideChannels].join(",")})`
  );

  // 1c. GET on a Dine-in id directly → 404.
  const dineinList = await j("GET", "/api/orders?channel=Dine-in&limit=1", admin);
  const dineinId = dineinList.data?.orders?.[0]?.id;
  if (dineinId) {
    const stolen = await j("GET", `/api/orders/${dineinId}`, rider);
    check("rider GET dine-in order id → 404", stolen.status === 404, `(got ${stolen.status})`);
  }

  // 1d. POST /api/orders → 403.
  const create = await j("POST", "/api/orders", rider, {
    channel: "Phone",
    items: [],
    customerName: "QA",
  });
  check("rider POST /api/orders → 403", create.status === 403, `(got ${create.status})`);

  // 1e. POST /api/orders/:id/transition → 403.
  const transit = await j("POST", `/api/orders/${dineinId}/transition`, rider, { to: "Cancelled" });
  check("rider transition → 403", transit.status === 403, `(got ${transit.status})`);

  // 1f. Cross-cutting reads all 403.
  for (const path of [
    "/api/customers",
    "/api/staff",
    "/api/expenses",
    "/api/suppliers",
    "/api/anomalies",
    "/api/wastage",
    "/api/overview",
    "/api/tables",
    "/api/inventory",
  ]) {
    const r = await j("GET", path, rider);
    check(`rider GET ${path} → 403`, r.status === 403, `(got ${r.status})`);
  }

  // ────────────────────────────────────────────────────────────────────
  // #2 — Mongoose error mapping
  // ────────────────────────────────────────────────────────────────────
  console.log("\n#2 — Error mapping");

  const cast = await j("GET", "/api/orders/notarealid", admin);
  check("invalid ObjectId → 400 (was 500)", cast.status === 400, `(got ${cast.status})`);
  check(
    "CastError message is friendly",
    typeof cast.data?.error === "string" &&
      !cast.data.error.includes("Cast to ObjectId") &&
      cast.data.error.toLowerCase().includes("invalid"),
    `(got "${cast.data?.error}")`
  );

  const enumErr = await j("POST", "/api/wastage", admin, {
    itemName: "Test",
    qty: 1,
    unit: "g",
    reason: "this is not a valid enum value",
  });
  check("Mongoose enum violation → 400 (was 500)", enumErr.status === 400, `(got ${enumErr.status})`);
  check(
    "enum error message names the field",
    typeof enumErr.data?.error === "string" &&
      enumErr.data.error.toLowerCase().includes("reason"),
    `(got "${enumErr.data?.error}")`
  );

  // ────────────────────────────────────────────────────────────────────
  // #3 — forwardAddendum promotes Pending → Queued
  // ────────────────────────────────────────────────────────────────────
  console.log("\n#3 — forwardAddendum promotes Pending");

  // Place a QR order on T-08 (status starts "Pending")
  const menu = await fetch(`${BASE}/api/qr/menu/T-08`).then((r) => r.json());
  const itemA = menu.items[0];
  const itemB = menu.items[1];
  const qr = await fetch(`${BASE}/api/qr/orders/T-08`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customerName: "QA Pending",
      items: [{ menuItemId: itemA.id, qty: 1 }],
    }),
  }).then((r) => r.json());
  const pid = qr.order.id;
  check("QR order initial status = Pending", qr.order.status === "Pending");

  // Customer adds an item before reception reviews
  await fetch(`${BASE}/api/qr/orders/${pid}/append`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ menuItemId: itemB.id, qty: 1 }] }),
  });

  // Reception forwards the addendum
  const fwd = await j("POST", `/api/orders/${pid}/forward-addendum`, reception);
  check("forward-addendum success", fwd.status === 200, `(got ${fwd.status})`);
  check(
    "parent order promoted from Pending → Queued",
    fwd.data?.order?.status === "Queued",
    `(status now ${fwd.data?.order?.status})`
  );

  // ────────────────────────────────────────────────────────────────────
  // #4 — deliveryFailed releases rider
  // ────────────────────────────────────────────────────────────────────
  console.log("\n#4 — deliveryFailed releases rider");

  // Set up: find a Ready Delivery order, assign our rider, mark picked up,
  // then fail it. Rider should be free to claim again afterward.
  const allRiders = await j("GET", "/api/staff?role=rider", admin);
  const riderId = (allRiders.data?.staff ?? []).find((u) => u.email === "rider@flavorflow.dev")?.id;
  // Find any Delivery order that's Ready or that we can drive to Ready
  const deliveries = await j("GET", "/api/orders?channel=Delivery&active=true&limit=50", admin);
  let target = (deliveries.data?.orders ?? []).find((o) => o.status === "Ready" && !o.riderId);
  if (!target) {
    // Drive one through manually
    const queued = (deliveries.data?.orders ?? []).find((o) => o.status === "Queued");
    if (queued) {
      await j("POST", `/api/orders/${queued.id}/transition`, admin, { to: "In Progress" });
      const r = await j("POST", `/api/orders/${queued.id}/transition`, admin, { to: "Ready" });
      target = r.data?.order;
    }
  }
  if (!target) {
    console.log("  (could not find a Ready delivery to test against — skipping #4)");
  } else {
    await j("POST", "/api/delivery/assign", admin, {
      orderId: target.id,
      riderId,
    });
    await j("POST", `/api/delivery/orders/${target.id}/pickup`, rider);
    const fail = await j("POST", `/api/delivery/orders/${target.id}/fail`, rider, {
      reason: "Customer not reachable",
    });
    check("deliveryFailed returns 200", fail.status === 200, `(got ${fail.status})`);
    check(
      "failed order's riderId cleared",
      !fail.data?.order?.riderId,
      `(riderId=${fail.data?.order?.riderId})`
    );
    check(
      "failed order's status reset to Ready",
      fail.data?.order?.status === "Ready",
      `(status=${fail.data?.order?.status})`
    );

    // Rider can now claim a fresh delivery
    const myAssign = await j("GET", "/api/delivery/my-assignment", rider);
    check(
      "rider has no active assignment after fail",
      !myAssign.data?.assignment || myAssign.data?.assignment === null,
      `(got ${JSON.stringify(myAssign.data?.assignment)})`
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // #5 — paymentCollected on non-COD
  // ────────────────────────────────────────────────────────────────────
  console.log("\n#5 — paymentCollected on non-COD");

  // Free the rider from any stuck/leftover assignments before this leg.
  // Pre-pickup orders → unassign. Post-pickup (Served) → mark failed (which
  // now clears the rider via fix #4) so the rider can claim again.
  const stuckList = await j(
    "GET",
    `/api/orders?channel=Delivery&limit=200`,
    admin
  );
  const stuck = (stuckList.data?.orders ?? []).filter(
    (o) =>
      String(o.riderId ?? "") === String(riderId) &&
      ["Ready", "Served"].includes(o.status) &&
      !o.deliveredAt
  );
  for (const s of stuck) {
    if (s.status === "Served") {
      await j("POST", `/api/delivery/orders/${s.id}/fail`, rider, {
        reason: "QA cleanup",
      });
    } else {
      await j("POST", "/api/delivery/unassign", admin, { orderId: s.id });
    }
  }

  // Create a non-COD delivery order, drive it to Served, then try to mark
  // delivered with paymentCollected:true → should 400.
  let create2;
  for (let attempt = 0; attempt < 5; attempt++) {
    create2 = await j("POST", "/api/orders", admin, {
      channel: "Delivery",
      items: [{ menuItemId: itemA.id, qty: 1 }],
      customerName: "QA Non-COD",
      customerPhone: "+92 300 9999992",
      deliveryAddress: "1 QA Street, Lahore",
      cashOnDelivery: false,
    });
    if (create2.status === 201) break;
  }
  check("non-COD delivery order created", create2.status === 201, `(got ${create2.status})`);
  if (create2.status === 201) {
    const oid = create2.data.order.id;
    // Drive through the kitchen states first, THEN assign — assign requires
    // status in {Ready, Served-not-pickedUp} per canAssignOrClaimRider.
    await j("POST", `/api/orders/${oid}/transition`, admin, { to: "In Progress" });
    await j("POST", `/api/orders/${oid}/transition`, admin, { to: "Ready" });
    const assigned = await j("POST", "/api/delivery/assign", admin, { orderId: oid, riderId });
    check("rider assigned to non-COD test order", assigned.status === 200,
      `(got ${assigned.status} ${assigned.data?.error})`);
    const pick = await j("POST", `/api/delivery/orders/${oid}/pickup`, rider);
    check("rider picked up non-COD test order", pick.status === 200,
      `(got ${pick.status} ${pick.data?.error})`);

    const wrongCOD = await j("POST", `/api/delivery/orders/${oid}/delivered`, rider, {
      paymentCollected: true,
    });
    check(
      "paymentCollected on non-COD → 400",
      wrongCOD.status === 400,
      `(got ${wrongCOD.status} ${wrongCOD.data?.error})`
    );
    check(
      "rejection message mentions COD",
      typeof wrongCOD.data?.error === "string" &&
        wrongCOD.data.error.toLowerCase().includes("cash"),
      `(got "${wrongCOD.data?.error}")`
    );

    // Without the flag, delivery completes fine.
    const ok = await j("POST", `/api/delivery/orders/${oid}/delivered`, rider, {});
    check("delivery succeeds without paymentCollected", ok.status === 200, `(got ${ok.status})`);
  }

  console.log(`\n=== ${failures.length === 0 ? "PASS" : "FAIL"} ===`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
