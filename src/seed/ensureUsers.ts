import bcrypt from "bcryptjs";
import { Outlet } from "../models/Outlet";
import { User } from "../models/User";

export const ROLE_TEST_USERS: {
  email: string;
  password: string;
  name: string;
  role: "admin" | "manager" | "receptionist" | "waiter" | "kitchen" | "rider";
  phone?: string;
  shift?: string;
  rating?: number;
  hourlyRate?: number;
}[] = [
  { email: "admin@flavorflow.dev", password: "admin123", name: "Gian Baio", role: "admin", rating: 4.9 },
  { email: "manager@flavorflow.dev", password: "manager123", name: "Mr. Rehman", role: "manager", phone: "+92 300 1000001", shift: "Full · 10a–10p", rating: 4.8, hourlyRate: 650 },
  { email: "receptionist@flavorflow.dev", password: "recept123", name: "Hina Rasheed", role: "receptionist", phone: "+92 333 6666666", shift: "Lunch · 11a–5p", rating: 4.9, hourlyRate: 340 },
  { email: "waiter@flavorflow.dev", password: "waiter123", name: "Bilal Ahmed", role: "waiter", phone: "+92 333 1111111", shift: "Lunch · 11a–5p", rating: 4.8, hourlyRate: 350 },
  { email: "kitchen@flavorflow.dev", password: "kitchen123", name: "Kashif Nawaz", role: "kitchen", phone: "+92 333 4444444", shift: "Full · 10a–10p", rating: 4.7, hourlyRate: 480 },
  { email: "rider@flavorflow.dev", password: "rider123", name: "Imran Shah", role: "rider", phone: "+92 333 7777777", shift: "Peak · 5p–11p", rating: 4.4, hourlyRate: 280 },
];

export async function ensureTestUsers() {
  const outlet = await Outlet.findOne();
  if (!outlet) {
    console.log("[ensure-users] no outlet yet; skipping");
    return;
  }
  let created = 0;
  let updated = 0;
  for (const u of ROLE_TEST_USERS) {
    const existing = await User.findOne({ email: u.email });
    const passwordHash = await bcrypt.hash(u.password, 10);
    if (!existing) {
      await User.create({
        outletId: outlet._id,
        outletIds: [outlet._id],
        name: u.name,
        email: u.email,
        passwordHash,
        role: u.role,
        phone: u.phone,
        currentShift: u.shift,
        rating: u.rating,
        hourlyRate: u.hourlyRate,
        active: true,
        clockedInAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      });
      created += 1;
    } else {
      existing.passwordHash = passwordHash;
      existing.role = u.role;
      existing.active = true;
      if (u.shift) existing.currentShift = u.shift;
      if (u.rating) existing.rating = u.rating;
      if (u.hourlyRate) existing.hourlyRate = u.hourlyRate;
      if (!existing.outletIds || existing.outletIds.length === 0) {
        existing.outletIds = [outlet._id] as any;
      }
      await existing.save();
      updated += 1;
    }
  }
  console.log(`[ensure-users] created ${created}, refreshed ${updated} role accounts`);
}
