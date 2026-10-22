# Environment Variables

All variables are read by `server/src/config.ts` using Zod validation. If a required variable is missing or malformed, the server exits with a descriptive error at startup.

Copy `server/.env.example` to `server/.env` and fill in the values before running locally.

---

## Server

The full, per-variable table for the gateway server — including the proxy,
health-check and webhook settings — is in [server-env.md](server-env.md). The
variables most deployments touch:

| Variable              | Required | Default                            | Description                                                                                         |
| --------------------- | -------- | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `PORT`                | no       | `4021`                             | TCP port the Express server listens on.                                                             |
| `BASE_URL`            | no       | `http://localhost:4021`            | Public base URL. Used to build each API's `proxyUrl`. Set to your deployed origin in production.     |
| `DATABASE_URL`        | **yes**  | —                                  | Postgres connection string. **Never commit this value.**                                            |
| `STELLAR_NETWORK`     | no       | `testnet`                          | `testnet` or `mainnet`; fills the network-specific defaults below.                                  |
| `NETWORK`             | no       | from `STELLAR_NETWORK`             | x402 network identifier (`stellar:testnet` or `stellar:pubnet`).                                    |
| `FACILITATOR_URL`     | no       | `https://www.x402.org/facilitator` | x402 facilitator endpoint used to verify and settle payments.                                       |
| `UPSTREAM_SECRET_KEY` | no       | —                                  | 64 hex chars. Encrypts providers' upstream secrets at rest. **Never commit this value.**             |

Callers pay each provider's own wallet directly: the payee of a call is the
`walletAddress` stored on the API, not a platform wallet.

