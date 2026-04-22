import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { User } from "../models/User";
import { Outlet } from "../models/Outlet";
import { asyncHandler } from "../utils/asyncHandler";
import { authMiddleware, AuthedRequest } from "../middleware/auth";

const r = Router();

function sign(user: any) {
  return jwt.sign(
    { sub: user._id.toString(), outletId: user.outletId.toString(), role: user.role },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES } as any
  );
}

r.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email: (email ?? "").toLowerCase() });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    const ok = await bcrypt.compare(password ?? "", user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });
    const token = sign(user);
    res.json({ token, user: (user as any).toPublic() });
  })
);

r.post(
  "/register",
  asyncHandler(async (req, res) => {
    const { name, email, password, outletName } = req.body;
    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) return res.status(409).json({ error: "Email already registered" });
    const outlet = await Outlet.create({ name: outletName ?? "My Outlet" });
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      outletId: outlet._id,
      name,
      email: email.toLowerCase(),
      passwordHash,
      role: "admin",
    });
    res.status(201).json({ token: sign(user), user: (user as any).toPublic() });
  })
);

r.get(
  "/me",
  authMiddleware,
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json({ user: (req.user as any).toPublic() });
  })
);

export default r;
