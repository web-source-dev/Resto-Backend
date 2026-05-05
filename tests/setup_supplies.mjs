// Idempotently adds the supply ingredients (packaging / disposables /
// condiments) to the running outlet without wiping existing data. Safe to
// re-run — any SKU that already exists is skipped.
//
// Run: node tests/setup_supplies.mjs

const BASE = "http://localhost:4000";

const supplies = [
  { sku: "BOX-S-101", name: "Takeaway box (small)", category: "Packaging", unit: "pcs", stock: 480, par: 200, costPerUnit: 13 },
  { sku: "BOX-L-102", name: "Takeaway box (large)", category: "Packaging", unit: "pcs", stock: 320, par: 150, costPerUnit: 22 },
  { sku: "FOIL-103", name: "Foil tray", category: "Packaging", unit: "pcs", stock: 240, par: 100, costPerUnit: 18 },
  { sku: "BAG-104", name: "Paper bag (delivery)", category: "Packaging", unit: "pcs", stock: 600, par: 250, costPerUnit: 9 },
  { sku: "NAP-201", name: "Paper napkin", category: "Disposables", unit: "pcs", stock: 4200, par: 2000, costPerUnit: 1.5 },
  { sku: "TIS-202", name: "Tissue paper roll", category: "Disposables", unit: "pcs", stock: 60, par: 30, costPerUnit: 95 },
  { sku: "SPN-203", name: "Plastic spoon", category: "Disposables", unit: "pcs", stock: 1100, par: 500, costPerUnit: 2 },
  { sku: "FRK-204", name: "Plastic fork", category: "Disposables", unit: "pcs", stock: 950, par: 500, costPerUnit: 2 },
  { sku: "STR-205", name: "Plastic straw", category: "Disposables", unit: "pcs", stock: 1800, par: 800, costPerUnit: 1 },
  { sku: "KET-301", name: "Ketchup sachet", category: "Condiments", unit: "pcs", stock: 2400, par: 1000, costPerUnit: 4 },
  { sku: "MAY-302", name: "Mayo sachet", category: "Condiments", unit: "pcs", stock: 1600, par: 800, costPerUnit: 5 },
  { sku: "CHL-303", name: "Chilli sauce sachet", category: "Condiments", unit: "pcs", stock: 1200, par: 600, costPerUnit: 5 },
  { sku: "SLT-304", name: "Salt sachet", category: "Condiments", unit: "pcs", stock: 2000, par: 800, costPerUnit: 0.5 },
];

async function main() {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@dinova.dev", password: "admin123" }),
  }).then((r) => r.json());
  const token = login.token;
  if (!token) throw new Error("admin login failed — re-seed first?");
  const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const existing = await fetch(`${BASE}/api/inventory`, { headers: H }).then((r) => r.json());
  const skus = new Set((existing?.items ?? []).map((i) => i.sku));

  let added = 0;
  let skipped = 0;
  for (const s of supplies) {
    if (skus.has(s.sku)) {
      skipped++;
      continue;
    }
    const r = await fetch(`${BASE}/api/inventory`, {
      method: "POST",
      headers: H,
      body: JSON.stringify(s),
    });
    if (!r.ok) {
      const t = await r.text();
      console.warn(`  ! ${s.sku} failed: ${r.status} ${t}`);
      continue;
    }
    added++;
    console.log(`  + ${s.sku} ${s.name} (${s.category})`);
  }
  console.log(`\nDone — added ${added}, skipped ${skipped} existing.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
