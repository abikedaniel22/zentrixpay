import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySlidingWindowStore } from "../lib/rateLimit/stores.js";

// Issue #142: providers test their saved upstream config without paying.

const { mockLimit, mockTest, mockWhere } = vi.hoisted(() => ({
  mockLimit: vi.fn(),
  mockTest: vi.fn(),
  mockWhere: vi.fn(),
}));

vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (...args: unknown[]) => {
          mockWhere(...args);
          return { limit: mockLimit };
        },
      }),
    }),
  },
}));
vi.mock("../config.js", () => ({ config: { REQUIRE_REQUEST_SIGNATURE: false } }));
vi.mock("../lib/rateLimit/index.js", () => {
  const store = new MemorySlidingWindowStore();
  return { getRateLimitStore: () => store };
});
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../lib/metrics.js", () => ({ rateLimitCounter: { inc: vi.fn() } }));
vi.mock("../middleware/apiKeyAuth.js", () => ({
  apiKeyAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = req.headers["x-api-key"];
    if (!key) {
      res.status(401).json({ error: "Missing x-api-key header" });
      return;
    }
    req.publisher = { id: String(key) } as express.Request["publisher"];
    next();
  },
}));
vi.mock("../services/upstreamConfigTest.js", () => ({ testUpstreamConfig: mockTest }));

import router, { UPSTREAM_TEST_RATE_LIMIT_MAX } from "./upstreamTest.js";

const API = { id: 7, publisherId: "pub-1", upstreamUrl: "https://up.test" };
const RESULT = {
  ok: true,
  status: 200,
  latencyMs: 42,
  contentType: "application/json",
  request: { method: "GET", path: "/", usedHeaderSecret: true, usedQuerySecret: false },
  error: null,
  diagnosis: "The upstream is reachable.",
  charged: false,
  testedAt: "2026-10-23T00:00:00.000Z",
};

function app() {
  const a = express();
  a.use(router);
  return a;
}

describe("POST /apis/:id/test-upstream", () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockTest.mockReset();
    mockWhere.mockReset();
  });

  it("requires an API key", async () => {
    const res = await request(app()).post("/apis/7/test-upstream");
    expect(res.status).toBe(401);
    expect(mockTest).not.toHaveBeenCalled();
  });

  it("returns diagnostics for the owner's API", async () => {
    mockLimit.mockResolvedValue([API]);
    mockTest.mockResolvedValue(RESULT);
    const res = await request(app()).post("/apis/7/test-upstream").set("x-api-key", "pub-ok");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ apiId: 7, ...RESULT });
    expect(mockTest).toHaveBeenCalledWith(API);
    // The upstream URL is not echoed back.
    expect(JSON.stringify(res.body)).not.toContain("up.test");
  });

  it("returns 404 for an API the caller does not own", async () => {
    mockLimit.mockResolvedValue([]);
    const res = await request(app()).post("/apis/7/test-upstream").set("x-api-key", "pub-404");
    expect(res.status).toBe(404);
    expect(mockTest).not.toHaveBeenCalled();
  });

  it("returns 404 without a query for a malformed id", async () => {
    const res = await request(app()).post("/apis/abc/test-upstream").set("x-api-key", "pub-bad");
    expect(res.status).toBe(404);
    expect(mockWhere).not.toHaveBeenCalled();
  });

  it("rate-limits tests per publisher", async () => {
    mockLimit.mockResolvedValue([API]);
    mockTest.mockResolvedValue(RESULT);
    const a = app();
    for (let i = 0; i < UPSTREAM_TEST_RATE_LIMIT_MAX; i++) {
      const ok = await request(a).post("/apis/7/test-upstream").set("x-api-key", "pub-rl");
      expect(ok.status).toBe(200);
    }
    const limited = await request(a).post("/apis/7/test-upstream").set("x-api-key", "pub-rl");
    expect(limited.status).toBe(429);
    // Another publisher has its own budget.
    const other = await request(a).post("/apis/7/test-upstream").set("x-api-key", "pub-other");
    expect(other.status).toBe(200);
  });
});
