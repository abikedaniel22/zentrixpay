import { describe, expect, it } from "vitest";
import { MAX_STORED_PATH_LENGTH, minimizeCallPath } from "./callPath.js";

describe("minimizeCallPath", () => {
  it("keeps route shapes, short ids, versions and slugs", () => {
    expect(minimizeCallPath("/")).toBe("/");
    expect(minimizeCallPath("")).toBe("/");
    expect(minimizeCallPath("/v2/forecast")).toBe("/v2/forecast");
    expect(minimizeCallPath("/items/42")).toBe("/items/42");
    expect(minimizeCallPath("/reports/2026")).toBe("/reports/2026");
    expect(minimizeCallPath("/feeds/weather-forecast-2026")).toBe("/feeds/weather-forecast-2026");
    expect(minimizeCallPath("/openapi.json")).toBe("/openapi.json");
  });

  it("drops the query string and fragment", () => {
    expect(minimizeCallPath("/search?q=jane%40example.com&key=secret")).toBe("/search");
    expect(minimizeCallPath("/docs#section")).toBe("/docs");
  });

  it("redacts email addresses, plain or percent-encoded", () => {
    expect(minimizeCallPath("/users/jane@example.com/orders")).toBe("/users/:email/orders");
    expect(minimizeCallPath("/users/jane%40example.com")).toBe("/users/:email");
  });

  it("redacts UUIDs", () => {
    expect(minimizeCallPath("/sessions/3f2b8c1e-9a4d-4e2b-8f6a-1c2d3e4f5a6b")).toBe(
      "/sessions/:uuid",
    );
  });

  it("redacts long numbers such as card, phone and account numbers", () => {
    expect(minimizeCallPath("/cards/4111111111111111")).toBe("/cards/:number");
    expect(minimizeCallPath("/sms/+15551234567")).toBe("/sms/:number");
    expect(minimizeCallPath("/accounts/12-3456-789")).toBe("/accounts/:number");
  });

  it("redacts opaque tokens, hashes and Stellar addresses", () => {
    expect(minimizeCallPath("/reset/aB3dE5fG7hJ9kL1mN3pQ5rS")).toBe("/reset/:token");
    expect(
      minimizeCallPath("/tx/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"),
    ).toBe("/tx/:token");
    expect(
      minimizeCallPath("/wallets/GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A"),
    ).toBe("/wallets/:token");
    expect(minimizeCallPath("/v1/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig123")).toBe(
      "/v1/:token",
    );
  });

  it("does not treat long words without digits as tokens", () => {
    expect(minimizeCallPath("/internationalization/configuration")).toBe(
      "/internationalization/configuration",
    );
  });

  it("caps the stored length", () => {
    const long = "/" + "segment/".repeat(100);
    const stored = minimizeCallPath(long);
    expect(stored.length).toBe(MAX_STORED_PATH_LENGTH);
    expect(stored.endsWith("…")).toBe(true);
  });

  it("tolerates malformed percent-encoding", () => {
    expect(minimizeCallPath("/files/%E0%A4%A")).toBe("/files/%E0%A4%A");
  });
});
