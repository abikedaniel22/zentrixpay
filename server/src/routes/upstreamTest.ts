import { Router, type Request, type Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { apis } from "../db/schema.js";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { requestSignatureAuth } from "../middleware/requestSignatureAuth.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { getRateLimitStore } from "../lib/rateLimit/index.js";
import { logger } from "../lib/logger.js";
import { testUpstreamConfig } from "../services/upstreamConfigTest.js";

const router = Router();

/** Tests per publisher per minute: enough to iterate on a config, not enough to use as a free proxy. */
export const UPSTREAM_TEST_RATE_LIMIT_MAX = 10;
const UPSTREAM_TEST_RATE_LIMIT_WINDOW_MS = 60_000;

const upstreamTestRateLimit = createRateLimiter({
  store: getRateLimitStore(),
  max: UPSTREAM_TEST_RATE_LIMIT_MAX,
  windowMs: UPSTREAM_TEST_RATE_LIMIT_WINDOW_MS,
  limiterName: "upstream_test_publisher",
  keyGenerator: (req) => `upstream-test:publisher:${req.publisher?.id ?? "anonymous"}`,
});

async function loadOwnedApi(id: string, publisherId: string) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) return null;
  const [row] = await db
    .select()
    .from(apis)
    .where(and(eq(apis.id, numericId), eq(apis.publisherId, publisherId), isNull(apis.archivedAt)))
    .limit(1);
  return row ?? null;
}

// POST /apis/:id/test-upstream — one unpaid, bounded request to the saved
// upstream configuration; returns status and latency only (owner, #142).
router.post(
  "/apis/:id/test-upstream",
  apiKeyAuth,
  requestSignatureAuth,
  upstreamTestRateLimit,
  async (req: Request, res: Response) => {
    const api = await loadOwnedApi(req.params.id as string, req.publisher!.id);
    if (!api) {
      res.status(404).json({ error: "API not found" });
      return;
    }
    const result = await testUpstreamConfig(api);
    logger.info(
      {
        event: "api_upstream_test",
        apiId: api.id,
        ok: result.ok,
        status: result.status,
        latencyMs: result.latencyMs,
        errorKind: result.error?.kind,
      },
      "provider upstream configuration test",
    );
    res.setHeader("Cache-Control", "no-store");
    res.json({ apiId: api.id, ...result });
  },
);

export default router;
