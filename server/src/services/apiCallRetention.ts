import { inArray, lt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { apiCalls } from "../db/schema.js";
import type * as schema from "../db/schema.js";

// Bounded retention for api_calls rows (#144). Rows older than the retention
// window are deleted in batches; see docs/api-call-retention.md for which
// fields are kept and what stops working for calls past the window.

type Db = PostgresJsDatabase<typeof schema>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Shortest non-zero retention: the provider time-series reaches back 90 days. */
export const MIN_API_CALL_RETENTION_DAYS = 90;

export interface PurgeOptions {
  /** Rows created before `now - retentionDays` are deleted. 0 disables purging. */
  retentionDays: number;
  /** Rows deleted per statement, so a large backlog never holds one long lock. */
  batchSize: number;
  /** Upper bound on statements per run; the rest is picked up by the next run. */
  maxBatches?: number;
  now?: Date;
}

/** The instant before which call records have expired. */
export function apiCallRetentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

/** Delete expired api_calls rows. Returns how many were deleted. */
export async function purgeExpiredApiCalls(db: Db, opts: PurgeOptions): Promise<number> {
  if (opts.retentionDays <= 0) return 0;
  const cutoff = apiCallRetentionCutoff(opts.now ?? new Date(), opts.retentionDays);
  const maxBatches = opts.maxBatches ?? 100;

  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const expired = db
      .select({ id: apiCalls.id })
      .from(apiCalls)
      .where(lt(apiCalls.createdAt, cutoff))
      .limit(opts.batchSize);
    const rows = await db
      .delete(apiCalls)
      .where(inArray(apiCalls.id, expired))
      .returning({ id: apiCalls.id });
    deleted += rows.length;
    if (rows.length < opts.batchSize) break;
  }
  return deleted;
}
