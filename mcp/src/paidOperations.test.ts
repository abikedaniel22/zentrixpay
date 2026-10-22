/**
 * Tests for the paid-operation confirmation policy (#594).
 *
 * The policy answers a question neither existing guardrail asks. The mainnet
 * guardrail asks *where* the spend happens and lets everything through on
 * testnet; the auto-pay ceiling asks *how much* and lets a hundred cheap
 * purchases through. This one asks whether the caller meant to spend at all,
 * on any network, at any price.
 *
 * Three things have to hold, and the third is the one most easily lost:
 *
 *   1. The policy classifies and decides correctly (pure functions).
 *   2. The dispatcher consults it (wiring).
 *   3. It *composes* with the other two guardrails rather than replacing them —
 *      satisfying this one must not quietly unlock a mainnet spend, and the
 *      default must leave every existing deployment behaving exactly as before.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_PAID_CONFIRMATION_POLICY,
  FEE_SPENDING_TOOLS,
  PAID_CONFIRMATION_ARG,
  PAID_CONFIRMATION_ENV_VAR,
  USDC_SPENDING_TOOLS,
  assertPaidOperationConfirmed,
  formatPaidConfirmationDiagnostics,
  paidConfirmationRequiredError,
  paidOperationClass,
  paidOperationToolNames,
  requiresPaidConfirmation,
  resolvePaidConfirmationPolicy,
} from "./paidOperations.js";
import {
  harnessIsToolError,
  harnessResultText,
  startIntegrationHarness,
} from "./integrationHarness.js";
import type { IntegrationHarness } from "./integrationHarness.js";

process.env.ZENTRIXPAY_MOCK = "1";
process.env.STELLAR_NETWORK = "testnet";
const home = mkdtempSync(join(tmpdir(), "zentrixpay-mcp-paid-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { server, dispatchTool } = await import("./index.js");

const envWith = (policy: string) => ({ [PAID_CONFIRMATION_ENV_VAR]: policy });

/**
 * The message a dispatch failed with, or `null` when it succeeded.
 *
 * Used where the assertion is about *which* error came back rather than
 * whether one did: several gated tools fail downstream in mock mode (no
 * wallet, no live RPC), and a test that asserted "rejects" would break if one
 * of them ever started succeeding — for a reason unrelated to what it checks.
 */
