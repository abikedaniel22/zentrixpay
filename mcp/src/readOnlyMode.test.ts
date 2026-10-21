/**
 * Tests for read-only mode (#593).
 *
 * Two layers, because read-only mode is only useful if both hold:
 *
 *   - the pure decisions in `readOnlyMode.ts` (parsing, classification, the
 *     refusal text), which need no server; and
 *   - the wiring, checked through the SDK client over a real transport, since
 *     a correct decision that the dispatcher never consults protects nothing.
 *
 * The second layer is the one that matters. Narrowing ListTools is a
 * convenience — it keeps an agent from planning around a tool it cannot use —
 * but a client with a cached tool list, or one that simply guesses a name, will
 * still call it. The gate that enforces the mode is the one in dispatch, so
 * these tests call withheld tools directly rather than trusting the listing.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  READ_ONLY_ENV_VAR,
  assertToolAllowedInReadOnlyMode,
  filterToolsForReadOnlyMode,
  formatReadOnlyDiagnostics,
  isReadOnlyTool,
  readOnlyModeEnabled,
  readOnlyRefusalError,
  readOnlyToolNames,
} from "./readOnlyMode.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import {
  harnessIsToolError,
  harnessResultText,
  startIntegrationHarness,
} from "./integrationHarness.js";
import type { IntegrationHarness } from "./integrationHarness.js";

process.env.ZENTRIXPAY_MOCK = "1";
process.env.STELLAR_NETWORK = "testnet";
const home = mkdtempSync(join(tmpdir(), "zentrixpay-mcp-readonly-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { server, dispatchTool } = await import("./index.js");

// ── Pure decisions ───────────────────────────────────────────────────────────

describe("readOnlyModeEnabled", () => {
  it("is off when the variable is unset", () => {
    expect(readOnlyModeEnabled({})).toBe(false);
  });

  it.each(["1", "true", "TRUE", "yes", "on", " 1 "])("is on for %j", (value) => {
    expect(readOnlyModeEnabled({ [READ_ONLY_ENV_VAR]: value })).toBe(true);
  });

  it.each(["0", "false", "no", "off", ""])("is off for %j", (value) => {
    expect(readOnlyModeEnabled({ [READ_ONLY_ENV_VAR]: value })).toBe(false);
  });

  it("treats an unrecognized value as off rather than guessing", () => {
    // Failing open is the right default *here*: an operator who never meant to
    // enable read-only mode gets exactly the behaviour they had before the
    // variable existed, instead of a server that silently refuses to work.
    expect(readOnlyModeEnabled({ [READ_ONLY_ENV_VAR]: "maybe" })).toBe(false);
  });
});

describe("isReadOnlyTool", () => {
  it("follows the readOnlyHint each tool declares", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(isReadOnlyTool(tool.name), tool.name).toBe(tool.annotations.readOnlyHint);
    }
  });

  it("fails closed on an unknown name", () => {
    // A safety boundary must not admit a name it has never heard of.
    expect(isReadOnlyTool("zentrixpay_not_a_tool")).toBe(false);
  });
});

describe("filterToolsForReadOnlyMode", () => {
  const tools = [{ name: "zentrixpay_browse" }, { name: "zentrixpay_buy" }];

  it("passes everything through when the mode is off", () => {
    expect(filterToolsForReadOnlyMode(tools, {})).toEqual(tools);
  });

  it("returns a copy rather than the caller's array", () => {
    const result = filterToolsForReadOnlyMode(tools, {});
    expect(result).not.toBe(tools);
  });
});

describe("readOnlyRefusalError", () => {
  const message = readOnlyRefusalError("zentrixpay_buy").message;

  it("says the restriction cannot be lifted from a tool call", () => {
    // The distinction from the mainnet guardrail, which *is* per-call
    // overridable. An agent that retries with a confirmation flag here would
    // just fail twice.
    expect(message).toMatch(/no tool argument can override it/i);
  });

});

describe("formatReadOnlyDiagnostics", () => {
  it("reports the mode as off and how to turn it on", () => {
    expect(formatReadOnlyDiagnostics({})).toMatch(/off/);
    expect(formatReadOnlyDiagnostics({})).toContain(READ_ONLY_ENV_VAR);
  });

  it("reports the mode as on with the number of tools left", () => {
    const line = formatReadOnlyDiagnostics({ [READ_ONLY_ENV_VAR]: "1" });
    expect(line).toMatch(/ON/);
    expect(line).toContain(String(readOnlyToolNames().length));
  });
});

// ── Wiring ───────────────────────────────────────────────────────────────────

describe("read-only mode through the MCP server", () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    harness = await startIntegrationHarness(server);
  });

  afterAll(async () => {
    // Also clear it here, not only in afterEach: vitest may place another file
    // in this worker, and a suite that died mid-run would otherwise leak the
    // variable into it.
    delete process.env[READ_ONLY_ENV_VAR];
    await harness?.close();
    rmSync(home, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env[READ_ONLY_ENV_VAR];
  });

  it("re-reads the environment on every ListTools call", async () => {
    // The handler is not allowed to snapshot the mode at module load: the
    // listing has to reflect what dispatch will actually enforce.
    const before = (await harness.listTools()).tools.length;
    process.env[READ_ONLY_ENV_VAR] = "1";
    const during = (await harness.listTools()).tools.length;
    delete process.env[READ_ONLY_ENV_VAR];
    const after = (await harness.listTools()).tools.length;

    expect(during).toBeLessThan(before);
    expect(after).toBe(before);
  });

  it("refuses every non-read-only tool, not just the spending ones", async () => {
    process.env[READ_ONLY_ENV_VAR] = "1";
    for (const name of ["zentrixpay_reset", "zentrixpay_setup_wallet", "zentrixpay_restore_state"]) {
      await expect(dispatchTool(name, {}), name).rejects.toThrow(/Read-only mode/);
    }
  });

  it("restores the full surface once the mode is turned off", async () => {
    process.env[READ_ONLY_ENV_VAR] = "1";
    await expect(dispatchTool("zentrixpay_reset", {})).rejects.toThrow(/Read-only mode/);

    delete process.env[READ_ONLY_ENV_VAR];
    await expect(dispatchTool("zentrixpay_reset", {})).resolves.toBeTypeOf("string");
  });
});
