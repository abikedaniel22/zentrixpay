import { describe, it, expect } from "vitest";
import { envBoolean } from "./envBoolean.js";

describe("envBoolean (REQUIRE_REQUEST_SIGNATURE)", () => {
  const schema = envBoolean(false);

  it("is false when unset", () => {
    expect(schema.parse(undefined)).toBe(false);
  });

  it('is false for "false"', () => {
    expect(schema.parse("false")).toBe(false);
  });

  it('is true for "true"', () => {
    expect(schema.parse("true")).toBe(true);
  });

  it("rejects other values", () => {
    expect(schema.safeParse("yes").success).toBe(false);
    expect(schema.safeParse("1").success).toBe(false);
  });

  it("honours a true default", () => {
    expect(envBoolean(true).parse(undefined)).toBe(true);
  });
});
