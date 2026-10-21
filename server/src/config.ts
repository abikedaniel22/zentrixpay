import "dotenv/config";
import { z } from "zod/v4";
import {
  applyNetworkEnvDefaults,
  resolveStellarNetwork,
  validateNetworkConfig,
} from "@zentrixpay/registry-client";
import { rootLogger } from "./lib/logger.js";

const envWithDefaults = applyNetworkEnvDefaults(process.env);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4021),
  BASE_URL: z.string().default("http://localhost:4021"),
  WEB_APP_URL: z.string().url().default("http://localhost:5173"),
  ALLOWED_ORIGINS: z.string().optional(),

  // Stellar / x402 — STELLAR_NETWORK selects preset defaults; individual vars may override.
  STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  NETWORK: z.string().min(1),
  FACILITATOR_URL: z.string().default("https://www.x402.org/facilitator"),
  USDC_CONTRACT_ID: z.string().min(1),

  // Soroban
  SOROBAN_RPC_URL: z.string().url("SOROBAN_RPC_URL must be a valid URL"),

  // Postgres
  DATABASE_URL: z.string().min(1, "DATABASE_URL (Postgres connection string) is required"),

  // Limits
  // Explicit JSON body limit for express.json() (e.g. "1mb", "512kb").
  MAX_JSON_BODY_SIZE: z.string().default("1mb"),

  // Soroban registry
  REGISTRY_CONTRACT_ID: z.string().min(1, "REGISTRY_CONTRACT_ID is required"),
  REGISTRY_SECRET_KEY: z
    .string()
    .min(1, "REGISTRY_SECRET_KEY (deployer / owner secret) is required"),

  // Metrics endpoint token — if set, requests to /metrics must supply it via
  // Bearer auth or ?token=. If unset, the endpoint is disabled.
  METRICS_TOKEN: z.string().optional(),

  // Sentry error tracking — when DSN is set, unhandled errors are reported.
  SENTRY_DSN: z.string().url().optional(),

  // Rate limiting (API registration)
  RATE_LIMIT_PUBLISH_IP_MAX: z.coerce.number().default(20),
  RATE_LIMIT_PUBLISH_IP_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_PUBLISH_WALLET_MAX: z.coerce.number().default(10),
  RATE_LIMIT_PUBLISH_WALLET_WINDOW_MS: z.coerce.number().default(3_600_000),

  // Optional Redis URL for a shared sliding-window rate-limit store (multi-instance).
  REDIS_URL: z.string().url().optional(),

  // Optional HMAC-SHA256 request signatures for publisher mutations (off by default).
  REQUIRE_REQUEST_SIGNATURE: z.coerce.boolean().default(false),
  // Max clock skew for X-Timestamp when signatures are required (default 5 minutes).
  SIGNATURE_MAX_SKEW_MS: z.coerce.number().default(300_000),

  // Per-request timeout — slow upstreams (RPC, facilitator) return 503 instead
  // of hanging the connection.
  REQUEST_TIMEOUT_MS: z.coerce.number().default(30_000),
  // Max time to drain in-flight requests on SIGTERM/SIGINT before forcing exit.
  GRACEFUL_SHUTDOWN_TIMEOUT_MS: z.coerce.number().default(10_000),
  // How long a publish Idempotency-Key is remembered so retries return the
  // original result instead of creating a duplicate (default 24h).
  IDEMPOTENCY_TTL_MS: z.coerce.number().default(86_400_000),

  // API proxy (pay-per-call gateway)
  // 32-byte key (64 hex chars) used to encrypt providers' upstream secret
  // headers at rest. Without it, APIs cannot be registered with a secret.
  UPSTREAM_SECRET_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "UPSTREAM_SECRET_KEY must be 64 hex characters")
    .optional(),
  // Largest request body forwarded to an upstream API (express size string).
  PROXY_MAX_REQUEST_BODY: z.string().default("5mb"),
  // Upstream responses are held in memory until payment settles, so they are capped.
  PROXY_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  // Default and ceiling for a single upstream call. Kept under REQUEST_TIMEOUT_MS.
  PROXY_DEFAULT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  PROXY_MAX_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),
  // Idempotency-Key replay for paid calls: how long a charged response is kept,
  // how many are kept (oldest evicted first) and the largest body kept.
  PROXY_IDEMPOTENCY_TTL_MS: z.coerce.number().int().positive().default(3_600_000),
  PROXY_IDEMPOTENCY_MAX_ENTRIES: z.coerce.number().int().positive().default(1000),
  PROXY_IDEMPOTENCY_MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(256 * 1024),
  // Local development only: allow upstreams on loopback/private networks.
  PROXY_ALLOW_PRIVATE_UPSTREAMS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // How long a proxied API's row is cached between DB lookups (#34). Edits
  // invalidate the entry, so this only bounds staleness across replicas.
  PROXY_API_CACHE_TTL_MS: z.coerce.number().int().min(0).default(5_000),

  // Upstream health checks (#35): APIs with a healthPath are pinged on this
  // interval and hidden from the catalog after this many consecutive failures.
  HEALTH_CHECK_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  HEALTH_CHECK_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(3),

  // Provider webhooks for charged calls (#36). Delays between attempts grow
  // as WEBHOOK_RETRY_BASE_MS * 4^n.
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  WEBHOOK_RETRY_BASE_MS: z.coerce.number().int().positive().default(1_000),
});

const parsed = envSchema.safeParse(envWithDefaults);

if (!parsed.success) {
  rootLogger.error(
    { event: "config_invalid", issues: parsed.error.format() },
    "invalid environment variables",
  );
  process.exit(1);
}

const stellarNetwork = resolveStellarNetwork(parsed.data.STELLAR_NETWORK);
const networkIssues = validateNetworkConfig({
  stellarNetwork,
  x402Network: parsed.data.NETWORK,
  sorobanRpcUrl: parsed.data.SOROBAN_RPC_URL,
  usdcSacContractId: parsed.data.USDC_CONTRACT_ID,
  registryContractId: parsed.data.REGISTRY_CONTRACT_ID,
});

if (networkIssues.length > 0) {
  rootLogger.error(
    { event: "config_network_mismatch", issues: networkIssues },
    "inconsistent Stellar network configuration",
  );
  for (const issue of networkIssues) {
    rootLogger.error({ field: issue.field }, issue.message);
  }
  process.exit(1);
}

export const config = parsed.data;
