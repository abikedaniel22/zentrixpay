/** Content types the Try-it console can send a request body as (#145). */
export const REQUEST_CONTENT_TYPES = [
  { value: "application/json", label: "JSON" },
  { value: "text/plain", label: "Plain text" },
  { value: "application/x-www-form-urlencoded", label: "Form (URL-encoded)" },
  { value: "application/xml", label: "XML" },
] as const;

export type RequestContentType = (typeof REQUEST_CONTENT_TYPES)[number]["value"];

export const DEFAULT_REQUEST_CONTENT_TYPE: RequestContentType = "application/json";

/** GET requests never carry a body: parameters belong in the path and query. */
export function methodAllowsBody(method: string): boolean {
  const upper = method.toUpperCase();
  return upper !== "GET" && upper !== "HEAD";
}

/** Case-insensitive lookup of a header name. */
export function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === lower) return value;
  return undefined;
}

function isJsonType(contentType: string): boolean {
  const base = contentType.split(";")[0].trim().toLowerCase();
  return base === "application/json" || base.endsWith("+json");
}

export type PreparedRequest =
  | { ok: true; body: string | undefined; headers: Record<string, string> }
  | { ok: false; error: string };

/**
 * Decide what body and headers a Try-it request is sent with.
 *
 * - GET: no body and no Content-Type are added, whatever was typed.
 * - Empty body: nothing is sent and no Content-Type is added.
 * - Otherwise the body text is sent exactly as typed (never re-encoded) with
 *   the chosen Content-Type. A Content-Type set in the headers editor wins over
 *   the selector, so other media types can still be tested.
 * - JSON bodies must parse, so a typo fails here rather than as a paid call.
 */
export function prepareRequestBody(
  method: string,
  contentType: string,
  body: string,
  headers: Record<string, string>,
): PreparedRequest {
  if (!methodAllowsBody(method) || body === "") {
    return { ok: true, body: undefined, headers };
  }
  const explicit = findHeader(headers, "content-type");
  const effective = explicit ?? contentType;
  if (isJsonType(effective)) {
    try {
      JSON.parse(body);
    } catch {
      return { ok: false, error: "The request body is not valid JSON." };
    }
  }
  return {
    ok: true,
    body,
    headers: explicit === undefined ? { ...headers, "content-type": contentType } : headers,
  };
}
