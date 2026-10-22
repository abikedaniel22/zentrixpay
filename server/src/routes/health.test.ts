import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// Issue #136: readiness responses expose stable error codes only; the raw
// dependency error (which may embed connection strings) goes to server logs.

const { mockExecute, mockGetHealth, mockWarn } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockGetHealth: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock("../db/client.js", () => ({ db: { execute: mockExecute } }));
vi.mock("../config.js", () => ({
  config: { SOROBAN_RPC_URL: "https://rpc-internal.example:8000/soroban" },
}));
vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {
    Server: class {
      getHealth = mockGetHealth;
    },
  },
}));
vi.mock("../lib/logger.js", () => ({
  getLogger: () => ({ warn: mockWarn, info: vi.fn(), error: vi.fn() }),
}));
vi.mock("../lib/lifecycle.js", () => ({ isAccepting: () => true }));

import healthRouter from "./health.js";

const DB_ERROR =
  "connect ECONNREFUSED 10.0.12.5:5432 (postgres://zentrix:s3cr3t-pw@db.internal:5432/zentrixpay)";
const RPC_ERROR = "getaddrinfo ENOTFOUND rpc-internal.example (token=abc123)";

function app() {
  const a = express();
  a.use(healthRouter);
  return a;
}

describe("GET /health/ready — sanitized errors (#136)", () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockGetHealth.mockReset();
    mockWarn.mockReset();
  });

  it("reports ok with no error fields when dependencies are healthy", async () => {
    mockExecute.mockResolvedValue([]);
    mockGetHealth.mockResolvedValue({
      latestLedger: 10,
      oldestLedger: 1,
      ledgerRetentionWindow: 9,
    });

    const res = await request(app()).get("/health/ready");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.checks.database.error).toBeUndefined();
    expect(res.body.checks.sorobanRpc.error).toBeUndefined();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("returns stable error codes instead of raw dependency messages", async () => {
    mockExecute.mockRejectedValue(new Error(DB_ERROR));
    mockGetHealth.mockRejectedValue(new Error(RPC_ERROR));

    const res = await request(app()).get("/health/ready");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("error");
    expect(res.body.checks.database).toMatchObject({
      status: "error",
      error: "database_unavailable",
    });
    expect(res.body.checks.sorobanRpc).toMatchObject({
      status: "error",
      error: "soroban_rpc_unavailable",
    });
  });

  it("never exposes connection details in the response body", async () => {
    mockExecute.mockRejectedValue(new Error(DB_ERROR));
    mockGetHealth.mockRejectedValue(new Error(RPC_ERROR));

    const res = await request(app()).get("/health/ready");

    for (const leaked of [
      "s3cr3t-pw",
      "postgres://",
      "db.internal",
      "10.0.12.5",
      "5432",
      "ECONNREFUSED",
      "rpc-internal.example",
      "token=abc123",
      "ENOTFOUND",
    ]) {
      expect(res.text).not.toContain(leaked);
    }
  });

  it("keeps the raw error in server-side logs", async () => {
    const dbErr = new Error(DB_ERROR);
    mockExecute.mockRejectedValue(dbErr);
    mockGetHealth.mockResolvedValue({ latestLedger: 1, oldestLedger: 1, ledgerRetentionWindow: 0 });

    await request(app()).get("/health/ready");

    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "readiness_probe_failed",
        dependency: "database",
        code: "database_unavailable",
        err: dbErr,
      }),
      expect.any(String),
    );
  });

  it("sanitizes non-Error rejections too", async () => {
    mockExecute.mockRejectedValue("FATAL: password authentication failed for user zentrix");
    mockGetHealth.mockResolvedValue({ latestLedger: 1, oldestLedger: 1, ledgerRetentionWindow: 0 });

    const res = await request(app()).get("/health/ready");

    expect(res.body.checks.database.error).toBe("database_unavailable");
    expect(res.text).not.toContain("password authentication");
  });
});
