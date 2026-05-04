import { NextFunction, Request, Response } from "express";

/**
 * Translate common framework-level errors into HTTP-friendly responses
 * before falling through to the generic 500 handler. The frontend toasts
 * whatever `error` string we return, so it's worth keeping these messages
 * actionable (which field, which value) rather than echoing Mongoose stacks.
 */
function normalize(err: any): { status: number; message: string } {
  // Already-tagged errors (e.g. `throw Object.assign(new Error(...), {status: 409})`)
  if (err?.status || err?.statusCode) {
    return {
      status: err.status ?? err.statusCode,
      message: err.message ?? "Error",
    };
  }

  // Mongoose CastError — usually "Cast to ObjectId failed for value '...'".
  // Almost always caller passed a malformed id; should be 400, not 500.
  if (err?.name === "CastError") {
    const path = err.path ?? "id";
    return { status: 400, message: `Invalid ${path}` };
  }

  // Mongoose ValidationError — enum/required/min/max failures. Surface the
  // first offending field and its message so the UI can highlight it.
  if (err?.name === "ValidationError" && err?.errors) {
    const fields = Object.keys(err.errors);
    const first = fields[0];
    const fe = err.errors[first];
    let detail = fe?.message ?? "validation failed";
    // Drop the noisy Mongoose-internal prefix when the kind is `enum` and
    // construct a friendlier "<field>: <value> is not allowed" message.
    if (fe?.kind === "enum" && fe?.value !== undefined) {
      detail = `${first}: "${fe.value}" is not an allowed value`;
    } else if (fe?.kind === "required") {
      detail = `${first} is required`;
    }
    return { status: 400, message: detail };
  }

  // Duplicate key (unique index hit). Pick the offending field for the message.
  if (err?.code === 11000) {
    const field = Object.keys(err?.keyPattern ?? err?.keyValue ?? {})[0];
    return {
      status: 409,
      message: field ? `${field} already exists` : "Duplicate key",
    };
  }

  return { status: 500, message: err?.message ?? "Server error" };
}

export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  const { status, message } = normalize(err);
  if (status >= 500) console.error("[error]", err);
  res.status(status).json({ error: message });
}
