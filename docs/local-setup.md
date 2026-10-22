# Local Setup Guide

This guide takes you from a fresh clone to a running gateway server and web app. ZentrixPay uses **Stellar testnet** — no real funds are needed or at risk.

## 1. Prerequisites

- **Node.js 20+**
- **pnpm** (`corepack enable`, or `npm i -g pnpm`)
- A **Postgres** database — a local instance, Docker (`docker compose up -d`), or a hosted one such as [Supabase](supabase-setup.md)

## 2. Clone and install

```bash
git clone <your-fork-url> zentrixpay
cd zentrixpay
pnpm install
```

## 3. Environment variables

1. Copy the example file:
   ```bash
   cp server/.env.example server/.env
   ```
2. In `server/.env`, set:
   - **`DATABASE_URL`** — your Postgres connection string.
   - **`UPSTREAM_SECRET_KEY`** — 64 hex characters, used to encrypt providers' upstream secrets. Generate one with `openssl rand -hex 32`.

`server/src/config.ts` still validates a few variables left over from the old resource vault (`PAY_TO`, `AGENT_SECRET_KEY`, `VAULT_REGISTRY_CONTRACT_ID`, `REGISTRY_CONTRACT_ID`, `REGISTRY_SECRET_KEY`, `OPENROUTER_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`). The gateway does not use them, so the placeholder values in `server/.env.example` are enough — just don't delete those lines.

For every variable, see [Server environment variables](server-env.md). **Never commit `server/.env`.**

## 4. Database

Run the migrations:

```bash
make migrate
```

## 5. Run

Start the server (`:4021`) and the web app (`:5173`):

```bash
make dev
```

Check it is up:

```bash
curl -s http://localhost:4021/health
```

## 6. Try it end to end

You need a testnet wallet with XLM and USDC for both sides — see the [Stellar testnet funding guide](stellar-testnet-funding.md). Then follow the [Provider Quickstart](provider-quickstart.md) against `http://localhost:4021` to register as a provider, add an API and make your first paid call.

When testing against an upstream on your own machine, set `PROXY_ALLOW_PRIVATE_UPSTREAMS=true` — by default the gateway refuses to proxy to private or loopback addresses.

## Troubleshooting

- **Wallet connection issues:** [Wallet Connection Troubleshooting](wallet-connection-troubleshooting.md)
- **x402 payment or signing failures:** [x402 Payment Troubleshooting](x402-payment-troubleshooting.md)
