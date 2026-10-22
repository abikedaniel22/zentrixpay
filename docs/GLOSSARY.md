# Glossary

Core terms used throughout the ZentrixPay gateway documentation and codebase.

---

## A

**Agent**
: An autonomous AI system (e.g. Claude Code, Codex) that calls paid APIs through ZentrixPay, either via the [MCP server](#m) or directly over HTTP with an [x402-aware client](#x). Agents pay per call from a Stellar wallet, just like any other caller.

**API**
: An upstream HTTP endpoint a [provider](#p) sells through the gateway. Each API has a name, a per-call price in USDC, a payout wallet, the HTTP methods callers may use, and optional upstream credentials. Registered with `POST /apis`.

**API Key**
: The provider credential sent in the `x-api-key` header to manage APIs and read stats. Issued once at registration (and on rotation) with a `zp_` prefix; only its SHA-256 hash is stored. Keys issued before the prefix change start with `mv_` and still work.

**Archived API**
: An API its owner deleted. It is unlisted and hidden everywhere, but its call history is kept so stats and analytics stay correct.

---

## C

**Call**
: One request proxied through `/api/:id/*`. Every call is recorded in `api_calls`, whether or not it was charged.

**Charged Call**
: A call the caller actually paid for — the upstream answered successfully and the x402 payment settled. Failed upstream calls are not charged.

**Correlation ID**
: A short ID (`zp-<time>-<random>`) the MCP server mints per tool call and stamps on every audit-log entry and outbound request for that call. See [MCP correlation IDs](mcp-correlation-ids.md).

---

## F

**Facilitator**
: The x402 payment verification and settlement service (default `https://www.x402.org/facilitator`). The gateway asks it to `/verify` a payment before calling the upstream and to `/settle` it afterwards.

**Freighter**
: A browser wallet extension for Stellar, used by the web app via `@creit.tech/stellar-wallets-kit`.

---

## G

**Gateway**
: The ZentrixPay server. It keeps the catalog of APIs, holds providers' upstream secrets, and sits in front of every paid call: it returns 402 to unpaid requests, forwards paid ones to the upstream, and settles payment only when the upstream succeeds. See [Architecture](architecture.md).

---

## H

**Health Check**
: A periodic request to an API's optional `healthPath`. After repeated failures the API is hidden from the catalog until a check succeeds again.

**HTTP 402 (Payment Required)**
: The status code the gateway returns to an unpaid call. The response carries a `PAYMENT-REQUIRED` header with machine-readable payment instructions.

---

## M

**MCP Server**
: The ZentrixPay [Model Context Protocol](https://modelcontextprotocol.io) server (`mcp/`). It lets agents list APIs and make paid calls (`zentrixpay_list_apis`, `zentrixpay_api_info`, `zentrixpay_call`) without handling x402 themselves. See [Pay-per-call MCP tools](mcp-pay-per-call.md).

---

## N

**Network**
: The Stellar network payments settle on — `stellar:testnet` for development, `stellar:pubnet` for mainnet. Wallets, the MCP server and the gateway must all agree.

---

## O

**Ownership Verification**
: Proof that a provider controls an API's upstream: the provider serves a token at `/.well-known/zentrixpay.txt` on the upstream host, then calls `POST /apis/:id/verify-ownership`. Unverified APIs are not listed.

---

## P

**Payer**
: The wallet that pays for a call. Payers can list their receipts with `GET /payers/:address/calls`.

**Payment-Required Header**
: A base64-encoded JSON header on 402 responses with the price, the provider's payout wallet, the USDC asset contract, the network and the payment scheme.

**Provider**
: Someone who sells APIs through the gateway. Registered with `POST /publishers` (the route name predates the gateway) and paid directly in USDC to their payout wallet on every charged call.

**Proxy URL**
: The paid entry point for an API: `<BASE_URL>/api/<api-id>`. Callers never see the upstream URL.

---

## R

**Revenue**
: The sum of the prices of an API's charged calls, in USDC. Available per API (`GET /apis/:id/stats`) and across all of a provider's APIs (`GET /publishers/me/analytics`).

---

## S

**SAC (Stellar Asset Contract)**
: The Soroban contract wrapping the classic USDC asset. x402 payments on Stellar are USDC transfers through its SAC interface.

**Soroban Authorization Entry**
: A signed authorization for a Soroban token transfer. x402 on Stellar uses one as the payment proof: the caller signs a USDC transfer to the provider and attaches it to the retried request.

**Sponsored Account**
: A Stellar account whose base reserve and USDC trustline are paid for by a sponsoring service, so an agent can get a working wallet with no upfront XLM. The MCP server uses one for new agent wallets.

**Stellar Testnet**
: Stellar's test network. Testnet USDC and XLM are free — see [Stellar testnet funding](stellar-testnet-funding.md).

---

## T

**Trustline**
: A Stellar ledger entry allowing a classic account to hold a non-native asset such as USDC. Accounts must trust the USDC issuer before they can pay or be paid.

---

## U

**Upstream**
: The provider's real API that the gateway forwards paid calls to. Its URL and any credentials (header or query parameter) are stored encrypted and never exposed to callers.

**USDC**
: The stablecoin all ZentrixPay prices and payments are denominated in.

---

## W

**Webhook**
: An optional, signed `POST` the gateway sends to a provider after each charged call.

---

## X

**x402**
: A protocol that standardizes HTTP 402 for machine-readable payments: the server returns payment instructions in `PAYMENT-REQUIRED`, and the client signs a payment and retries with an `X-Payment` header.

**x402-aware Client**
: A client that understands x402 — `@x402/fetch` in Node, the MCP server, or a wallet-integrated browser flow. See [Calling ZentrixPay APIs from JavaScript](call-from-javascript.md).

**X-Payment Header**
: The header an x402 client attaches to the retried request, carrying the signed payment.
