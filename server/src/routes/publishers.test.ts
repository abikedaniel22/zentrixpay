import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHash } from "node:crypto";

const { PUBLISHERS_MARKER } = vi.hoisted(() => ({
  PUBLISHERS_MARKER: { __table: "publishers" },
}));

vi.mock("../db/schema.js", () => ({
  publishers: PUBLISHERS_MARKER,
}));

// apiKeyAuth matches by sha256(key); precompute so tests can supply a known key/hash pair.
const VALID_API_KEY = "zp_test-key";
const VALID_API_KEY_HASH = createHash("sha256").update(VALID_API_KEY).digest("hex");

const authedPublisher = {
  id: "pub-1",
  name: "Alice",
  email: "alice@example.com",
  walletAddress: "GALICE",
  apiKeyHash: VALID_API_KEY_HASH,
  createdAt: new Date("2026-01-01"),
};

let publishersLookupRows: Array<typeof authedPublisher>;

vi.mock("../db/client.js", () => ({
  db: {
    select: (_cols: unknown) => ({
      from: (table: unknown) => {
        if (table === PUBLISHERS_MARKER) {
          return { where: () => Promise.resolve(publishersLookupRows) };
        }
        throw new Error("unexpected table in select().from()");
      },
    }),
  },
}));

vi.mock("../config.js", () => ({
  config: { BASE_URL: "http://localhost:4021" },
}));

const { mockRegisterPublisher, mockGetPublisherAnalytics } = vi.hoisted(() => ({
  mockRegisterPublisher: vi.fn(),
  mockGetPublisherAnalytics: vi.fn(),
}));

vi.mock("../services/publisherService.js", () => ({
  registerPublisher: mockRegisterPublisher,
  rotatePublisherKey: vi.fn(),
}));

vi.mock("../services/apiService.js", () => ({
  getPublisherAnalytics: mockGetPublisherAnalytics,
}));

import publisherRouter from "./publishers.js";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(publisherRouter);
  return app;
}

