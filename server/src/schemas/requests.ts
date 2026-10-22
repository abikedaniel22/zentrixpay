import { z } from "zod/v4";

export const publisherRegisterSchema = z
  .object({
    name: z.string().min(1),
    email: z.email(),
    walletAddress: z.string().min(1),
  })
  .strict();

export const CATALOG_DEFAULT_LIMIT = 20;
export const CATALOG_MAX_LIMIT = 100;

// ── Pay-per-call APIs ─────────────────────────────────────────────────────────

export const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const usdcPrice = z
  .string()
  .regex(/^\d+(\.\d{1,7})?$/, "price must be a USDC amount with at most 7 decimals")
  .refine((v) => Number(v) > 0, "price must be greater than 0");

const apiPriceRule = z
  .object({
    method: z.enum(API_METHODS),
    pathPattern: z
      .string()
      .min(1)
      .max(512)
      .refine((path) => path.startsWith("/") && !/[?#\\\r\n]/.test(path), {
        message: "pathPattern must be an absolute path without query or fragment",
      }),
    price: usdcPrice,
  })
  .strict();

const apiPriceRules = z
  .array(apiPriceRule)
  .max(100)
  .superRefine((rules, ctx) => {
    const seen = new Set<string>();
    rules.forEach((rule, index) => {
      const key = `${rule.method}:${rule.pathPattern}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: "method and pathPattern must be unique",
          path: [index, "pathPattern"],
        });
      }
      seen.add(key);
    });
  });

const stellarAddress = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, "walletAddress must be a Stellar public key (G...)");

// Headers the proxy itself controls; a provider secret may not use these names.
const RESERVED_HEADER_NAMES = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "cookie",
  "x-payment",
  "payment-signature",
]);

const upstreamHeader = z
  .object({
    name: z
      .string()
      .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "header name contains invalid characters")
      .refine((n) => !RESERVED_HEADER_NAMES.has(n.toLowerCase()), "header name is reserved"),
    value: z
      .string()
      .min(1)
      .max(4096)
      .refine((v) => !/[\r\n\0]/.test(v), "header value must not contain line breaks"),
  })
  .strict();

// Query parameter names the proxy may not overwrite with a provider secret.
const upstreamQueryParam = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._~-]+$/, "query parameter name contains invalid characters"),
    value: z
      .string()
      .min(1)
      .max(4096)
      .refine((v) => !/[\r\n\0]/.test(v), "query parameter value must not contain line breaks"),
  })
  .strict();

// OpenAPI 3 document: JSON/YAML text or an already-parsed JSON object. Size and
// structure are checked in services/openApiSpec.ts.
const openapiSpec = z.union([z.string().min(1), z.record(z.string(), z.unknown())]);

// Signed with HMAC-SHA256; the secret is shared with the provider's receiver.
const webhook = z
  .object({
    url: z.url(),
    secret: z.string().min(16).max(256),
  })
  .strict();

// Pinged relative to the upstream URL, like a proxied call to /api/:id<healthPath>.
const healthPath = z
  .string()
  .max(512)
  .regex(/^\/[^\s#]*$/, "healthPath must start with / and contain no spaces or fragment");

// The upper bound (PROXY_MAX_RESPONSE_BYTES) is enforced by the service.
const maxResponseBytes = z.number().int().min(1024);

const tagList = z.array(z.string().trim().min(1).max(32).toLowerCase()).max(10);

export const PAYER_LIST_MAX = 500;

const payerList = z
  .array(z.string().regex(/^G[A-Z2-7]{55}$/, "payer lists must hold Stellar public keys (G...)"))
  .max(PAYER_LIST_MAX)
  .transform((list) => [...new Set(list)]);

export const createApiSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).optional(),
    upstreamUrl: z.url(),
    price: usdcPrice,
    priceRules: apiPriceRules.default([]),
    walletAddress: stellarAddress.optional(),
    allowedMethods: z.array(z.enum(API_METHODS)).min(1).default(["GET"]),
    upstreamHeader: upstreamHeader.optional(),
    upstreamQueryParam: upstreamQueryParam.optional(),
    openapiSpec: openapiSpec.optional(),
    timeoutMs: z.number().int().min(1000).optional(),
    maxResponseBytes: maxResponseBytes.optional(),
    webhook: webhook.optional(),
    healthPath: healthPath.optional(),
    tags: tagList.default([]),
    // Only these wallets may call the API; omit to allow everyone.
    payerAllowlist: payerList.optional(),
    payerDenylist: payerList.default([]),
    // Issue #30: price of a time-limited access pass (null/omit = passes not offered).
    passPrice: usdcPrice.optional(),
    // Issue #32: how many free calls a wallet gets per day before the paywall kicks in.
    freeCallsPerDay: z.number().int().min(0).default(0),
  })
  .strict();

export const updateApiSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(2000).nullable().optional(),
    upstreamUrl: z.url().optional(),
    price: usdcPrice.optional(),
    priceRules: apiPriceRules.nullable().optional(),
    walletAddress: stellarAddress.optional(),
    allowedMethods: z.array(z.enum(API_METHODS)).min(1).optional(),
    upstreamHeader: upstreamHeader.nullable().optional(),
    upstreamQueryParam: upstreamQueryParam.nullable().optional(),
    openapiSpec: openapiSpec.nullable().optional(),
    timeoutMs: z.number().int().min(1000).nullable().optional(),
    maxResponseBytes: maxResponseBytes.nullable().optional(),
    webhook: webhook.nullable().optional(),
    healthPath: healthPath.nullable().optional(),
    tags: tagList.optional(),
    // null removes the allowlist, opening the API to every wallet again.
    payerAllowlist: payerList.nullable().optional(),
    payerDenylist: payerList.optional(),
    listed: z.boolean().optional(),
    // Issue #30: null disables passes; a new price enables / reprices them.
    passPrice: usdcPrice.nullable().optional(),
    // Issue #32: 0 disables free calls.
    freeCallsPerDay: z.number().int().min(0).optional(),
  })
  .strict();

export const apiCreditPurchaseSchema = z
  .object({
    calls: z.number().int().min(1).max(10_000),
  })
  .strict();

export const apiCreditBalanceQuerySchema = z
  .object({
    walletAddress: stellarAddress,
  })
  .strict();

export const apiCatalogSortValues = ["newest", "price_asc", "price_desc", "popular"] as const;

export const apiCatalogQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  // ?tag=a&tag=b — repeatable; an API must carry every requested tag.
  tag: z
    .preprocess(
      (v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]),
      z.array(z.string().trim().min(1).max(32).toLowerCase()).max(10),
    )
    .optional(),
  sort: z.enum(apiCatalogSortValues).default("newest"),
  limit: z.coerce.number().int().min(1).max(CATALOG_MAX_LIMIT).default(CATALOG_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});
