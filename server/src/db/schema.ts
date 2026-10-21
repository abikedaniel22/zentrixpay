import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  pgEnum,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createId } from "@paralleldrive/cuid2";

export const onchainStatusEnum = pgEnum("onchain_status_enum", [
  "none",
  "pending",
  "registered",
  "failed",
]);

// Publishers — providers that sell API calls through the gateway
export const publishers = pgTable("publishers", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  walletAddress: text("wallet_address").notNull(),
  apiKeyHash: text("api_key_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// APIs — upstream HTTP APIs that providers sell per call through the proxy
export const apis = pgTable(
  "apis",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    publisherId: text("publisher_id")
      .notNull()
      .references(() => publishers.id),
    name: text("name").notNull(),
    description: text("description"),
    // Never exposed publicly: callers must go through the paid proxy.
    upstreamUrl: text("upstream_url").notNull(),
    price: text("price").notNull(), // USDC per call
    walletAddress: text("wallet_address").notNull(),
    allowedMethods: jsonb("allowed_methods").$type<string[]>().notNull().default(["GET"]),
    // Header the proxy adds to every upstream request, e.g. the provider's own
    // API key. The value is AES-256-GCM encrypted (see utils/secretBox.ts).
    upstreamHeaderName: text("upstream_header_name"),
    upstreamHeaderValueEnc: text("upstream_header_value_enc"),
    // Query parameter the proxy adds to every upstream URL, for APIs that take
    // their key as ?api_key=…. Encrypted like the header value.
    upstreamQueryName: text("upstream_query_name"),
    upstreamQueryValueEnc: text("upstream_query_value_enc"),
    // Provider-supplied OpenAPI 3 document, stored as uploaded (it may name the
    // upstream; the public copy is rewritten, see services/openApiSpec.ts).
    openapiSpec: jsonb("openapi_spec").$type<Record<string, unknown>>(),
    timeoutMs: integer("timeout_ms"),
    // Per-API response cap; never above PROXY_MAX_RESPONSE_BYTES (#37).
    maxResponseBytes: integer("max_response_bytes"),
    // Signed event POSTed after each charged call (#36). The secret is
    // AES-256-GCM encrypted like the upstream header value.
    webhookUrl: text("webhook_url"),
    webhookSecretEnc: text("webhook_secret_enc"),
    // Upstream health (#35): healthPath is pinged relative to upstreamUrl;
    // unhealthy APIs are hidden from the catalog until a check succeeds.
    healthPath: text("health_path"),
    healthy: boolean("healthy").notNull().default(true),
    healthFailures: integer("health_failures").notNull().default(0),
    lastHealthCheckAt: timestamp("last_health_check_at"),
    ownershipToken: text("ownership_token").notNull(),
    ownershipVerifiedAt: timestamp("ownership_verified_at"),
    listed: boolean("listed").notNull().default(false),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    // Soft delete: archived APIs are hidden everywhere but keep their call history.
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    publisherIdx: index("idx_apis_publisher_id").on(table.publisherId),
    catalogIdx: index("idx_apis_listed_created_at").on(table.listed, table.createdAt),
    tagsIdx: index("idx_apis_tags").using("gin", table.tags),
  }),
);

// API calls — one row per proxied call, charged or not
export const apiCalls = pgTable(
  "api_calls",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    apiId: text("api_id")
      .notNull()
      .references(() => apis.id),
    payerAddress: text("payer_address").notNull(),
    amount: text("amount").notNull(), // USDC; only collected when charged
    charged: boolean("charged").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    responseStatus: integer("response_status").notNull(),
    durationMs: integer("duration_ms").notNull(),
    // Settlement transaction, from the x402 PAYMENT-RESPONSE header; null when not charged.
    txHash: text("tx_hash"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    refundTxIdx: uniqueIndex("idx_api_calls_refund_tx_hash").on(table.refundTxHash),
    apiCreatedIdx: index("idx_api_calls_api_id_created_at").on(table.apiId, table.createdAt),
    payerCreatedIdx: index("idx_api_calls_payer_address_created_at").on(
      table.payerAddress,
      table.createdAt,
    ),
  }),
);
