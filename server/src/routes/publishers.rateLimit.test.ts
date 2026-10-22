import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// Issue #135: POST /publishers is public and mints an API key per call, so it
// is limited per client IP through the shared rate-limit store. These tests run
// the real route + limiter against both store backends.

const { mockRegisterPublisher, redisState } = vi.hoisted(() => ({
  mockRegisterPublisher: vi.fn(),
  redisState: { sets: new Map<string, Array<{ score: number; member: string }>>() },
}));

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../services/publisherService.js", () => ({
  registerPublisher: mockRegisterPublisher,
  getPublisherResources: vi.fn(),
  rotatePublisherKey: vi.fn(),
}));

// Minimal stand-in for a Redis server that runs the sliding-window script used
// by RedisSlidingWindowStore (ZREMRANGEBYSCORE / ZCARD / ZADD on one key).
vi.mock("redis", () => ({
  createClient: () => {
    const client = {
      isOpen: false,
      on: () => client,
      connect: async () => {
        client.isOpen = true;
      },
      quit: async () => {
        client.isOpen = false;
      },
      eval: async (_script: string, opts: { keys: string[]; arguments: string[] }) => {
        const [key] = opts.keys;
        const [nowStr, windowStr, limitStr, member] = opts.arguments;
        const now = Number(nowStr);
        const windowMs = Number(windowStr);
        const limit = Number(limitStr);
        const set = (redisState.sets.get(key) ?? []).filter((e) => e.score > now - windowMs);
        redisState.sets.set(key, set);
        if (set.length >= limit) {
          const oldest = Math.min(...set.map((e) => e.score));
          return [0, set.length, oldest + windowMs];
        }
        set.push({ score: now, member });
        return [1, limit - set.length, now + windowMs];
      },
    };
    return client;
  },
}));

const VALID_BODY = {
  name: "Alice",
  email: "alice@example.com",
  walletAddress: "GALICE",
};

async function buildApp(redisUrl?: string) {
  vi.resetModules();
  vi.doMock("../config.js", () => ({
    config: {
      BASE_URL: "http://localhost:4021",
      REDIS_URL: redisUrl,
      RATE_LIMIT_REGISTER_IP_MAX: 2,
      RATE_LIMIT_REGISTER_IP_WINDOW_MS: 60_000,
      RATE_LIMIT_VERIFY_IP_MAX: 10,
      RATE_LIMIT_VERIFY_IP_WINDOW_MS: 60_000,
      RATE_LIMIT_VERIFY_WALLET_MAX: 10,
      RATE_LIMIT_VERIFY_WALLET_WINDOW_MS: 60_000,
      RATE_LIMIT_PUBLISH_IP_MAX: 10,
      RATE_LIMIT_PUBLISH_IP_WINDOW_MS: 60_000,
      RATE_LIMIT_PUBLISH_WALLET_MAX: 10,
      RATE_LIMIT_PUBLISH_WALLET_WINDOW_MS: 60_000,
    },
  }));
  const { default: router } = await import("./publishers.js");
  const { getRateLimitStore, RedisSlidingWindowStore, MemorySlidingWindowStore } = await import(
    "../lib/rateLimit/index.js"
  );
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(router);
  return { app, store: getRateLimitStore(), RedisSlidingWindowStore, MemorySlidingWindowStore };
}

function register(app: express.Express, ip = "203.0.113.7") {
  return request(app).post("/publishers").set("X-Forwarded-For", ip).send(VALID_BODY);
}

describe.each([
  { backend: "memory", redisUrl: undefined },
  { backend: "redis", redisUrl: "redis://localhost:6379" },
])("POST /publishers — IP rate limit ($backend store)", ({ backend, redisUrl }) => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    redisState.sets.clear();
    mockRegisterPublisher.mockReset();
    mockRegisterPublisher.mockResolvedValue({
      publisher: { ...VALID_BODY, id: "pub-1", createdAt: new Date("2026-01-01") },
      apiKey: "mv_freshkey",
    });
    ctx = await buildApp(redisUrl);
  });

  afterEach(async () => {
    const { closeRateLimitStore } = await import("../lib/rateLimit/index.js");
    await closeRateLimitStore();
  });

  it("uses the configured store backend", () => {
    const expected =
      backend === "redis" ? ctx.RedisSlidingWindowStore : ctx.MemorySlidingWindowStore;
    expect(ctx.store).toBeInstanceOf(expected);
  });

  it("sets standard rate-limit headers on allowed registrations", async () => {
    const res = await register(ctx.app);

    expect(res.status).toBe(201);
    expect(res.headers["ratelimit-limit"]).toBe("2");
    expect(res.headers["ratelimit-remaining"]).toBe("1");
    expect(res.headers["ratelimit-reset"]).toMatch(/^\d+$/);
  });

  it("returns the standard 429 once an IP exceeds the limit", async () => {
    expect((await register(ctx.app)).status).toBe(201);
    expect((await register(ctx.app)).status).toBe(201);

    const blocked = await register(ctx.app);

    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: "Too many requests", code: "RATE_LIMITED" });
    expect(Number(blocked.body.retryAfterSeconds)).toBeGreaterThan(0);
    expect(blocked.headers["retry-after"]).toMatch(/^\d+$/);
    expect(blocked.headers["ratelimit-limit"]).toBe("2");
    expect(blocked.headers["ratelimit-remaining"]).toBe("0");
    expect(mockRegisterPublisher).toHaveBeenCalledTimes(2);
  });

  it("counts invalid registration attempts so bad payloads cannot bypass the limit", async () => {
    await request(ctx.app).post("/publishers").set("X-Forwarded-For", "203.0.113.7").send({});
    await request(ctx.app).post("/publishers").set("X-Forwarded-For", "203.0.113.7").send({});

    expect((await register(ctx.app)).status).toBe(429);
    expect(mockRegisterPublisher).not.toHaveBeenCalled();
  });

  it("tracks client IPs independently", async () => {
    await register(ctx.app, "203.0.113.7");
    await register(ctx.app, "203.0.113.7");
    expect((await register(ctx.app, "203.0.113.7")).status).toBe(429);

    expect((await register(ctx.app, "198.51.100.9")).status).toBe(201);
  });
});