describe("POST /publishers — registration (#294)", () => {
  beforeEach(() => {
    mockRegisterPublisher.mockReset();
  });

  it("registers a publisher and returns the one-time API key", async () => {
    mockRegisterPublisher.mockResolvedValue({
      publisher: {
        id: "pub-1",
        name: "Alice",
        email: "alice@example.com",
        walletAddress: "GALICE",
        createdAt: new Date("2026-01-01"),
      },
      apiKey: "zp_freshkey",
    });

    const res = await request(createTestApp()).post("/publishers").send({
      name: "Alice",
      email: "alice@example.com",
      walletAddress: "GALICE",
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: "pub-1",
      name: "Alice",
      email: "alice@example.com",
      walletAddress: "GALICE",
      apiKey: "zp_freshkey",
    });
    expect(mockRegisterPublisher).toHaveBeenCalledWith({
      name: "Alice",
      email: "alice@example.com",
      walletAddress: "GALICE",
    });
  });

  it("returns 400 for an invalid email", async () => {
    const res = await request(createTestApp()).post("/publishers").send({
      name: "Alice",
      email: "not-an-email",
      walletAddress: "GALICE",
    });

    expect(res.status).toBe(400);
    expect(mockRegisterPublisher).not.toHaveBeenCalled();
  });

  it("returns 400 when a required field is missing", async () => {
    const res = await request(createTestApp()).post("/publishers").send({
      email: "alice@example.com",
      walletAddress: "GALICE",
    });

    expect(res.status).toBe(400);
    expect(mockRegisterPublisher).not.toHaveBeenCalled();
  });

  it("returns 400 for unexpected extra fields (strict schema)", async () => {
    const res = await request(createTestApp()).post("/publishers").send({
      name: "Alice",
      email: "alice@example.com",
      walletAddress: "GALICE",
      isAdmin: true,
    });

    expect(res.status).toBe(400);
    expect(mockRegisterPublisher).not.toHaveBeenCalled();
  });

  it("returns 409 when the email is already registered", async () => {
    mockRegisterPublisher.mockRejectedValue(
      new Error("duplicate key value violates unique constraint"),
    );

    const res = await request(createTestApp()).post("/publishers").send({
      name: "Alice",
      email: "alice@example.com",
      walletAddress: "GALICE",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Email already registered");
  });

  it("rethrows unexpected errors from the service", async () => {
    mockRegisterPublisher.mockRejectedValue(new Error("database is down"));

    const res = await request(createTestApp()).post("/publishers").send({
      name: "Alice",
      email: "alice@example.com",
      walletAddress: "GALICE",
    });

    expect(res.status).toBe(500);
  });
});

describe("GET /publishers/me — auth enforcement (#294)", () => {
  beforeEach(() => {
    publishersLookupRows = [];
  });

  it("returns 401 when the x-api-key header is missing", async () => {
    const res = await request(createTestApp()).get("/publishers/me");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Missing x-api-key header");
  });

  it("returns 401 when the API key does not match any publisher", async () => {
    publishersLookupRows = [];

    const res = await request(createTestApp())
      .get("/publishers/me")
      .set("x-api-key", "zp_wrong-key");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid API key");
  });

  it("returns the publisher profile for a valid API key", async () => {
    publishersLookupRows = [authedPublisher];

    const res = await request(createTestApp())
      .get("/publishers/me")
      .set("x-api-key", VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "pub-1",
      name: "Alice",
      email: "alice@example.com",
      walletAddress: "GALICE",
    });
  });
});

describe("legacy mv_ API keys (#12)", () => {
  it("still authenticate, because keys are matched by hash", async () => {
    const legacyKey = "mv_legacy-key";
    publishersLookupRows = [
      {
        ...authedPublisher,
        apiKeyHash: createHash("sha256").update(legacyKey).digest("hex"),
      },
    ];

    const res = await request(createTestApp()).get("/publishers/me").set("x-api-key", legacyKey);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("pub-1");
  });
});

describe("GET /publishers/me/analytics — API analytics (#10)", () => {
  const emptyAnalytics = {
    totals: { apis: 0, calls: 0, chargedCalls: 0, revenue: "0", currency: "USDC" },
    apis: [],
  };

  beforeEach(() => {
    publishersLookupRows = [authedPublisher];
    mockGetPublisherAnalytics.mockReset();
    mockGetPublisherAnalytics.mockResolvedValue(emptyAnalytics);
  });

  it("returns 401 when the x-api-key header is missing", async () => {
    const res = await request(createTestApp()).get("/publishers/me/analytics");

    expect(res.status).toBe(401);
    expect(mockGetPublisherAnalytics).not.toHaveBeenCalled();
  });

  it("returns 401 for an invalid API key", async () => {
    publishersLookupRows = [];

    const res = await request(createTestApp())
      .get("/publishers/me/analytics")
      .set("x-api-key", "zp_wrong-key");

    expect(res.status).toBe(401);
    expect(mockGetPublisherAnalytics).not.toHaveBeenCalled();
  });

  it("returns zeroed totals when the provider has no APIs or calls", async () => {
    const res = await request(createTestApp())
      .get("/publishers/me/analytics")
      .set("x-api-key", VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(emptyAnalytics);
    expect(mockGetPublisherAnalytics).toHaveBeenCalledWith("pub-1");
  });

  it("returns totals across all of the provider's APIs", async () => {
    const analytics = {
      totals: { apis: 2, calls: 15, chargedCalls: 12, revenue: "1.2", currency: "USDC" },
      apis: [
        { id: "api-1", name: "Weather", archivedAt: null, calls: 10, chargedCalls: 8, revenue: "0.8" },
        { id: "api-2", name: "Quotes", archivedAt: null, calls: 5, chargedCalls: 4, revenue: "0.4" },
      ],
    };
    mockGetPublisherAnalytics.mockResolvedValue(analytics);

    const res = await request(createTestApp())
      .get("/publishers/me/analytics")
      .set("x-api-key", VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(analytics);
    expect(mockGetPublisherAnalytics).toHaveBeenCalledWith("pub-1");
  });
});

describe("removed resource-era endpoints (#10)", () => {
  beforeEach(() => {
    publishersLookupRows = [authedPublisher];
  });

  it.each(["/publishers/me/resources", "/publishers/leaderboard"])("%s returns 404", async (path) => {
    const res = await request(createTestApp()).get(path).set("x-api-key", VALID_API_KEY);

    expect(res.status).toBe(404);
  });
});
