import { sql } from "drizzle-orm";
import { rpc as StellarRpc } from "@stellar/stellar-sdk";
import { db } from "../db/client.js";
import { config } from "../config.js";
import { getLogger } from "./logger.js";

export type DependencyStatus = "ok" | "error";

/**
 * Stable, public error identifiers for failed readiness probes. Raw dependency
 * errors can carry connection strings, hostnames or credentials, so they are
 * only written to server logs — callers of /health/ready see these codes.
 */
export const READINESS_ERROR_CODES = {
  database: "database_unavailable",
  sorobanRpc: "soroban_rpc_unavailable",
} as const;

export type ReadinessErrorCode = (typeof READINESS_ERROR_CODES)[keyof typeof READINESS_ERROR_CODES];

export interface DependencyCheck {
  status: DependencyStatus;
  latencyMs: number;
  error?: ReadinessErrorCode;
  details?: Record<string, unknown>;
}

function failedCheck(
  dependency: keyof typeof READINESS_ERROR_CODES,
  start: number,
  err: unknown,
): DependencyCheck {
  const code = READINESS_ERROR_CODES[dependency];
  const latencyMs = Date.now() - start;
  getLogger().warn(
    { event: "readiness_probe_failed", dependency, code, latencyMs, err },
    "readiness probe failed",
  );
  return { status: "error", latencyMs, error: code };
}

export async function probeDatabase(): Promise<DependencyCheck> {
  const start = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return failedCheck("database", start, err);
  }
}

export async function probeSorobanRpc(): Promise<DependencyCheck> {
  const start = Date.now();
  try {
    const rpcServer = new StellarRpc.Server(config.SOROBAN_RPC_URL);
    const health = await rpcServer.getHealth();
    return {
      status: "ok",
      latencyMs: Date.now() - start,
      details: {
        latestLedger: health.latestLedger,
        oldestLedger: health.oldestLedger,
        ledgerRetentionWindow: health.ledgerRetentionWindow,
      },
    };
  } catch (err) {
    return failedCheck("sorobanRpc", start, err);
  }
}
