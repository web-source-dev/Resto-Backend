/**
 * Tiny helper to standardise pagination metadata across list endpoints.
 *
 * Every list route used to return a single shape like `{orders}` / `{items}`
 * / `{logs}` with no metadata — callers couldn't tell if the result was
 * truncated, and the frontend hardcoded a different array key per resource.
 * This helper returns:
 *
 *   { items: [...], total: <count>, hasMore: <bool>, limit: <int> }
 *
 * AND keeps the legacy key (e.g. `orders`) so existing callers keep
 * working. Frontend can migrate to `.items` over time.
 *
 * `total` is computed via `countDocuments` on the same filter so it reflects
 * what would be returned with `limit: Infinity`.
 */

import { Model, FilterQuery } from "mongoose";

export interface PaginationMeta {
  total: number;
  limit: number;
  hasMore: boolean;
}

export async function paginated<T>(
  model: Model<any>,
  filter: FilterQuery<T>,
  opts: {
    sort?: Record<string, 1 | -1>;
    limit?: number;
    skip?: number;
    legacyKey?: string;
    populate?: string;
  } = {}
): Promise<Record<string, any>> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 1000));
  const skip = Math.max(0, opts.skip ?? 0);
  let q = model.find(filter).sort(opts.sort ?? {}).skip(skip).limit(limit);
  if (opts.populate) q = q.populate(opts.populate);
  const [rows, total] = await Promise.all([q, model.countDocuments(filter)]);
  const out: Record<string, any> = {
    items: rows,
    total,
    limit,
    hasMore: skip + rows.length < total,
  };
  if (opts.legacyKey && opts.legacyKey !== "items") {
    out[opts.legacyKey] = rows;
  }
  return out;
}
