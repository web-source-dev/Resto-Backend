import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { User } from "../models/User";

export interface AuthedRequest extends Request {
  user?: any;
  outletId?: string;
}

export async function authMiddleware(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as any;
    const user = await User.findById(payload.sub);
    if (!user || !user.active) return res.status(401).json({ error: "Invalid user" });
    req.user = user;
    req.outletId = user.outletId.toString();
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

export function requireRole(...roles: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!roles.includes(req.user.role))
      return res.status(403).json({ error: "Forbidden" });
    next();
  };
}

/**
 * Inverse of requireRole: blocks the listed roles, allows everyone else.
 * Used to hide PII / operational reads from roles that don't need them
 * (e.g. riders shouldn't see the customer list, supplier list, expenses,
 * staff roster, etc.) without having to enumerate every allowed role.
 */
export function excludeRoles(...roles: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (roles.includes(req.user.role))
      return res.status(403).json({ error: "Forbidden" });
    next();
  };
}
