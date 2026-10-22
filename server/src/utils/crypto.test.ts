import { describe, it, expect } from "vitest";
import {
  API_KEY_PREFIX,
  generateApiKey,
  hashApiKey,
  hashFileResource,
  hashLinkResource,
} from "./crypto.js";

const BUF_HELLO = Buffer.from("hello world");
const BUF_HELLO2 = Buffer.from("hello world");

describe("hashFileResource (issue #12)", () => {
  it("returns a hex string of length 64", () => {
    const h = hashFileResource(BUF_HELLO, "My Title");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable — same input always yields same hash", () => {
    expect(hashFileResource(BUF_HELLO, "My Title")).toBe(hashFileResource(BUF_HELLO2, "My Title"));
  });

  it("changes when file bytes change", () => {
    expect(hashFileResource(Buffer.from("a"), "Same Title")).not.toBe(
      hashFileResource(Buffer.from("b"), "Same Title"),
    );
  });

  it("changes when title changes (same bytes)", () => {
    expect(hashFileResource(BUF_HELLO, "Title A")).not.toBe(hashFileResource(BUF_HELLO, "Title B"));
  });

  it("handles an empty buffer", () => {
    const h = hashFileResource(Buffer.alloc(0), "Empty File");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("hashLinkResource (issue #13)", () => {
  const url = "https://example.com/path";
  const title = "Example Page";

  it("returns a hex string of length 64", () => {
    expect(hashLinkResource(url, title)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable — same URL and title always yield same hash", () => {
    expect(hashLinkResource(url, title)).toBe(hashLinkResource(url, title));
  });

  it("normalizes trailing slash on pathname", () => {
    expect(hashLinkResource("https://example.com/path/", title)).toBe(
      hashLinkResource("https://example.com/path", title),
    );
  });

  it("normalizes hostname to lowercase", () => {
    expect(hashLinkResource("https://EXAMPLE.COM/path", title)).toBe(
      hashLinkResource("https://example.com/path", title),
    );
  });

  it("normalizes query parameter order", () => {
    expect(hashLinkResource("https://example.com/?b=2&a=1", title)).toBe(
      hashLinkResource("https://example.com/?a=1&b=2", title),
    );
  });

  it("changes when URL changes", () => {
    expect(hashLinkResource("https://a.com", title)).not.toBe(
      hashLinkResource("https://b.com", title),
    );
  });

  it("changes when title changes", () => {
    expect(hashLinkResource(url, "Title A")).not.toBe(hashLinkResource(url, "Title B"));
  });
});

describe("generateApiKey", () => {
  it("issues keys with the zp_ prefix", () => {
    expect(API_KEY_PREFIX).toBe("zp_");
    expect(generateApiKey()).toMatch(/^zp_[0-9a-f]{64}$/);
  });

  it("issues a different key each time", () => {
    expect(generateApiKey()).not.toBe(generateApiKey());
  });
});

describe("hashApiKey", () => {
  it("hashes legacy mv_ keys the same way, so they still authenticate", () => {
    const legacy = `mv_${"a".repeat(64)}`;
    expect(hashApiKey(legacy)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(legacy)).toBe(hashApiKey(legacy));
    expect(hashApiKey(legacy)).not.toBe(hashApiKey(`zp_${"a".repeat(64)}`));
  });
});
