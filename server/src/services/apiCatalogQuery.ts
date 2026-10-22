import { and, asc, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { apiCalls, apis } from "../db/schema.js";
import type * as schema from "../db/schema.js";
import type { apiCatalogSortValues } from "../schemas/requests.js";

// Query building for the public API catalog (GET /apis). Kept free of config
// and the shared DB client so it can be tested against a real Postgres.

export type ApiCatalogSort = (typeof apiCatalogSortValues)[number];

export interface ApiCatalogOptions {
  q?: string;
  tag?: string[];
  sort?: ApiCatalogSort;
  limit: number;
  offset: number;
}

/** Window used to rank APIs by popularity (charged calls). */
export const POPULARITY_WINDOW_DAYS = 7;

type Db = PostgresJsDatabase<typeof schema>;

/** `%term%` for ILIKE, with `%`, `_` and `\` matched literally. */
export function substringPattern(q: string): string {
  return `%${q.replace(/[%_\\]/g, "\\$&")}%`;
}

export function catalogWhere(opts: Pick<ApiCatalogOptions, "q" | "tag">): SQL {
  const conditions = [eq(apis.listed, true), isNull(apis.archivedAt)];
  if (opts.q) {
    // Served by the pg_trgm GIN indexes on name and description (#148).
    const pattern = substringPattern(opts.q);
    conditions.push(or(ilike(apis.name, pattern), ilike(apis.description, pattern))!);
  }
  if (opts.tag?.length) {
    // jsonb containment: the API's tags must include every requested tag.
    conditions.push(sql`${apis.tags} @> ${JSON.stringify(opts.tag)}::jsonb`);
  }
  return and(...conditions)!;
}

/**
 * ORDER BY for a catalog sort. Every sort ends with the primary key, so rows
 * that tie on every other key (e.g. APIs created in the same instant) always
 * come back in the same order and offset pages never repeat or skip a row (#147).
 */
export function catalogOrderBy(sort: ApiCatalogSort = "newest"): SQL[] {
  // Charged calls in the popularity window; correlated so it only runs for this sort.
  const recentChargedCalls = sql`(
    select count(*) from ${apiCalls}
    where ${apiCalls.apiId} = ${apis.id}
      and ${apiCalls.charged}
      and ${apiCalls.createdAt} >= now() - make_interval(days => ${POPULARITY_WINDOW_DAYS})
  )`;
  const price = sql`${apis.price}::numeric`;
  const order = {
    newest: [desc(apis.createdAt)],
    price_asc: [asc(price), desc(apis.createdAt)],
    price_desc: [desc(price), desc(apis.createdAt)],
    popular: [desc(recentChargedCalls), desc(apis.createdAt)],
  }[sort];
  return [...order, asc(apis.id)];
}

/** One page of listed, non-archived APIs, as stored rows. */
export function selectCatalogPage(db: Db, opts: ApiCatalogOptions) {
  return db
    .select()
    .from(apis)
    .where(catalogWhere(opts))
    .orderBy(...catalogOrderBy(opts.sort))
    .limit(opts.limit)
    .offset(opts.offset);
}
