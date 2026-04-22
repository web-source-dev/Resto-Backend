/* eslint-disable no-console */
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../config/db";
import { maybeSeed } from "./seed";
import { ensureTestUsers } from "./ensureUsers";

async function main() {
  const uri = await connectDB();
  console.log(`[reset] connected to ${uri.split("@")[1] ?? uri}`);
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("MongoDB connection database handle is unavailable");
  }

  const name = mongoose.connection.name;
  const collections = await db.listCollections().toArray();
  console.log(
    `[reset] dropping ${collections.length} collections in "${name}"…`
  );
  for (const c of collections) {
    await db.dropCollection(c.name);
    console.log(`  · dropped ${c.name}`);
  }

  console.log("[reset] re-seeding demo data…");
  await maybeSeed();
  await ensureTestUsers();

  // Summary
  const out = await db.listCollections().toArray();
  console.log(`[reset] final collections (${out.length}):`);
  for (const c of out) {
    const count = await mongoose.connection
      .collection(c.name)
      .countDocuments();
    console.log(`  · ${c.name.padEnd(22)} ${count} docs`);
  }

  await disconnectDB();
  console.log("[reset] done ✓");
}

main().catch((err) => {
  console.error("[reset] failed:", err);
  process.exit(1);
});
