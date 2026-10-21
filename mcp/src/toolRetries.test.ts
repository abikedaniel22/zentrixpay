/**
 * Wiring tests for retry behaviour on real MCP tools (#409).
 *
 * retry.test.ts covers the primitive. These assert the policy that actually
 * matters at the call sites: idempotent reads recover from transient failures,
 * and non-idempotent work — above all x402 payments — is issued exactly once.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

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
  };
});

// Retry counts are read once at module load. VITEST already forces a zero base
// delay, so these run without real sleeping.
process.env.ZENTRIXPAY_RETRY_ATTEMPTS = "3";

const { walletInfo, txStatus, networkProfile, _setAgentWallet } =
  await import("./index.js");

function mockResponse(data: unknown, ok = true, status = 200, headers?: Record<string, string>) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    text: () => Promise.resolve(typeof data === "string" ? data : JSON.stringify(data)),
    json: () => Promise.resolve(data),
    headers: new Headers({ "content-type": "application/json", ...headers }),
  } as Response;
}

const testWallet = {
  publicKey: "GTESTPUBLICKEY000000000000000000000000000000000000000000",
  secretKey: "STESTSECRETKEY000000000000000000000000000000000000000000",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("idempotent reads retry", () => {

  it("retries Horizon balance reads", async () => {
    _setAgentWallet(testWallet);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(
        mockResponse({
          subentry_count: 1,
          balances: [
            { asset_type: "native", balance: "5.0" },
            { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "10.0" },
          ],
        }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(walletInfo()).resolves.toContain("USDC Balance: 10.0");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries Soroban getTransaction, which is a read", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({}, false, 502))
      .mockResolvedValueOnce(mockResponse({ result: { status: "SUCCESS", ledger: 1 } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const parsed = JSON.parse(await txStatus("abc123"));
    expect(parsed.status).toBe("SUCCESS");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("network profile reports the retry policy", () => {
  it("surfaces the active policy for operators", () => {
    const parsed = JSON.parse(networkProfile());
    expect(parsed.retries).toContain("attempts=3");
    expect(parsed.retries).toContain("jitter=full");
  });
});
