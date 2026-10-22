# x402 Payment Troubleshooting

Payment and signing failures are the most common support issues in ZentrixPay. This guide covers the top failure modes, how they differ between browser wallets and MCP agents, and how to inspect transactions on Stellar Explorer.

## Quick checklist

Before diving into a specific error, confirm:

1. **Network** — ZentrixPay runs on **Stellar testnet** (`stellar:testnet`). Your wallet, MCP agent, and the server's `NETWORK` env must all match.
2. **USDC balance** — The payer needs enough USDC for the API's per-call price **plus** a small reserve for fees.
3. **USDC trustline** — Classic Stellar accounts must trust the testnet USDC issuer before they can hold or send USDC.
4. **x402-aware client** — Plain `curl` without payment handling will stop at HTTP 402. Use an x402 client (`@x402/fetch`, the MCP server, or a wallet-integrated browser flow).

For a step-by-step look at the 402 handshake, see the [curl walkthrough](curl-402-walkthrough.md).

---

## Symptom → cause → fix

### HTTP 402 returned but the client never retries

**Cause:** The client does not implement the x402 payment flow. A 402 response includes a `PAYMENT-REQUIRED` header with price, destination wallet, network, asset contract, and scheme. The client must sign a Soroban USDC authorization and retry with an `X-Payment` header.

**Fix:**

- **Browser:** Use a wallet-connected flow that signs Soroban auth entries (Freighter via `@creit.tech/stellar-wallets-kit`).
- **Agents / scripts:** Use `@x402/fetch` with an `x402Client` registered for `stellar:testnet`, or the ZentrixPay MCP tool `zentrixpay_call`.
- **Manual test:** Run `pnpm --filter server e2e` — it implements the full 402 → pay → retry cycle.

```bash
curl -i https://your-server/api/<api-id>/<path>
# Expect: HTTP/1.1 402 Payment Required
# Header: PAYMENT-REQUIRED: eyJ4NDAy...
```

---

### Bad or expired authorization entry

**Symptoms:** 402 on retry, facilitator `/verify` rejection, or "invalid payment" errors.

**Causes:**

- The signed auth entry was built for a **different price** than the server currently expects (the provider changed the price after signing).
- The auth entry **expired** (Soroban auth entries have a limited ledger window).
- The entry was signed for the **wrong network** or **wrong asset contract**.
- The retry reused an old `X-Payment` header from a previous attempt.

**Fix:**

1. Fetch a fresh 402 response (do not reuse cached payment headers).
2. Sign a new authorization against the current price from the `PAYMENT-REQUIRED` payload.
3. Retry immediately after signing — do not store auth entries for later.
4. Confirm `NETWORK=stellar:testnet` in server config and that your signer uses the testnet passphrase.

---

### Insufficient USDC balance

**Symptoms:** Wallet or facilitator rejects the transfer; Horizon shows balance below required amount.

**Fix:**

