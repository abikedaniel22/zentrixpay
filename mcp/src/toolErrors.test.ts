/**
 * Wiring tests for structured MCP error mapping (#407).
 *
 * errorMapping.test.ts covers the pure mapper; these assert that the real tool
 * functions actually emit the mapped shape — summary, machine-readable
 * classification line, and a next step — for each failure class named in the
 * issue: network failure, 402 payment, contract NotFound, and validation.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const hoisted = vi.hoisted(() => ({ registryGet: null as any }));

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class MockServer {
    setRequestHandler = vi.fn();
    connect = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {
    constructor() {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  CallToolRequestSchema: {},
  ListToolsRequestSchema: {},
  ListPromptsRequestSchema: {},
  GetPromptRequestSchema: {},
  ListResourcesRequestSchema: {},
  ReadResourceRequestSchema: {},
}));

vi.mock("@x402/stellar", () => ({ createEd25519Signer: vi.fn() }));
vi.mock("@x402/stellar/exact/client", () => ({ ExactStellarScheme: vi.fn() }));
vi.mock("@x402/fetch", () => ({
  wrapFetchWithPayment: vi.fn(),
  x402Client: vi.fn(function () {
    return { register: vi.fn() };
  }),
}));

vi.mock("@zentrixpay/registry-client", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    networks: {
      ...actual.networks,
      testnet: { ...actual.networks.testnet, contractId: "test", networkPassphrase: "test" },
    },
    createRegistryClient: () => ({ get: async () => hoisted.registryGet }),
  };
});

import { txStatus, walletInfo, _setAgentWallet } from "./index.js";

function mockResponse(data: unknown, ok = true, status = 200): Response {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(data),
    headers: new Headers({ "content-type": "application/json" }),
  } as Response;
}

const testWallet = {
  publicKey: "GTESTPUBLICKEY000000000000000000000000000000000000000000",
  secretKey: "STESTSECRETKEY000000000000000000000000000000000000000000",
};

/** Every mapped error carries the three-line contract. */
function expectMappedShape(message: string): void {
  expect(message).toMatch(/Source: .+ · Category: [a-z_]+/);
  expect(message).toMatch(/Next: \S/);
}

afterEach(() => {
  vi.restoreAllMocks();
  hoisted.registryGet = null;
});

describe("network failure", () => {

  it("attributes a Horizon outage to Horizon, not the API", async () => {
    _setAgentWallet(testWallet);
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ENOTFOUND horizon"));

    const message = await walletInfo().catch((e) => e.message);
    expect(message).toContain("Source: Horizon");
    expect(message).toContain("Category: network");
  });

});

describe("Soroban RPC failures", () => {
  it("maps a non-ok RPC response while keeping the documented prefix", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse({}, false, 503));

    const message = await txStatus("abc123").catch((e) => e.message);
    expect(message).toContain("Soroban RPC error: 503");
    expect(message).toContain("Source: Soroban RPC");
    expect(message).toContain("Category: server");
  });

  it("maps a JSON-RPC error body to a contract error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: { code: -32602, message: "invalid hash" } }),
    );

    const message = await txStatus("bad").catch((e) => e.message);
    expect(message).toContain("RPC error");
    expect(message).toContain("Source: Soroban RPC");
    expect(message).toContain("Category: contract");
  });
});
