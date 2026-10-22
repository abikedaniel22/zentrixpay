/**
 * Wiring tests for request timeouts on real MCP tools (#408).
 *
 * httpTimeout.test.ts covers the primitive; this asserts that tool calls really
 * do run under a deadline — a slow backend fails fast with a timeout-classified
 * error instead of hanging the agent forever. The budget is set to 50ms via the
 * documented env var before the server module loads, so the suite stays quick
 * without fake timers.
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

// Budgets are read once at module load, so they must be set before the import.
process.env.ZENTRIXPAY_HTTP_TIMEOUT_MS = "50";
process.env.ZENTRIXPAY_HORIZON_TIMEOUT_MS = "50";
process.env.ZENTRIXPAY_SOROBAN_TIMEOUT_MS = "50";

const { txStatus, networkProfile, walletInfo, _setAgentWallet } =
  await import("./index.js");

/** A fetch that never responds until the request is aborted. */
function hangingFetch() {
  return vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("outbound API calls carry a deadline", () => {

  it("applies the Horizon budget to balance lookups", async () => {
    _setAgentWallet({
      publicKey: "GTESTPUBLICKEY000000000000000000000000000000000000000000",
      secretKey: "STESTSECRETKEY000000000000000000000000000000000000000000",
    });
    globalThis.fetch = hangingFetch() as unknown as typeof fetch;

    const message = await walletInfo().catch((e) => e.message);
    expect(message).toContain("Source: Horizon");
    expect(message).toContain("Category: timeout");
  });

  it("applies the Soroban budget to tx status lookups", async () => {
    globalThis.fetch = hangingFetch() as unknown as typeof fetch;

    await expect(txStatus("abc123")).rejects.toThrow(/timed out after 50ms \(soroban\)/);
  });

});

describe("network profile reports the active budgets", () => {
  it("surfaces the configured deadlines for operators", () => {
    const parsed = JSON.parse(networkProfile());
    expect(parsed.timeouts).toContain("http=50ms");
    expect(parsed.timeouts).toContain("horizon=50ms");
    expect(parsed.timeouts).toContain("soroban=50ms");
    expect(parsed.timeouts).toContain("payment=45000ms");
  });
});
