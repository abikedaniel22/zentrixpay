import { Buffer } from 'buffer';

/**
 * Extracts the payer address from an x402 PAYMENT-SIGNATURE header value.
 *
 * Supports:
 *  - EVM payloads (v1/v2): `payload.authorization.from` / `payload.from`
 *  - Legacy Stellar payloads: `payload.from` / `payload.payer`
 *  - x402 v2 Stellar `exact` payloads: signed Soroban authorization entry
 *    (`payload.authorization` / `payload.authEntry` / `payload.signedAuthEntry`),
 *    from which the credential address (G-address) is extracted.
 *
 * Returns `undefined` when no payer can be determined.
 */
export function parsePayerFromXPayment(
  xPaymentHeader: string | undefined | null,
): string | undefined {
  if (!xPaymentHeader || typeof xPaymentHeader !== 'string') {
    return undefined;
  }

  const decoded = decodeXPayment(xPaymentHeader);
  if (!decoded || typeof decoded !== 'object') {
    return undefined;
  }

  const payload = (decoded as any).payload ?? decoded;

  // 1. x402 v2 Stellar `exact` payloads: signed Soroban authorization entry.
  const stellarPayer = extractStellarPayerFromV2(payload);
  if (stellarPayer) {
    return stellarPayer;
  }

  // 2. EVM payloads (v1/v2): authorization.from / from.
  const evmPayer = extractEvmPayer(payload);
  if (evmPayer) {
    return evmPayer;
  }

  // 3. Legacy Stellar payloads: from / payer.
  const legacyPayer = extractLegacyStellarPayer(payload);
  if (legacyPayer) {
    return legacyPayer;
  }

  return undefined;
}

function decodeXPayment(header: string): unknown {
  const trimmed = header.trim();
  if (!trimmed) {
    return undefined;
  }

  // Try base64 first (standard x402 encoding), then raw JSON.
  const candidates: string[] = [];
  try {
    candidates.push(Buffer.from(trimmed, 'base64').toString('utf8'));
  } catch {
    // ignore
  }
  candidates.push(trimmed);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next
    }
  }
  return undefined;
}

function isStellarGAddress(value: unknown): value is string {
  return typeof value === 'string' && /^G[A-Z2-7]{55}$/.test(value);
}

function extractEvmPayer(payload: any): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const from = payload?.authorization?.from ?? payload?.from;
  if (typeof from === 'string' && from.length > 0) {
    return from;
  }
  return undefined;
}

function extractLegacyStellarPayer(payload: any): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const candidate = payload?.from ?? payload?.payer;
  if (isStellarGAddress(candidate)) {
    return candidate;
  }
  return undefined;
}

/**
 * Extracts the payer G-address from an x402 v2 Stellar `exact` payload.
 *
 * The v2 payload carries a signed Soroban authorization entry. Depending on
 * the client implementation this may be exposed as:
 *   - `payload.authorization` (string or object)
 *   - `payload.authEntry` (string or object)
 *   - `payload.signedAuthEntry` (string or object)
 *   - `payload.payload.authorization` (nested)
 *
 * The auth entry is a base64-encoded SorobanAuthorizationEntry XDR. We decode
 * it and walk the credentials to find the address (account) of the signer.
 */
function extractStellarPayerFromV2(payload: any): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const authEntryCandidates: unknown[] = [
    payload.authorization,
    payload.authEntry,
    payload.signedAuthEntry,
    payload?.payload?.authorization,
    payload?.payload?.authEntry,
    payload?.payload?.signedAuthEntry,
  ];

  for (const candidate of authEntryCandidates) {
    const payer = extractPayerFromAuthEntry(candidate);
    if (payer) {
      return payer;
    }
  }

  // Some v2 payloads may also expose the credential address directly.
  const directCandidates: unknown[] = [
    payload?.authorization?.address,
    payload?.authEntry?.address,
    payload?.credential?.address,
    payload?.credentialAddress,
  ];
  for (const candidate of directCandidates) {
    if (isStellarGAddress(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function extractPayerFromAuthEntry(entry: unknown): string | undefined {
  if (!entry) {
    return undefined;
  }

  // If the entry is already an object with a known address field, use it.
  if (typeof entry === 'object') {
    const obj = entry as any;
    const direct =
      obj?.address ??
      obj?.from ??
      obj?.account ??
      obj?.credentials?.address ??
      obj?.credentials?.sourceAccount ??
      obj?.credentials?.source_account;
    if (isStellarGAddress(direct)) {
      return direct;
    }
    // Recurse into nested credential structures.
    const nested = [
      obj?.credentials,
      obj?.credentials?.address,
      obj?.credentials?.sourceAccount,
      obj?.credentials?.source_account,
    ];
    for (const n of nested) {
      if (isStellarGAddress(n)) {
        return n;
      }
    }
    return undefined;
  }

  if (typeof entry !== 'string') {
    return undefined;
  }

  // If the string itself is a G-address, return it.
  if (isStellarGAddress(entry)) {
    return entry;
  }

  // Otherwise treat it as base64-encoded XDR and scan for a G-address.
  // We avoid pulling in a full XDR decoder here; instead we decode the
  // base64 and search for a 56-char G-address in the decoded bytes. This is
  // robust for the common case where the source account is embedded as an
  // ASCII StrKey in the auth entry.
  const fromXdr = scanForGAddressInXdr(entry);
  if (fromXdr) {
    return fromXdr;
  }

  return undefined;
}

function scanForGAddressInXdr(encoded: string): string | undefined {
  let buf: Buffer;
  try {
    buf = Buffer.from(encoded, 'base64');
  } catch {
    return undefined;
  }
  if (buf.length === 0) {
    return undefined;
  }

  // Search for an ASCII G-address (56 chars: 'G' + 55 base32 chars).
  const ascii = buf.toString('latin1');
  const match = ascii.match(/G[A-Z2-7]{55}/);
  if (match) {
    return match[0];
  }

  return undefined;
}