import {
  check,
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";

export const resourceTypeEnum = pgEnum("resource_type", ["file", "link"]);

export const verificationStatusEnum = pgEnum("verification_status", [
  "pending",
  "verified",
  "rejected",
  "skipped",
]);

export const onchainStatusEnum = pgEnum("onchain_status_enum", [
  "none",
  "pending",
  "registered",
  "failed",
]);

export interface ApiPriceRule {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathPattern: string;
  price: string;
}

// Publishers — humans or AI agents that publish resources
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

// Resources — digital assets published on the marketplace
export const resources = pgTable(
  "resources",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    publisherId: text("publisher_id")
      .notNull()
      .references(() => publishers.id),
    title: text("title").notNull(),
    description: text("description"),
    price: text("price").notNull(),
    walletAddress: text("wallet_address").notNull(),
    resourceType: resourceTypeEnum("resource_type").notNull(),
    storagePath: text("storage_path"),
    thumbnailPath: text("thumbnail_path"),
    contentHash: text("content_hash"),
    externalUrl: text("external_url"),
    mimeType: text("mime_type"),
    verificationStatus: verificationStatusEnum("verification_status").notNull().default("pending"),
    verificationId: text("verification_id"),
    listed: boolean("listed").notNull().default(false),
    onchainStatus: onchainStatusEnum("onchain_status").notNull().default("none"),
    onchainTxHash: text("onchain_tx_hash"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    catalogFilterSortIdx: index("idx_resources_catalog_filter_sort").on(
      table.listed,
      table.verificationStatus,
      table.createdAt,
    ),
    // Publisher dashboards list a single publisher's resources (#285).
    publisherIdx: index("idx_resources_publisher_id").on(table.publisherId),
    // Verification-status filters that aren't anchored to `listed` can't use the
    // composite catalog index, so they get their own (#285).
    verificationStatusIdx: index("idx_resources_verification_status").on(table.verificationStatus),
  }),
);

// Verifications — AI originality check results
export const verifications = pgTable("verifications", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  resourceId: text("resource_id")
    .notNull()
    .references(() => resources.id),
  isOriginal: boolean("is_original").notNull(),
  confidence: real("confidence").notNull(), // 0.0 - 1.0
  flags: text("flags"), // JSON stringified array of issues
  // Token usage + estimated spend for the verification model call (#283).
  // Nullable so historical rows predating usage tracking remain valid.
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  totalTokens: integer("total_tokens"),
  estimatedCost: text("estimated_cost"), // USD, stringified for precision
  checkedAt: timestamp("checked_at").defaultNow().notNull(),
});

export const apis = pgTable(
  "apis",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    // Never exposed publicly: callers must go through the paid proxy.
    upstreamUrl: text("upstream_url").notNull(),
    price: text("price").notNull(), // USDC per call
    priceRules: jsonb("price_rules").$type<ApiPriceRule[]>().notNull().default([]),
    walletAddress: text("wallet_address").notNull(),
    allowedMethods: jsonb("allowed_methods").$type<string[]>().notNull().default(["GET"]),
    payerAllowlist: jsonb("payer_allowlist").$type<string[] | null>(),
    payerDenylist: jsonb("payer_denylist").$type<string[]>().notNull().default([]),
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
    // Issue #30: price callers pay for a time-limited access pass (null = passes not offered).
    passPrice: text("pass_price"),
    // Issue #32: free calls a new wallet may make per day before the paywall kicks in (0 = disabled).
    freeCallsPerDay: integer("free_calls_per_day").notNull().default(0),
    // Soft delete: archived APIs are hidden everywhere but keep their call history.
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    ownerIdx: index("apis_owner_id_idx").on(table.ownerId),
    activeIdx: index("apis_active_idx").on(table.active),
  })
);

export const apiCreditBalances = pgTable(
  "api_credit_balances",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    apiId: text("api_id")
      .notNull()
      .references(() => apis.id),
    walletAddress: text("wallet_address").notNull(),
    balance: integer("balance").notNull().default(0),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    apiWalletIdx: uniqueIndex("idx_api_credit_balances_api_wallet").on(
      table.apiId,
      table.walletAddress,
    ),
    nonNegativeBalance: check("api_credit_balances_balance_check", sql`${table.balance} >= 0`),
  }),
);

export const apiCreditLedger = pgTable(
  "api_credit_ledger",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    apiId: text("api_id")
      .notNull()
      .references(() => apis.id),
    walletAddress: text("wallet_address").notNull(),
    delta: integer("delta").notNull(),
    entryType: text("entry_type").$type<"purchase" | "spend">().notNull(),
    reference: text("reference"),
    requestNonce: text("request_nonce"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    purchaseReferenceIdx: uniqueIndex("idx_api_credit_ledger_purchase_reference")
      .on(table.reference)
      .where(sql`${table.entryType} = 'purchase'`),
    spendNonceIdx: uniqueIndex("idx_api_credit_ledger_spend_nonce").on(
      table.apiId,
      table.walletAddress,
      table.requestNonce,
    ).where(sql`${table.entryType} = 'spend'`),
    apiWalletCreatedIdx: index("idx_api_credit_ledger_api_wallet_created").on(
      table.apiId,
      table.walletAddress,
      table.createdAt,
    ),
    validEntryType: check(
      "api_credit_ledger_entry_type_check",
      sql`${table.entryType} in ('purchase', 'spend')`,
    ),
  }),
);

// API calls — one row per proxied call, charged or not
export const apiCalls = pgTable(
  "api_calls",
  {
    id: serial("id").primaryKey(),
    apiId: integer("api_id")
      .notNull()
      .references(() => apis.id, { onDelete: "cascade" }),
    method: text("method").notNull(),
    path: text("path").notNull(),
    statusCode: integer("status_code"),
    charged: boolean("charged").notNull().default(false),
    amount: text("amount"),
    asset: text("asset"),
    payer: text("payer"),
    txHash: text("tx_hash"),
    settlementTx: text("settlement_tx"),
    latencyMs: integer("latency_ms"),
    requestHeaders: jsonb("request_headers"),
    responseHeaders: jsonb("response_headers"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    apiIdIdx: index("api_calls_api_id_idx").on(table.apiId),
    createdAtIdx: index("api_calls_created_at_idx").on(table.createdAt),
    chargedIdx: index("api_calls_charged_idx").on(table.charged),
    settlementTxIdx: index("api_calls_settlement_tx_idx").on(
      table.settlementTx
    ),
  })
);

// API passes (#30) — time-limited access tokens purchased via x402.
// A caller with an active pass is not charged per call until the pass expires.
export const apiPasses = pgTable(
  "api_passes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    apiId: text("api_id")
      .notNull()
      .references(() => apis.id),
    payerAddress: text("payer_address").notNull(),
    // USDC amount paid for the pass.
    amount: text("amount").notNull(),
    // Settlement transaction hash from x402 (null until settled).
    txHash: text("tx_hash"),
    activeFrom: timestamp("active_from").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    // The primary lookup: "does this payer have an active pass for this API?"
    apiPayerExpiresIdx: index("idx_api_passes_api_payer_expires").on(
      table.apiId,
      table.payerAddress,
      table.expiresAt,
    ),
  }),
);

export type ApiPassRow = typeof apiPasses.$inferSelect;
