# Request Signatures (Optional)

Provider mutations (registering, updating, archiving and verifying APIs, and rotating the API key) can require an HMAC-SHA256 request signature in addition to the API key. This limits replay and tampering if an API key leaks.

**Off by default.** Set `REQUIRE_REQUEST_SIGNATURE=true` on the server to enforce signatures.

## Headers

| Header            | Description                                             |
| ----------------- | ------------------------------------------------------- |
| `x-api-key`       | Provider API key (also the HMAC secret)                 |
| `X-Timestamp`     | Unix time in **seconds** when the request was signed    |
| `X-Signature`     | Lowercase hex HMAC-SHA256 of the canonical string       |
| `Idempotency-Key` | Optional; included in the canonical string when present |

## Canonical string

Join with newline (`\n`):

```
METHOD
PATH
TIMESTAMP
BODY_SHA256_HEX
[IDEMPOTENCY_KEY]
```

- **METHOD** — uppercase HTTP verb (`POST`, `DELETE`, …)
- **PATH** — path and query only (e.g. `/apis/abc/verify-ownership`, no scheme/host)
- **TIMESTAMP** — same value as the `X-Timestamp` header (string)
- **BODY_SHA256_HEX** — SHA-256 hex digest of the request body (see below)
- **IDEMPOTENCY_KEY** — only when the `Idempotency-Key` header is sent

Compute the signature:

```
X-Signature = HMAC-SHA256(secret=api_key, message=canonical_string)
```

Use `crypto.timingSafeEqual` (or equivalent) when comparing on the server.

## Body hash

### JSON requests

Hash the **exact raw UTF-8 bytes** sent as the body:

```js
bodyHash = sha256(rawBody).hex();
```

For an empty body (e.g. `DELETE`, or `POST` with no payload):

```
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

## Timestamp window

Reject requests when `|now - timestamp|` exceeds `SIGNATURE_MAX_SKEW_MS` (default **5 minutes** / `300000` ms). Stale or future-dated requests return `401` with `"Request timestamp outside allowed window"`.

## Protected routes

When enabled, signatures are required on:

- `POST /apis`
- `PATCH /apis/{id}`
- `DELETE /apis/{id}`
- `POST /apis/{id}/verify-ownership`
- `POST /publishers/me/rotate-key`

Read-only authenticated routes (`GET /publishers/me`, `GET /publishers/me/apis`, `GET /apis/{id}/stats`, etc.) are **not** signed.

## Server configuration

```env
# Off by default
REQUIRE_REQUEST_SIGNATURE=false
# Max clock skew when signatures are required (milliseconds)
SIGNATURE_MAX_SKEW_MS=300000
```

## Client examples

### Node.js (MCP server)

The MCP package signs mutating requests automatically when `x-api-key` is present. See `mcp/src/requestSignature.ts`.

### Web dashboard

The web app signs provider mutations via `web/src/api/requestSignature.ts` (`signedPublisherFetch`).

### curl (JSON)

```bash
API_KEY="zp_..."
METHOD="PATCH"
REQ_PATH="/apis/abc"
BODY='{"price":"0.02"}'
TS=$(date +%s)
BODY_HASH=$(printf '%s' "$BODY" | openssl dgst -sha256 -hex | awk '{print $2}')
CANONICAL=$(printf '%s\n%s\n%s\n%s' "$METHOD" "$REQ_PATH" "$TS" "$BODY_HASH")
SIG=$(printf '%s' "$CANONICAL" | openssl dgst -sha256 -hmac "$API_KEY" -hex | awk '{print $2}')

curl -X PATCH "http://localhost:4021$REQ_PATH" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "X-Timestamp: $TS" \
  -H "X-Signature: $SIG" \
  -d "$BODY"
```

## Error responses

| Status | `error` field                              |
| ------ | ------------------------------------------ |
| 401    | `Missing X-Timestamp header`               |
| 401    | `Missing X-Signature header`               |
| 401    | `Request timestamp outside allowed window` |
| 401    | `Invalid request signature`                |

When `REQUIRE_REQUEST_SIGNATURE=false`, unsigned requests behave as before (API key only).

## Client-side clock-skew diagnostics

The MCP server does not reason about your clock at signing time — it cannot
see the server's. But when the server does reject a signed request as stale,
the rejection is a **delta**: the MCP server stamps `X-Timestamp` with its own
`Date.now()`, and the server stamps it against its own. A 401 whose error says
`Request timestamp outside allowed window` is therefore classified as a
**system-clock problem**, not a credential problem.

`mcp/src/errorMapping.ts` detects that message and returns a targeted next step
instead of the "run `zentrixpay_register`" advice a revoked key would get:

```text
Publish failed: Request timestamp outside allowed window (request signature timestamp rejected as outside the allowed window)
Source: ZentrixPay API · Category: auth · HTTP 401
Next: The request signature was rejected because its timestamp fell outside the accepted 5-minute window — the local clock is probably skewed, not the key. Sync the system clock (e.g. enable NTP), then retry; the message disappears once the clocks agree.
```

The other three signature 401s (`Missing X-Timestamp`, `Missing X-Signature`,
`Invalid request signature`) are signing bugs, not clock problems, and are
never mislabelled as skew. The recognition logic lives in
[`mcp/src/requestSignature.ts`](../mcp/src/requestSignature.ts)
(`isClockSkewRejection`), and the window it quotes
(`CLOCK_SKEW_WINDOW_MS`, default **300000 ms / 5 minutes**) mirrors the
server's `SIGNATURE_MAX_SKEW_MS` default so the advice always matches the
server's actual tolerance. When you change the server window, set the same
value on the client by keeping `CLOCK_SKEW_WINDOW_MS` in sync.
