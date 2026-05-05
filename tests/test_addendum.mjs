// E2E test for the addendum / item-cancel / paid-bill-reopen flows.
//
// Run: node tests/test_addendum.mjs
// Prereqs: backend on :4000, seeded DB.

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
  console.log("\n=== Addendum / cancel / reopen E2E ===\n");

  // Logins for the role permutations we need.
  const admin = (await login("admin@dinova.dev", "admin123")).token;
  const reception = (await login("hina@dinova.dev", "password")).token;
  const waiter = (await login("bilal@dinova.dev", "password")).token;
  const kitchen = (await login("kashif@dinova.dev", "password")).token;

  // Pick two menu items to add. Filter to active items so we don't get a
  // disabled one with no recipe stock available.
  const menu = await j("GET", "/api/menu/items?active=true", admin);
  const items = (menu.data?.items ?? []).slice(0, 2);
  if (items.length < 2) {
    throw new Error("Need at least 2 active menu items in seed");
  }
  const [a, b] = items;
  console.log(`Using menu items: ${a.name} (Rs ${a.price}), ${b.name} (Rs ${b.price})\n`);

  // ─── 1. Create a base order with one line item via the staff route ───
  // The seed inserts historical demo orders out-of-order, so nextCode() can
  // briefly collide (pre-existing bug, not part of this change). Retry a few
  // times — counter advances on every attempt.
  let create;
  for (let attempt = 0; attempt < 5; attempt++) {
    create = await j("POST", "/api/orders", admin, {
      channel: "Dine-in",
      items: [{ menuItemId: a.id, qty: 1 }],
      customerName: "E2E Guest",
    });
    if (create.status === 201) break;
  }
  check("base order created (201)", create.status === 201, `(got ${create.status})`);
  const orderId = create.data?.order?.id;
  const baseTotal = create.data?.order?.total ?? 0;
  console.log(`  base order id=${orderId}  total=Rs ${baseTotal}`);

  // ─── 2. Role gate: kitchen cannot append ───
  const kitchenAppend = await j("POST", `/api/orders/${orderId}/append`, kitchen, {
    items: [{ menuItemId: b.id, qty: 1 }],
  });
  check("kitchen cannot append (403)", kitchenAppend.status === 403,
    `(got ${kitchenAppend.status})`);

  // ─── 3. Waiter appends — items go straight to Queued ───
  const append = await j("POST", `/api/orders/${orderId}/append`, waiter, {
    items: [{ menuItemId: b.id, qty: 2 }],
  });
  check("waiter append (201)", append.status === 201, `(got ${append.status})`);
  const o1 = append.data?.order;
  const appendedItems = (o1?.items ?? []).filter((i) => i.addendum === true);
  check("appended item flagged addendum=true", appendedItems.length === 1);
  check(
    "appended item status=Queued (skipped review queue)",
    appendedItems[0]?.status === "Queued",
    `(got ${appendedItems[0]?.status})`
  );
  check(
    "order total increased",
    (o1?.total ?? 0) > baseTotal,
    `(was ${baseTotal}, now ${o1?.total})`
  );
  check(
    "appended item has eta set",
    !!appendedItems[0]?.eta,
    `(got ${appendedItems[0]?.eta})`
  );

  // ─── 4. Role gate: waiter cannot cancel an item ───
  const itemBId = appendedItems[0].id ?? appendedItems[0]._id;
  const waiterCancel = await j(
    "POST",
    `/api/orders/${orderId}/items/${itemBId}/cancel`,
    waiter,
    { reason: "guest changed mind" }
  );
  check("waiter cannot cancel (403)", waiterCancel.status === 403,
    `(got ${waiterCancel.status})`);

  // ─── 5. Reception cancels the appended item ───
  const cancel = await j(
    "POST",
    `/api/orders/${orderId}/items/${itemBId}/cancel`,
    reception,
    { reason: "guest changed mind" }
  );
  check("reception cancel item (200)", cancel.status === 200, `(got ${cancel.status})`);
  const o2 = cancel.data?.order;
  const cancelled = (o2?.items ?? []).find((i) => String(i.id ?? i._id) === String(itemBId));
  check("cancelled item status=Cancelled", cancelled?.status === "Cancelled",
    `(got ${cancelled?.status})`);
  check(
    "order total dropped back",
    Math.abs((o2?.total ?? 0) - baseTotal) < 1,
    `(now ${o2?.total}, base was ${baseTotal})`
  );

  // ─── 5b. Once kitchen is cooking, cancel must be rejected ───
  // Append a fresh line, transition the order to In Progress so all
  // unfinished items flip to In Progress, then try to cancel — expect 409.
  const append2 = await j("POST", `/api/orders/${orderId}/append`, waiter, {
    items: [{ menuItemId: b.id, qty: 1 }],
  });
  check("waiter append #2 (201)", append2.status === 201, `(got ${append2.status})`);
  const newLine = (append2.data?.order?.items ?? [])
    .filter((i) => i.addendum && i.status !== "Cancelled")
    .pop();
  const newLineId = newLine?.id ?? newLine?._id;
  await j("POST", `/api/orders/${orderId}/transition`, admin, { to: "In Progress" });
  const cancelInProgress = await j(
    "POST",
    `/api/orders/${orderId}/items/${newLineId}/cancel`,
    reception,
    { reason: "guest changed mind" }
  );
  check(
    "in-progress item cannot be cancelled (409)",
    cancelInProgress.status === 409,
    `(got ${cancelInProgress.status}: ${cancelInProgress.data?.error})`
  );
  check(
    "error message tells staff to add a new item instead",
    String(cancelInProgress.data?.error ?? "")
      .toLowerCase()
      .includes("being prepared"),
    `(got ${cancelInProgress.data?.error})`
  );

  // ─── 6. Cannot double-cancel ───
  const reCancel = await j(
    "POST",
    `/api/orders/${orderId}/items/${itemBId}/cancel`,
    reception,
    {}
  );
  check("re-cancelling same item is 409", reCancel.status === 409,
    `(got ${reCancel.status})`);

  // ─── 7. Pay the order, then append again — bill must reopen ───
  const pay = await j("POST", `/api/orders/${orderId}/pay`, admin, { method: "Cash" });
  check("pay returns 200", pay.status === 200, `(got ${pay.status})`);
  const paid = pay.data?.order;
  check("paymentStatus=Paid after pay", paid?.paymentStatus === "Paid",
    `(got ${paid?.paymentStatus})`);
  check(
    "paidAmount snapshotted to total",
    paid?.paidAmount === paid?.total,
    `(paidAmount=${paid?.paidAmount}, total=${paid?.total})`
  );
  const paidTotal = paid?.total ?? 0;

  const reopen = await j("POST", `/api/orders/${orderId}/append`, reception, {
    items: [{ menuItemId: a.id, qty: 1 }],
  });
  check("post-paid append (201)", reopen.status === 201, `(got ${reopen.status})`);
  const o3 = reopen.data?.order;
  check("paymentStatus reverted to Pending", o3?.paymentStatus === "Pending",
    `(got ${o3?.paymentStatus})`);
  check(
    "paidAmount preserved across reopen",
    o3?.paidAmount === paidTotal,
    `(paidAmount=${o3?.paidAmount}, was ${paidTotal})`
  );
  check(
    "balanceDue exposes outstanding amount",
    o3?.balanceDue > 0 && o3?.balanceDue === o3?.total - o3?.paidAmount,
    `(balanceDue=${o3?.balanceDue}, total=${o3?.total}, paid=${o3?.paidAmount})`
  );

  // ─── 8. Cannot append to a Cancelled/Completed order ───
  await j("POST", `/api/orders/${orderId}/transition`, admin, { to: "Cancelled" });
  const appendDead = await j("POST", `/api/orders/${orderId}/append`, reception, {
    items: [{ menuItemId: a.id, qty: 1 }],
  });
  check("cannot append to cancelled order (409)", appendDead.status === 409,
    `(got ${appendDead.status})`);

  console.log(`\n=== ${failures.length === 0 ? "PASS" : "FAIL"} ===`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
