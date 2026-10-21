/**
 * Integration tests for the ZentrixPay MCP server surface.
 *
 * These go through the SDK Client request interface (listTools / callTool) via
 * the in-memory harness — not the exported helper functions exercised by
 * index.test.ts. Mock mode supplies deterministic fetch + registry fixtures.
 *
 * See docs/mcp-integration-harness.md for the error-handling contract.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  harnessIsToolError,
  harnessResultText,
  harnessStructuredContent,
  startIntegrationHarness,
  type IntegrationHarness,
} from "./integrationHarness.js";

// Activate mock fixtures and isolate state before the server module loads.
process.env.ZENTRIXPAY_MOCK = "1";
process.env.STELLAR_NETWORK = "testnet";
const harnessHome = mkdtempSync(join(tmpdir(), "zentrixpay-mcp-integration-"));
process.env.HOME = harnessHome;
process.env.USERPROFILE = harnessHome;

const { server, _resetProfiles } = await import("./index.js");

describe("MCP integration harness", () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    harness = await startIntegrationHarness(server);
  });

  afterAll(async () => {
    await harness?.close();
    rmSync(harnessHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    _resetProfiles();
  });

  it("advertises MCP annotations for every tool (#552)", async () => {
    const { tools } = await harness.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      const annotations = (tool as { annotations?: Record<string, unknown> }).annotations;
      expect(annotations, `tool ${tool.name} advertises annotations`).toBeDefined();
      expect(typeof annotations?.title, `tool ${tool.name} has an annotations title`).toBe(
        "string",
      );
      expect(typeof annotations?.readOnlyHint).toBe("boolean");
      expect(typeof annotations?.destructiveHint).toBe("boolean");
      expect(typeof annotations?.idempotentHint).toBe("boolean");
    }
    const readOnly = (tools as Array<{ annotations: { readOnlyHint: boolean } }>).filter(
      (t) => t.annotations.readOnlyHint === true,
    );
    expect(readOnly.length).toBeGreaterThan(0);
    for (const tool of readOnly) {
      expect(tool.annotations.destructiveHint).toBe(false);
    }
  });

  it("advertises the resources capability and lists catalog entries with stable URIs (#545)", async () => {
    const capabilities = harness.client.getServerCapabilities();
    expect(capabilities?.resources).toBeDefined();

    const { resources } = await harness.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("zentrixpay://resource/mock-1");
    expect(uris).toContain("zentrixpay://resource/mock-2");

    const mock1 = resources.find((r) => r.uri === "zentrixpay://resource/mock-1");
    expect(mock1?.name).toContain("Stellar");
    expect(mock1?.mimeType).toBe("application/json");
  });

  it("reads public metadata for a known resource URI (#545)", async () => {
    const { contents } = await harness.readResource("zentrixpay://resource/mock-1");
    expect(contents).toHaveLength(1);
    const parsed = JSON.parse(contents[0].text ?? "");
    expect(parsed.id).toBe("mock-1");
    expect(parsed.title).toContain("Stellar");
    expect(parsed.price).toMatch(/USDC/);
    // Only public metadata — on-chain sync fields from the meta endpoint are
    // never exposed through resources/read.
    expect(contents[0].text).not.toContain("onchainStatus");
    expect(contents[0].text).not.toContain("contentHash");
  });

  it("returns deterministic errors for unknown resource URIs (#545)", async () => {
    // Wrong scheme/host is rejected before any network call.
    await expect(harness.readResource("https://example.com/not-a-resource")).rejects.toThrow(
      /resource URI/i,
    );
    // A well-formed URI for an id the catalog does not know is a not-found error.
    await expect(harness.readResource("zentrixpay://resource/does-not-exist")).rejects.toThrow(
      /not found/i,
    );
  });

  it("exports receipts as a structured document with an advertised schema", async () => {
    const { tools } = await harness.listTools();
    const exportTool = tools.find((t) => t.name === "zentrixpay_export_receipts");
    expect(exportTool).toBeDefined();
    expect((exportTool as { outputSchema?: unknown }).outputSchema).toBeDefined();

    const result = await harness.callTool("zentrixpay_export_receipts", { format: "csv" });
    expect(harnessIsToolError(result)).toBe(false);
    const parsed = JSON.parse(harnessResultText(result));
    expect(parsed.schema).toBe("zentrixpay.receipt-export/v1");
    expect(parsed.currency).toBe("USDC");
    expect(typeof parsed.csv).toBe("string");
    expect(parsed.csv.split("\r\n")[0]).toContain("resourceId,title,amount");
    expect(harnessStructuredContent(result)).toEqual(parsed);
  });

  it("exports a sanitized debug bundle with an advertised schema (#675)", async () => {
    const { tools } = await harness.listTools();
    const bundleTool = tools.find((t) => t.name === "zentrixpay_debug_bundle");
    expect(bundleTool).toBeDefined();
    expect((bundleTool as { outputSchema?: unknown }).outputSchema).toBeDefined();

    const result = await harness.callTool("zentrixpay_debug_bundle", { auditLogLines: 5 });
    expect(harnessIsToolError(result)).toBe(false);
    const text = harnessResultText(result);
    const parsed = JSON.parse(text);
    expect(parsed.schema).toBe("zentrixpay.debug-bundle/v1");
    expect(parsed.runtime.mockMode).toBe(true);
    expect(parsed.config.stellarNetwork).toBe("testnet");
    expect(parsed.auditLog.requested).toBe(5);
    expect(Array.isArray(parsed.sanitized.rules)).toBe(true);
    // Nothing shaped like a Stellar secret key, whatever the server had loaded.
    expect(text).not.toMatch(/S[A-Z2-7]{55}/);
    expect(harnessStructuredContent(result)).toEqual(parsed);
  });

  it("leaves text-only tools without structuredContent or outputSchema (#553)", async () => {
    const { tools } = await harness.listTools();
    const verify = tools.find((t) => t.name === "zentrixpay_verify_install");
    expect(verify).toBeDefined();
    expect((verify as { outputSchema?: unknown }).outputSchema).toBeUndefined();

    const result = await harness.callTool("zentrixpay_verify_install");
    expect(harnessIsToolError(result)).toBe(false);
    expect(harnessStructuredContent(result)).toBeUndefined();
    expect(harnessResultText(result).length).toBeGreaterThan(0);
  });

  it("returns deterministic Error: results for unknown tools and missing wallet", async () => {
    const unknown = await harness.callTool("zentrixpay_not_a_real_tool");
    expect(unknown.isError).toBe(true);
    // The message continues with the list of available tools, so anchor on the
    // name rather than the end of the line.
    expect(harnessResultText(unknown)).toMatch(/^Error: Unknown tool: zentrixpay_not_a_real_tool\b/);

    const walletInfo = await harness.callTool("zentrixpay_wallet_info");
    expect(walletInfo.isError).toBe(true);
    const walletText = harnessResultText(walletInfo);
    expect(walletText).toMatch(/^Error:/);
    expect(walletText).toContain("zentrixpay_setup_wallet");
    expect(walletText).not.toMatch(/S[A-Z0-9]{50,}/); // no secret keys
    expect(unknown).not.toHaveProperty("structuredContent");
    expect(walletInfo).not.toHaveProperty("structuredContent");
  });

  it("sets up a wallet through callTool using the mock sponsored-account route", async () => {
    const setup = await harness.callTool("zentrixpay_setup_wallet");
    expect(harnessIsToolError(setup)).toBe(false);
    const text = harnessResultText(setup);
    expect(text).toContain("Address:");
    expect(text).toMatch(/G[A-Z0-9]{55}/);
  });
});