1. Check balance on [Stellar Explorer (testnet)](https://stellar.expert/explorer/testnet) or via Horizon:
   ```bash
   curl https://horizon-testnet.stellar.org/accounts/<G-address>
   ```
2. Fund testnet USDC from [faucet.circle.com](https://faucet.circle.com).
3. Ensure the balance covers **price + fees**. Soroban USDC transfers are small but not free.

---

### Missing USDC trustline

**Symptoms:** Account exists but USDC balance is 0 or transfers fail with trustline errors.

**Cause:** Classic Stellar accounts must explicitly trust the USDC issuer before receiving USDC. Sponsored MCP agent accounts establish this automatically; manually created accounts may not.

**Fix:**

- **MCP agents:** Run `zentrixpay_setup_wallet` — the sponsored account service creates the account and trustline.
- **Manual wallets:** Add a trustline to testnet USDC (issuer from Circle's testnet docs) via Freighter or the Stellar Laboratory.
- Verify on Explorer: open the account → **Balances** → confirm USDC appears.

---

### Wrong network (testnet vs mainnet)

**Symptoms:** Signatures verify locally but facilitator rejects them; transactions never appear on the expected Explorer network.

**Fix:**

1. Server: `NETWORK=stellar:testnet`, `SOROBAN_RPC_URL=https://soroban-testnet.stellar.org`.
2. Wallet: switch Freighter (or other wallet) to **Testnet**.
3. MCP: `NETWORK` is hardcoded to `stellar:testnet` in `mcp/src/index.ts`; do not point agents at mainnet keys.
4. Explorer: use [testnet](https://stellar.expert/explorer/testnet), not public/mainnet.

---

### Facilitator settle errors

**Symptoms:** Payment verifies but settlement fails; server returns 402 or 500 after retry; logs mention facilitator errors.

**Causes:**

- Facilitator downtime or rate limits at `https://www.x402.org/facilitator`.
- Soroban RPC unreachable (settlement submits on-chain).
- Malformed `X-Payment` header (truncated base64, wrong JSON structure).

**Fix:**

1. Check server readiness: `GET /health/ready` — confirms DB and Soroban RPC are up.
2. Retry after a short delay; auth entries expire quickly so you may need a fresh 402 cycle.
3. Inspect the facilitator response in server logs.
4. Override `FACILITATOR_URL` only if you operate a compatible facilitator.

---

### HTTP 429 Too Many Requests

**Symptoms:** `429` with `Retry-After` header on `POST /apis`.

**Cause:** Rate limits protect API registration. Limits apply per IP and per provider wallet.

**Fix:** Wait for the `Retry-After` seconds indicated in the response. Tune limits via `RATE_LIMIT_*` env vars (see `server/.env.example`) if you operate a high-traffic deployment.

---

## Browser (stellar-wallets-kit) vs MCP / agent signing

| Aspect | Browser (web app) | MCP / agent |
|--------|-------------------|-------------|
| Wallet setup | User connects Freighter, xBull, Albedo, etc. via `@creit.tech/stellar-wallets-kit` | `zentrixpay_setup_wallet` creates a sponsored testnet account in memory |
| Signing | Wallet kit bridges to x402's `ClientStellarSigner`; user approves in extension | `createEd25519Signer(secretKey)` + `wrapFetchWithPayment` — fully programmatic |
| Payment flow | "Try it" in the catalog triggers a signed retry | `zentrixpay_call` handles 402 → sign → retry automatically |
| Trustline | User must fund and trust USDC themselves | Sponsored account service establishes trustline |
| Persistence | Wallet keys stay in the browser extension | Agent secret key is **in-memory only** — lost when MCP process exits |
| Typical failures | User on wrong network in wallet; popup blocked; insufficient balance | Forgot `zentrixpay_setup_wallet`; stale in-memory wallet; insufficient USDC |

**Browser tip:** If Freighter shows "Wrong network", switch to Testnet in the extension before signing.

**Agent tip:** Check the wallet's balance and address before `zentrixpay_call` (see [pay-per-call MCP tools](mcp-pay-per-call.md)).

---

## Inspecting transactions on Stellar Explorer

ZentrixPay payments are real on-chain activity on **Stellar testnet**.

### Find an account

1. Open [stellar.expert/explorer/testnet](https://stellar.expert/explorer/testnet).
2. Paste the **G-address** (provider payout wallet or caller wallet).
3. Review **Balances** (USDC trustline + amount) and **History** (payments, contract invocations).

### Find a transaction

- **x402 USDC payments:** Search the payer or recipient G-address → look for **Payment** or Soroban **Invoke Host Function** entries involving USDC.
- **Settlement hash for a call:** every charged call records its transaction hash. Callers can list theirs with `GET /payers/<G-address>/calls`; providers see recent calls in `GET /apis/<api-id>/stats`.

### Server-side checks

```bash
curl https://your-server/health/ready
curl "https://your-server/payers/<G-address>/calls?limit=10"
```

---

## Still stuck?

1. Reproduce with a minimal x402 client (`pnpm --filter server e2e`).
2. Check `/health/ready` for dependency failures. Failed checks report a stable code (`database_unavailable`, `soroban_rpc_unavailable`); the underlying error is only in server logs under `event: "readiness_probe_failed"`.
3. Open a GitHub issue with: network, endpoint, HTTP status, whether browser or agent, and the payer G-address (never post secret keys).
