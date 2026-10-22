import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema.js";
import { selectCatalogPage, substringPattern, type ApiCatalogSort } from "./apiCatalogQuery.js";

// SQL shape of the catalog query, rendered without a database. The behaviour
// against real Postgres is covered in apiCatalogQuery.pg.test.ts.

const db = drizzle.mock({ schema });
const SORTS: ApiCatalogSort[] = ["newest", "price_asc", "price_desc", "popular"];

function render(opts: Parameters<typeof selectCatalogPage>[1]) {
  return selectCatalogPage(db, opts).toSQL();
}

describe("catalog ordering (#147)", () => {
  it.each(SORTS)("%s ends with the primary key as a unique tie-breaker", (sort) => {
    const { sql } = render({ sort, limit: 20, offset: 40 });
    const orderBy = sql.slice(sql.indexOf(" order by "));
    expect(orderBy).toMatch(/, "apis"\."id" asc limit \$\d+ offset \$\d+$/);
  });

  it("defaults to newest first", () => {
    const { sql } = render({ limit: 20, offset: 0 });
    expect(sql).toContain('order by "apis"."created_at" desc, "apis"."id" asc');
  });
});

describe("catalog search (#148)", () => {
  it("matches name or description with a case-insensitive substring pattern", () => {
    const { sql, params } = render({ q: "weather", limit: 20, offset: 0 });
    expect(sql).toContain('("apis"."name" ilike $');
    expect(sql).toContain('or "apis"."description" ilike $');
    expect(params).toContain("%weather%");
  });

  it("escapes LIKE wildcards so they match literally", () => {
    expect(substringPattern("50%")).toBe("%50\\%%");
    expect(substringPattern("snake_case")).toBe("%snake\\_case%");
    expect(substringPattern("a\\b")).toBe("%a\\\\b%");
  });

  it("only lists listed, non-archived APIs", () => {
    const { sql } = render({ limit: 20, offset: 0 });
    expect(sql).toContain('"apis"."listed" = $');
    expect(sql).toContain('"apis"."archived_at" is null');
  });
});