Some variables (`AGENT_SECRET_KEY`, `VAULT_REGISTRY_CONTRACT_ID`,
`REGISTRY_SECRET_KEY`, `OPENROUTER_API_KEY`, the Supabase storage settings, …)
belong to the old resource vault. See
[server-env.md — Legacy vault variables](server-env.md#legacy-vault-variables).

---

## MCP limits

### MCP automatic payment ceiling

`zentrixpay_buy` will not automatically settle an x402 payment above
`ZENTRIXPAY_MAX_AUTO_PAY_USDC`, which defaults to `10` USDC. Set this environment
variable to a non-negative decimal amount with up to seven decimal places to
adjust the ceiling.

For a resource above the configured ceiling, pass `maxAutoPayUsdc` to
`zentrixpay_buy` with an amount at least equal to the advertised price. This is a
per-call override; it does not change the configured default.

```bash
ZENTRIXPAY_MAX_AUTO_PAY_USDC=5
```

### MCP catalog preview size limits

Titles and descriptions are publisher-supplied and unbounded at the source, so a
single listing could otherwise fill an agent's context window. `zentrixpay_preview`
caps them before the response is serialized:

- Each free-text field (`title`, `description`) is clipped to
  `ZENTRIXPAY_PREVIEW_FIELD_MAX_CHARS` characters (default `1000`).
- If the serialized response is still larger than `ZENTRIXPAY_PREVIEW_MAX_BYTES`
  (default `8192`), the description and then the title are shrunk further until
  it fits. A non-zero budget below `1024` is raised to `1024`, the room the
  identity fields and the truncation notice need.

Set either variable to `0` to disable that limit.

Identity fields — `id`, `price`, `accessUrl`, `type`, `verificationStatus` — are
never shortened, and the limit is applied per field rather than to the encoded
JSON, so the response is always parseable. When anything was clipped, the
response carries a `truncated` block:

```json
{
  "id": "cm7x8y9z",
  "title": "Stellar Payments Dataset",
  "description": "Ledger-level payment records… [truncated: 1000 of 54321 characters]",
  "price": "$1.5 USDC",
  "accessUrl": "https://example.com/cm7x8y9z",
  "truncated": {
    "fields": ["description"],
    "notice": "Preview shortened to fit the response size limit. Buy the resource for the full content, or raise ZENTRIXPAY_PREVIEW_MAX_BYTES / ZENTRIXPAY_PREVIEW_FIELD_MAX_CHARS."
  }
}
```

```bash
ZENTRIXPAY_PREVIEW_MAX_BYTES=16384
ZENTRIXPAY_PREVIEW_FIELD_MAX_CHARS=2000
```

---

## Diagnosing Missing Variables

If the server exits immediately on startup, the Zod validation error will list every missing or invalid variable:

```
Invalid environment variables:
{
  PAY_TO: [ "PAY_TO (platform wallet address) is required" ],
  AGENT_SECRET_KEY: [ "AGENT_SECRET_KEY (platform agent secret) is required" ]
}
```

Fix each item in `server/.env` and restart.

---

## Secrets Checklist

The following values **must never be committed** to version control:

- `DATABASE_URL` — direct Postgres access including password
- `UPSTREAM_SECRET_KEY` — decrypts every provider's upstream credentials
- `METRICS_TOKEN` — access to the `/metrics` endpoint
- any legacy vault secrets still set (`AGENT_SECRET_KEY`, `REGISTRY_SECRET_KEY`, `OPENROUTER_API_KEY`, `SUPABASE_SERVICE_KEY`)

All other variables are either public addresses or non-sensitive configuration. `server/.env` is in `.gitignore`; verify before committing.

---

## MCP

| Variable                            | Required | Default   | Description                                                                                                                                             |
| ----------------------------------- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STELLAR_NETWORK`                   | no       | `testnet` | MCP deployment target (`testnet` or `mainnet` / `pubnet` / `public`).                                                                                   |
| `ZENTRIXPAY_ALLOW_MAINNET`           | no       | unset     | Set to `1` / `true` / `yes` to allow gated MCP mutations and buys on mainnet without per-call `confirmMainnet`. Parsed fail-safe: anything else — `0` / `false` / `no` / `off`, or an unrecognized value — keeps per-call confirmation, and a set-but-ineffective value raises a startup warning (#606). |
| `ZENTRIXPAY_READ_ONLY`               | no       | unset     | Set to `1` / `true` / `yes` / `on` to restrict the MCP server to catalog browsing. Only read-only tools are advertised and all others are refused.      |
| `ZENTRIXPAY_CONFIRM_PAID_OPERATIONS` | no       | `off`     | `off`, `usdc`, or `all`. Requires `confirmPaid: true` on tools that spend, independently of network. An unrecognized value is an error, not a fallback. |
| `ZENTRIXPAY_HTTP_TIMEOUT_MS`         | no       | `15000`   | Request deadline for the ZentrixPay API and sponsored-account service. `0` disables.                                                                     |
| `ZENTRIXPAY_HORIZON_TIMEOUT_MS`      | no       | `15000`   | Request deadline for Horizon balance/account reads. `0` disables.                                                                                       |
| `ZENTRIXPAY_SOROBAN_TIMEOUT_MS`      | no       | `20000`   | Request deadline for Soroban RPC calls. `0` disables.                                                                                                   |
| `ZENTRIXPAY_PAYMENT_TIMEOUT_MS`      | no       | `45000`   | Request deadline for x402 paid fetches, which include on-chain settlement. `0` disables.                                                                |
| `ZENTRIXPAY_RETRY_ATTEMPTS`          | no       | `3`       | Total attempts (including the first) for idempotent MCP calls. `1` disables retrying.                                                                   |
| `ZENTRIXPAY_RETRY_BASE_DELAY_MS`     | no       | `250`     | Backoff delay before the first retry; doubles each attempt.                                                                                             |
| `ZENTRIXPAY_RETRY_MAX_DELAY_MS`      | no       | `4000`    | Ceiling on the backoff delay before jitter is applied.                                                                                                  |
| `ZENTRIXPAY_PREVIEW_MAX_BYTES`       | no       | `8192`    | Byte ceiling for a `zentrixpay_preview` response. `0` disables; values below `1024` are raised to it.                                                    |
| `ZENTRIXPAY_PREVIEW_FIELD_MAX_CHARS` | no       | `1000`    | Character ceiling for each free-text preview field (`title`, `description`). `0` disables.                                                              |

Timeouts are enforced with `AbortController`. Retries apply to idempotent calls only — catalog `GET`s, Horizon reads, and Soroban `getTransaction` — and never to x402 payments, which could settle twice. See [`mcp-timeouts-retries.md`](./mcp-timeouts-retries.md) for budgets, policy, and tuning guidance.

### MCP mainnet guardrails

When the MCP server runs with `STELLAR_NETWORK=mainnet` (or x402 `stellar:pubnet`), tools that **mutate state or spend funds** require an explicit confirmation. Read-only tools stay unrestricted.

**Gated tools:** `zentrixpay_setup_wallet`, `zentrixpay_register`, `zentrixpay_publish`, `zentrixpay_buy`, `zentrixpay_register_onchain`, `zentrixpay_reset`, `zentrixpay_update_metadata`, `zentrixpay_set_price`, `zentrixpay_transfer_ownership`, `zentrixpay_set_listed`.

**Confirm either:**

1. Pass `confirmMainnet: true` on the tool call, or
2. Set `ZENTRIXPAY_ALLOW_MAINNET=1` on the MCP process (unlocks all gated tools for that process).

**Safer defaults for `ZENTRIXPAY_ALLOW_MAINNET` (#606):** the env override is parsed fail-safe. Only `1` / `true` / `yes` widen the policy to process-wide `allow-all`; everything else — unset, empty, `0` / `false` / `no` / `off`, and any unrecognized value — keeps per-call confirmation. A set value that unlocks nothing (an unexpanded `$ZENTRIXPAY_ALLOW_MAINNET` template placeholder, `on`, `enabled`, a typo) is reported as a startup **warning** so the deployment mistake surfaces immediately; explicit denials stay quiet because they state intent. A typo in a safety setting fails towards *more* confirmation, never less.

Without confirmation the tool returns a deterministic, agent-safe error (no secrets). Diagnostics also appear in `zentrixpay_registry_info` (`network`, `x402Network`, `mainnetDiagnostics`).

```json
{ "resourceId": "res-001", "confirmMainnet": true }
```

### MCP read-only mode

`ZENTRIXPAY_READ_ONLY=1` turns the MCP server into a catalog browser. It is set on the server process and cannot be lifted by a tool argument — unlike `confirmMainnet`, which an agent supplies from inside the very call you wanted to prevent.

Two things change together. `tools/list` advertises only tools whose definition declares `readOnlyHint: true`, so an agent does not plan around a tool it cannot use; and the dispatcher refuses every other tool, so a client working from a cached tool list — or guessing a name — is still stopped. The refusal names the tools that remain available.

Read-only classification comes from the `readOnlyHint` annotation each tool already advertises, so a tool added later is covered by whatever it declares about itself.

```
ZENTRIXPAY_READ_ONLY=1
```

Browsing, search, preview, registry lookups, wallet info, purchase history, and the diagnostic tools stay available. Everything that mutates state, spends funds, or changes stored credentials is refused — including dry runs, which are exempt from the paid-operation policy below but not from this one: read-only mode is about what the server is for, not about what a call costs.

### MCP paid-operation confirmation

`ZENTRIXPAY_CONFIRM_PAID_OPERATIONS` requires an explicit `confirmPaid: true` before a tool spends from the agent wallet. It is independent of the network (unlike the mainnet guardrail, which never fires on testnet) and of the amount (unlike `ZENTRIXPAY_MAX_AUTO_PAY_USDC`, which stops one large purchase but not a hundred small ones).

| Value  | Effect                                                                                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`  | Default. No confirmation required. The mainnet guardrail and the auto-pay ceiling still apply.                                                             |
| `usdc` | `zentrixpay_publish` and `zentrixpay_buy` require `confirmPaid: true`.                                                                                       |
| `all`  | Additionally `zentrixpay_register_onchain`, `zentrixpay_update_metadata`, `zentrixpay_set_price`, `zentrixpay_transfer_ownership`, and `zentrixpay_set_listed`. |

```
ZENTRIXPAY_CONFIRM_PAID_OPERATIONS=usdc
```

Dry runs (`dryRun: true` on publish or buy) are never gated — they submit no payment, and requiring confirmation would mean confirming a spend in order to find out what the spend would be. `zentrixpay_setup_wallet` is not gated either: account creation runs through the sponsored-account service, so the agent's own wallet funds nothing.

The policies compose rather than replace one another. A mainnet buy above the auto-pay ceiling with `ZENTRIXPAY_CONFIRM_PAID_OPERATIONS=usdc` must satisfy all three guardrails; `confirmPaid` does not stand in for `confirmMainnet`, or the reverse.

An unrecognized value (`true`, `1`, `yes`) raises an error on the first paid call rather than silently falling back to `off`. A typo in a safety setting that quietly disables it is worse than one that fails loudly.

---

## Mainnet-Specific Notes

When deploying to mainnet, change:

- `STELLAR_NETWORK` → `mainnet` (or set `NETWORK` → `stellar:pubnet` and the related variables explicitly)
- `BASE_URL` → your production domain
- `ALLOWED_ORIGINS` → your production web origin(s)

See [server-env.md — Mainnet values](server-env.md#mainnet-values) for the full list.
