# Server environment variables

All variables live in `server/.env` (never committed). Copy `server/.env.example`
and fill in each value.

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | no | `development` | Runtime environment (`development`, `production`, `test`) |
| `PORT` | no | `4021` | HTTP listen port |
| `BASE_URL` | no | `http://localhost:4021` | Public base URL of the server |
| `WEB_APP_URL` | no | `http://localhost:5173` | Web app URL (used for CORS / redirects) |
| `ALLOWED_ORIGINS` | no | — | Comma-separated browser origins allowed in production (defaults to `WEB_APP_URL`) |
| `STELLAR_NETWORK` | no | `testnet` | Deployment network selector (`testnet` or `mainnet`). Fills defaults for RPC, USDC, and x402 network when individual vars are omitted |
| `NETWORK` | no | from `STELLAR_NETWORK` | x402 network id (`stellar:testnet` or `stellar:pubnet`; `stellar:mainnet` is accepted as an alias for pubnet) |
| `FACILITATOR_URL` | no | `https://www.x402.org/facilitator` | x402 facilitator endpoint for payment verification/settlement |
| `USDC_CONTRACT_ID` | no | from `STELLAR_NETWORK` | Soroban USDC Stellar Asset Contract for the selected network |
| `SOROBAN_RPC_URL` | no | from `STELLAR_NETWORK` | Soroban RPC endpoint for on-chain registry reads/writes |
| `DATABASE_URL` | **yes** | — | Postgres connection string |
| `REGISTRY_CONTRACT_ID` | **yes** | — | Deployed registry contract ID (APIs are registered on-chain here) |
| `REGISTRY_SECRET_KEY` | **yes** | — | Secret key of the registry deployer / owner account |
| `RATE_LIMIT_PUBLISH_IP_MAX` | no | `20` | Max API registrations per IP per window |
| `RATE_LIMIT_PUBLISH_IP_WINDOW_MS` | no | `60000` | API registration IP rate-limit window in ms |
| `RATE_LIMIT_PUBLISH_WALLET_MAX` | no | `10` | Max API registrations per provider wallet per window |
| `RATE_LIMIT_PUBLISH_WALLET_WINDOW_MS` | no | `3600000` | API registration wallet rate-limit window in ms |
| `RATE_LIMIT_REGISTER_IP_MAX` | no | `5` | Max publisher registrations (`POST /publishers`) per IP per window |
| `RATE_LIMIT_REGISTER_IP_WINDOW_MS` | no | `3600000` | Publisher registration IP rate-limit window in ms |
| `REQUEST_TIMEOUT_MS` | no | `30000` | Per-request timeout; slow upstreams return 503 |
| `GRACEFUL_SHUTDOWN_TIMEOUT_MS` | no | `10000` | Max time to drain in-flight requests on SIGTERM/SIGINT |
| `IDEMPOTENCY_TTL_MS` | no | `86400000` | How long a publish Idempotency-Key is remembered (24h) |
| `API_CALL_RETENTION_DAYS` | no | `180` | Days an API call record is kept before deletion. `0` keeps records forever; otherwise must be at least `90`. See [api-call-retention.md](api-call-retention.md) |
| `API_CALL_RETENTION_INTERVAL_MS` | no | `3600000` | How often expired API call records are purged (`0` disables the job) |
| `API_CALL_RETENTION_BATCH_SIZE` | no | `1000` | Max API call records deleted per statement (1–10000) |

## Mainnet values

Set `STELLAR_NETWORK=mainnet` (or set each variable explicitly). Required mainnet values:

| Variable | Mainnet value |
|---|---|
| `STELLAR_NETWORK` | `mainnet` |
| `NETWORK` | `stellar:pubnet` |
| `SOROBAN_RPC_URL` | `https://soroban.stellar.org` |
| `USDC_CONTRACT_ID` | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` |
| `VAULT_REGISTRY_CONTRACT_ID` | Your deployed mainnet vault-registry contract ID |
| `REGISTRY_CONTRACT_ID` | Your deployed mainnet registry contract ID |

Startup validation rejects mixed settings (for example, `STELLAR_NETWORK=testnet` with a mainnet Soroban RPC URL or USDC contract).