async function dispatchFailure(
  name: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  try {
    await dispatchTool(name, args);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

// ── Policy resolution ────────────────────────────────────────────────────────

describe("resolvePaidConfirmationPolicy", () => {
  it("defaults to off so an upgrade changes no existing deployment", () => {
    expect(resolvePaidConfirmationPolicy({})).toBe(DEFAULT_PAID_CONFIRMATION_POLICY);
    expect(DEFAULT_PAID_CONFIRMATION_POLICY).toBe("off");
  });

  it.each(["off", "usdc", "all"])("accepts %j", (policy) => {
    expect(resolvePaidConfirmationPolicy(envWith(policy))).toBe(policy);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(resolvePaidConfirmationPolicy(envWith("  USDC  "))).toBe("usdc");
  });

  it("reads an empty value as unset", () => {
    // What a shell leaves behind for `export ZENTRIXPAY_CONFIRM_PAID_OPERATIONS=`.
    expect(resolvePaidConfirmationPolicy(envWith(""))).toBe("off");
    expect(resolvePaidConfirmationPolicy(envWith("   "))).toBe("off");
  });

  it("throws on an unrecognized value instead of falling back to off", () => {
    // The important one. A typo in a safety setting that silently disables it
    // is worse than one that stops the server: the operator believes they are
    // protected. `true` is the likeliest typo, so it is named explicitly.
    expect(() => resolvePaidConfirmationPolicy(envWith("true"))).toThrow(
      /must be one of: off, usdc, all/,
    );
    expect(() => resolvePaidConfirmationPolicy(envWith("1"))).toThrow(/must be one of/);
    expect(() => resolvePaidConfirmationPolicy(envWith("yes"))).toThrow(/must be one of/);
  });

  it("quotes the offending value in the error", () => {
    expect(() => resolvePaidConfirmationPolicy(envWith("usdcc"))).toThrow(/"usdcc"/);
  });
});

// ── Classification ───────────────────────────────────────────────────────────

describe("paidOperationClass", () => {

  it("classifies the network-fee spenders", () => {
    for (const name of FEE_SPENDING_TOOLS) {
      expect(paidOperationClass(name), name).toBe("fee");
    }
  });

  it("does not gate wallet setup, which the sponsor pays for", () => {
    // Account creation goes through the sponsored-account service; the agent's
    // own wallet funds nothing, so requiring a spend confirmation would be a
    // lie about what the call costs.
    expect(paidOperationClass("zentrixpay_setup_wallet")).toBeNull();
  });

  it("treats an unknown name as costing nothing", () => {
    // Failing open is right here: this classifier must not become a second,
    // accidental allowlist for tool names. The dispatcher rejects unknown tools.
    expect(paidOperationClass("zentrixpay_not_a_tool")).toBeNull();
  });

  it("lists every gated tool once, sorted", () => {
    const names = paidOperationToolNames();
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort());
    expect(names).toHaveLength(USDC_SPENDING_TOOLS.length + FEE_SPENDING_TOOLS.length);
  });
});

// ── The decision ─────────────────────────────────────────────────────────────

describe("requiresPaidConfirmation", () => {
  it("requires nothing under off", () => {
    for (const name of paidOperationToolNames()) {
      expect(requiresPaidConfirmation(name, "off"), name).toBe(false);
    }
  });

  it("requires confirmation for USDC spends under usdc", () => {
    for (const name of USDC_SPENDING_TOOLS) {
      expect(requiresPaidConfirmation(name, "usdc"), name).toBe(true);
    }
  });

  it("leaves fee-only spends alone under usdc", () => {
    // The whole reason `all` is a separate step: an operator may care about
    // USDC leaving the wallet without wanting every on-chain edit gated.
    for (const name of FEE_SPENDING_TOOLS) {
      expect(requiresPaidConfirmation(name, "usdc"), name).toBe(false);
    }
  });

  it("requires confirmation for every spend under all", () => {
    for (const name of paidOperationToolNames()) {
      expect(requiresPaidConfirmation(name, "all"), name).toBe(true);
    }
  });

});

describe("assertPaidOperationConfirmed", () => {
  it("allows everything under the default policy", () => {
    for (const name of paidOperationToolNames()) {
      expect(() =>
        assertPaidOperationConfirmed({ toolName: name, args: {}, env: {} }),
      ).not.toThrow();
    }
  });

  it("reports a misconfiguration instead of throwing", () => {
    // Diagnostics run in status output; they have to describe a broken setting
    // rather than take the status tool down with them.
    expect(formatPaidConfirmationDiagnostics(envWith("nope"))).toMatch(/misconfigured/);
  });
});

// ── Wiring ───────────────────────────────────────────────────────────────────

describe("the paid-operation policy through the MCP server", () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    harness = await startIntegrationHarness(server);
  });

  afterAll(async () => {
    // Also clear it here, not only in afterEach: vitest may place another file
    // in this worker, and a suite that died mid-run would otherwise leak the
    // variable into it.
    delete process.env[PAID_CONFIRMATION_ENV_VAR];
    await harness?.close();
    rmSync(home, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env[PAID_CONFIRMATION_ENV_VAR];
  });

  it("accepts confirmPaid as a validated argument on every gated tool", async () => {
    // A guardrail whose own argument the validator rejects is unusable — the
    // shape of the zentrixpay_reset.confirm bug in #596.
    process.env[PAID_CONFIRMATION_ENV_VAR] = "all";
    for (const name of paidOperationToolNames()) {
      const failure = await dispatchFailure(name, { confirmPaid: true });
      expect(failure, `${name} rejected its own confirmation argument`).not.toMatch(
        /not a recognized argument/,
      );
      expect(failure, `${name} was still gated after confirming`).not.toMatch(
        /Paid-operation guardrail/,
      );
    }
  });

});
