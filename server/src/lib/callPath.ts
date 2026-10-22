// Minimization of the request path stored on api_calls rows (#144).
//
// The proxy records which sub-path of an API each call hit, for provider
// stats and the recent-calls view. Callers often put personal data or
// credentials in paths (`/users/jane@example.com`, `/accounts/4111111111111111`,
// `/reset/<token>`), so only a coarse route shape is kept: segments that look
// like identifiers are replaced with a placeholder before the row is written.
// The query string is never stored. See docs/api-call-retention.md.

/** Longest path stored, in characters. */
export const MAX_STORED_PATH_LENGTH = 256;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Card, phone, account and similar numbers. Short numbers (`/v2`, `/items/42`,
// `/2026`) stay readable.
const LONG_NUMBER = /^\+?\d[\d-]{5,}$/;
// Hex digests, API keys, JWT-like and base64url tokens, Stellar addresses.
const OPAQUE_TOKEN = /^[A-Za-z0-9._~+=-]{20,}$/;
// Readable slugs such as `weather-forecast-2026` are route names, not tokens.
const SLUG = /^[a-z]+(?:-[a-z0-9]+)+$/;

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function minimizeSegment(raw: string): string {
  const segment = safeDecode(raw);
  if (EMAIL.test(segment)) return ":email";
  if (UUID.test(segment)) return ":uuid";
  if (LONG_NUMBER.test(segment)) return ":number";
  if (
    OPAQUE_TOKEN.test(segment) &&
    !SLUG.test(segment) &&
    /\d/.test(segment) &&
    /[A-Za-z]/.test(segment)
  ) {
    return ":token";
  }
  return raw;
}

/**
 * The form of `path` that is safe to keep: query string dropped, identifier-
 * like segments replaced with `:email`, `:uuid`, `:number` or `:token`, and
 * the result capped at MAX_STORED_PATH_LENGTH characters.
 */
export function minimizeCallPath(path: string): string {
  const queryStart = path.search(/[?#]/);
  const pathOnly = queryStart === -1 ? path : path.slice(0, queryStart);
  const minimized = pathOnly.split("/").map(minimizeSegment).join("/") || "/";
  return minimized.length > MAX_STORED_PATH_LENGTH
    ? minimized.slice(0, MAX_STORED_PATH_LENGTH - 1) + "…"
    : minimized;
}
