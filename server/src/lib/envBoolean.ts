import { z } from "zod/v4";

/**
 * Parse a "true"/"false" environment flag. Do not use `z.coerce.boolean()`
 * for env vars: `Boolean("false")` is `true`.
 */
export function envBoolean(defaultValue: boolean) {
  return z
    .enum(["true", "false"])
    .default(defaultValue ? "true" : "false")
    .transform((v) => v === "true");
}
