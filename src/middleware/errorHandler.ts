import { NextFunction, Request, Response } from "express";

export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  const status = err.status ?? err.statusCode ?? 500;
  const message = err.message ?? "Server error";
  if (status >= 500) console.error("[error]", err);
  res.status(status).json({ error: message });
}
