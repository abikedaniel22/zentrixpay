import { describe, expect, it, vi } from "vitest";
import { apiCallRetentionCutoff, purgeExpiredApiCalls } from "./apiCallRetention.js";

// Deletion against a real database is covered in apiCatalogAndRetention.pg.test.ts.

describe("apiCallRetentionCutoff", () => {
  it("is exactly retentionDays before now", () => {
    const now = new Date("2026-10-22T12:00:00Z");
    expect(apiCallRetentionCutoff(now, 180).toISOString()).toBe("2026-04-25T12:00:00.000Z");
    expect(apiCallRetentionCutoff(now, 90).toISOString()).toBe("2026-07-24T12:00:00.000Z");
  });
});

describe("purgeExpiredApiCalls", () => {
  it("does not touch the database when retention is disabled", async () => {
    const db = { select: vi.fn(), delete: vi.fn() };
    const deleted = await purgeExpiredApiCalls(db as never, { retentionDays: 0, batchSize: 100 });
    expect(deleted).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });
});
