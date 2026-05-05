// E2E test for the notifications role gate.
//
// Verifies: when a wastage event fires (target: admin/manager), only admin
// sees the new notification through GET /api/notifications. Kitchen, waiter,
// and rider must NOT see it. The realtime + push channels use the same target
// object as the REST list, so this REST-level assertion proves the unified
// targeting logic is correct.
//
// Run:  node tests/test_notifications.mjs
// Prereqs: backend running on :4000, DB seeded (npm run seed).

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
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function j(method, path, token, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: H(token),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await r.json();
  } catch {}
  return { status: r.status, data };
}

function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name} ${detail}`);
    failures.push(name);
  }
}

async function unread(token) {
  const { data } = await j("GET", "/api/notifications?unread=true&limit=50", token);
  return {
    count: data?.unread ?? 0,
    items: data?.items ?? [],
  };
}

async function main() {
  console.log("\n=== Notifications role-gate E2E ===\n");

  // 1. Login one user per role we need to assert against.
  const admin = (await login("admin@dinova.dev", "admin123")).token;
  const kitchen = (await login("kashif@dinova.dev", "password")).token;
  const waiter = (await login("bilal@dinova.dev", "password")).token;
  const rider = (await login("rider@dinova.dev", "password")).token;
  console.log("Logged in: admin, kitchen, waiter, rider\n");

  // 2. Snapshot baseline unread count per role.
  const before = {
    admin: await unread(admin),
    kitchen: await unread(kitchen),
    waiter: await unread(waiter),
    rider: await unread(rider),
  };
  console.log(
    `Baseline unread — admin:${before.admin.count}  kitchen:${before.kitchen.count}  waiter:${before.waiter.count}  rider:${before.rider.count}\n`
  );

  // 3. Trigger a wastage event AS the kitchen user. The route is open to any
  //    authenticated user but notify() targets admin+manager.
  //    Cost > 500 forces level=warn (`needs approval`) so it's distinct.
  const tag = `e2e-${Date.now()}`;
  const post = await j("POST", "/api/wastage", kitchen, {
    itemName: tag,
    qty: 9999, // big qty so the auto-cost path may push it over 500 if ingredient set, otherwise still creates the log
    unit: "g",
    reason: "Spoiled", // must match Wastage.ts enum
  });
  check("wastage POST 201", post.status === 201, `(got ${post.status})`);

  // Give the notify() write + socket emit a tick to settle.
  await new Promise((r) => setTimeout(r, 300));

  // 4. Re-fetch unread per role.
  const after = {
    admin: await unread(admin),
    kitchen: await unread(kitchen),
    waiter: await unread(waiter),
    rider: await unread(rider),
  };
  console.log(
    `After   unread — admin:${after.admin.count}  kitchen:${after.kitchen.count}  waiter:${after.waiter.count}  rider:${after.rider.count}\n`
  );

  // 5. Role-gate assertions.
  const adminDelta = after.admin.count - before.admin.count;
  check(
    "admin received the wastage notification",
    adminDelta >= 1,
    `(delta ${adminDelta})`
  );
  check(
    "kitchen did NOT receive the wastage notification",
    after.kitchen.count === before.kitchen.count,
    `(delta ${after.kitchen.count - before.kitchen.count})`
  );
  check(
    "waiter did NOT receive the wastage notification",
    after.waiter.count === before.waiter.count,
    `(delta ${after.waiter.count - before.waiter.count})`
  );
  check(
    "rider did NOT receive the wastage notification",
    after.rider.count === before.rider.count,
    `(delta ${after.rider.count - before.rider.count})`
  );

  // 6. Verify the actual notification doc is the wastage one (not some other concurrent event).
  //    The notification title contains the itemName (our `tag`), so match on title.
  const adminTop = after.admin.items.find(
    (n) => (n.title ?? "").includes(tag) || (n.body ?? "").includes(tag)
  );
  check("admin's feed contains a doc tagged with our test name", !!adminTop);
  if (adminTop) {
    check(
      "wastage doc has type=wastage.new",
      adminTop.type === "wastage.new",
      `(got ${adminTop.type})`
    );
    check(
      "wastage doc targets admin/manager only",
      Array.isArray(adminTop.targetRoles) &&
        adminTop.targetRoles.includes("admin") &&
        adminTop.targetRoles.includes("manager") &&
        !adminTop.targetRoles.includes("kitchen") &&
        !adminTop.targetRoles.includes("waiter") &&
        !adminTop.targetRoles.includes("rider"),
      `(got ${JSON.stringify(adminTop.targetRoles)})`
    );
  }

  // 7. Cross-check: kitchen's feed must NOT contain the test doc even if other notifications exist.
  const kitchenLeak = after.kitchen.items.find(
    (n) => (n.title ?? "").includes(tag) || (n.body ?? "").includes(tag)
  );
  check("kitchen feed does NOT contain the wastage doc (REST role gate)", !kitchenLeak);

  // 8. Mark-read role gate: kitchen tries to mark admin's notification as read — should be a no-op.
  if (adminTop) {
    await j("POST", "/api/notifications/read", kitchen, { ids: [adminTop.id] });
    const adminAfterMark = await unread(admin);
    const stillUnread = adminAfterMark.items.some((n) => n.id === adminTop.id);
    check(
      "kitchen cannot mark admin's notification as read",
      stillUnread,
      "(admin's notification was wrongly marked read by another role)"
    );
  }

  console.log(`\n=== ${failures.length === 0 ? "PASS" : "FAIL"} ===`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
