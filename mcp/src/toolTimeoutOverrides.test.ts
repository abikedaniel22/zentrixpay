/**
 * Tests for per-tool timeout overrides (#590).
 *
 * The behaviour that matters: an override applies only to the tool it names,
 * every other tool keeps its service budget, and a malformed entry is reported
 * and skipped rather than crashing the server or silently applying to nothing.
 */
import { describe, it, expect } from "vitest";

import { DEFAULT_TIMEOUTS } from "./httpTimeout.js";
import {
  TOOL_TIMEOUTS_ENV_VAR,
  describeToolTimeouts,
  hasOverride,
  normalizeToolName,
  parseToolTimeouts,
  resolveToolTimeouts,
  timeoutForTool,
  unknownToolNames,
} from "./toolTimeoutOverrides.js";

describe("parseToolTimeouts", () => {
  it("returns nothing when unset", () => {
    expect(parseToolTimeouts(undefined)).toEqual({ overrides: {}, problems: [] });
    expect(parseToolTimeouts("   ")).toEqual({ overrides: {}, problems: [] });
  });

  it("reports an entry with no equals sign", () => {
    const { overrides, problems } = parseToolTimeouts("publish");

    expect(overrides).toEqual({});
    expect(problems).toEqual(['"publish" is not a tool=milliseconds pair']);
  });

  it("reports an entry with no tool name", () => {
    const { problems } = parseToolTimeouts("=5000");

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("has no tool name");
  });

  it("reports a non-numeric timeout", () => {
    const { overrides, problems } = parseToolTimeouts("publish=soon");

    expect(overrides).toEqual({});
    expect(problems[0]).toContain("non-numeric or negative");
  });

  it("reports a negative timeout", () => {
    const { problems } = parseToolTimeouts("publish=-1");

    expect(problems).toHaveLength(1);
  });

  it("never throws on hostile input", () => {
    for (const input of ["=", "==", "a=b=c", ",,,", "publish=", "=1"]) {
      expect(() => parseToolTimeouts(input), input).not.toThrow();
    }
  });
});

describe("resolveToolTimeouts", () => {

  it("is empty when the variable is absent", () => {
    expect(resolveToolTimeouts({}).overrides).toEqual({});
  });
});

describe("timeoutForTool", () => {
  const budgets = DEFAULT_TIMEOUTS;

  it("overrides regardless of which service the call belongs to", () => {
    const overrides = { zentrixpay_tx_status: 90000 };

    expect(timeoutForTool("zentrixpay_tx_status", "soroban", budgets, overrides)).toBe(90000);
  });

});

describe("unknownToolNames", () => {
  const known = ["zentrixpay_browse", "zentrixpay_publish"];

  it("reports a misspelled tool", () => {
    // "zentrixpay_publsh=120000" parses perfectly and applies to nothing —
    // exactly the failure a tuning variable must not have.
    expect(unknownToolNames({ zentrixpay_publsh: 1 }, known)).toEqual(["zentrixpay_publsh"]);
  });

  it("returns them sorted, for a stable message", () => {
    expect(unknownToolNames({ zzz: 1, aaa: 2 }, known)).toEqual(["aaa", "zzz"]);
  });
});

describe("describeToolTimeouts", () => {
  it("says so when nothing is overridden", () => {
    expect(describeToolTimeouts({})).toContain("service budget");
  });

});
