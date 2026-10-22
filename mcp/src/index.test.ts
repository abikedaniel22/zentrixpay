import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getAttestationHashMock = vi.hoisted(() => vi.fn());

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
    getAttestationHash: getAttestationHashMock,
    networks: {
      ...actual.networks,
      testnet: {
        ...actual.networks.testnet,
        contractId: "test",
        networkPassphrase: "test",
      },
    },
  };
});

import {
  dispatchTool,
  txStatus,
  walletInfo,
  useProfile,
  switchNetworkProfile,
  listProfiles,
  networkProfile,
  _setAgentWallet,
  _setAgentApiKey,
  _resetProfiles,
} from "./index.js";
import { recordCatalogSnapshot, _clearCatalogCache } from "./catalogCache.js";
import { Keypair } from "@stellar/stellar-sdk";

function mockResponse(data: unknown, ok = true, status = 200): Response {
  const body = JSON.stringify(data);
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(data),
    headers: new Headers({ "content-type": "application/json" }),
  } as Response;
}

const sampleResources = [
  {
    id: "res-001",
    title: "Introduction to Stellar",
    description: "A beginner's guide to Stellar blockchain",
    price: "5.00",
    accessUrl: "https://example.com/stellar-intro",
    resourceType: "link",
    verificationStatus: "verified",
  },
  {
    id: "res-002",
    title: "Advanced Soroban",
    description: "Deep dive into Soroban smart contracts",
    price: "15.00",
    accessUrl: "https://example.com/soroban-advanced",
    resourceType: "link",
    verificationStatus: "pending",
  },
];

const singleResourceMeta = {
  id: "res-001",
  title: "Introduction to Stellar",
  description: "A beginner's guide to Stellar blockchain",
  price: "5.00",
  resourceType: "link",
  verificationStatus: "verified",
  accessUrl: "https://example.com/stellar-intro",
};

describe("clientConfig", () => {
  it("defaults to a placeholder path and testnet under the test harness", () => {
    const result = clientConfig("cursor");
    expect(result).toContain("/absolute/path/to/zentrixpay/mcp/dist/index.js");
    expect(result).toContain('"STELLAR_NETWORK": "testnet"');
  });

  it("uses the servers key (not mcpServers) for vscode", () => {
    const result = clientConfig("vscode");
    const parsed = JSON.parse(result.replace(/^## .*\n\n```json\n/, "").replace(/\n```$/, ""));
    expect(parsed.servers).toBeDefined();
    expect(parsed.mcpServers).toBeUndefined();
    expect(parsed.servers.zentrixpay.type).toBe("stdio");
  });

  it("emits TOML for codex", () => {
    const result = clientConfig("codex");
    expect(result).toContain("[mcp_servers.zentrixpay]");
    expect(result).toContain('command = "node"');
    expect(result).not.toContain("{");
  });

  it("rejects an unknown client name", () => {
    expect(() => clientConfig("not-a-real-client")).toThrow(/Unknown client/);
  });

  it("returns every client's section when none is specified", () => {
    const result = clientConfig();
    for (const heading of [
      "## Claude Code",
      "## Claude Desktop",
      "## Codex",
      "## Cursor",
      "## VS Code",
      "## Windsurf",
    ]) {
      expect(result).toContain(heading);
    }
  });
});

describe("mainnetBanner", () => {
  it("reflects testnet by default and mentions the paid-confirmation policy", () => {
    const result = mainnetBanner();
    expect(result).toContain("testnet");
    expect(result).toContain("not real funds");
    expect(result).toContain("Paid-operation confirmation:");
  });
});

describe("txStatus", () => {
  const successEnvelope = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      status: "SUCCESS",
      ledger: 123456,
      createdAt: 1700000000,
      applicationOrder: 1,
      feeBump: false,
      envelopeXdr: "AAAA...env",
      resultXdr: "AAAA...res",
      resultMetaXdr: "AAAA...meta",
    },
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a readable SUCCESS response with ledger and close time", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(successEnvelope));
    const result = await txStatus("abc123");
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("SUCCESS");
    expect(parsed.hash).toBe("abc123");
    expect(parsed.ledger).toBe(123456);
    expect(parsed.ledgerCloseTime).toBe(new Date(1700000000 * 1000).toISOString());
    expect(parsed.resultXdr).toBe("AAAA...res");
  });

  it("returns a readable FAILED response carrying the result XDR", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ result: { ...successEnvelope.result, status: "FAILED" } }),
    );
    const result = await txStatus("def456");
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("FAILED");
    expect(parsed.resultXdr).toBe("AAAA...res");
  });

  it("returns an explicit NOT_FOUND message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ result: { status: "NOT_FOUND", oldestLedger: 1, latestLedger: 999 } }),
    );
    const result = await txStatus("missing");
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("NOT_FOUND");
    expect(parsed.message).toContain("not found");
  });

  it("returns a message for an empty hash without calling the RPC", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const result = await txStatus("   ");
    expect(result).toBe("Provide a transaction hash to look up.");
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws on a JSON-RPC error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: { code: -32602, message: "invalid hash" } }),
    );
    await expect(txStatus("bad")).rejects.toThrow("RPC error");
  });

  it("throws on a non-ok HTTP response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse({}, false, 503));
    await expect(txStatus("abc123")).rejects.toThrow("Soroban RPC error: 503");
  });

  it("posts a getTransaction request to the Soroban RPC", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(successEnvelope));
    await txStatus("abc123");
    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("getTransaction"),
      }),
    );
  });
});

// ── zentrixpay_buy (#313) ────────────────────────────────────────────────────

const testWallet = { publicKey: "GPUB...TEST", secretKey: "SECRET...KEY" };

// ── setupWallet – failure diagnostics (#414) ─────────────────────────────────

describe("setupWallet – sponsored account failure diagnostics", () => {
  beforeEach(() => {
    _resetProfiles();
  });

  afterEach(() => {
    _resetProfiles();
    vi.restoreAllMocks();
  });

  it("returns actionable error when service returns 503 (unavailable)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: "service temporarily unavailable" }, false, 503),
    );

    await expect(dispatchTool("zentrixpay_setup_wallet", {})).rejects.toThrow();
    try {
      await dispatchTool("zentrixpay_setup_wallet", {});
    } catch (err: any) {
      const msg = err.message;
      expect(msg).toContain("failed to create wallet");
      expect(msg).toContain("unavailable");
      expect(msg).toMatch(/restarting|wait/i);
    }
  });

  it("returns actionable error when service returns 429 (rate limited)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: "too many requests" }, false, 429),
    );

    try {
      await dispatchTool("zentrixpay_setup_wallet", {});
    } catch (err: any) {
      const msg = err.message;
      expect(msg).toContain("Rate limit");
      expect(msg).toMatch(/wait.*retry/i);
    }
  });

  it("includes service status and issue category in error output", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: "account creation failed" }, false, 500),
    );

    try {
      await dispatchTool("zentrixpay_setup_wallet", {});
    } catch (err: any) {
      const msg = err.message;
      expect(msg).toContain("Service:");
      expect(msg).toContain("Status:");
      expect(msg).toContain("Issue:");
    }
  });

  it("does not leak internal service details in error message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse(
        {
          internalErrorCode: "SPONSOR_DB_FAILED",
          debugStackTrace: "at Function.doSomething...",
        },
        false,
        500,
      ),
    );

    try {
      await dispatchTool("zentrixpay_setup_wallet", {});
    } catch (err: any) {
      const msg = err.message;
      expect(msg).not.toContain("SPONSOR_DB_FAILED");
      expect(msg).not.toContain("stackTrace");
      expect(msg).not.toContain("at Function");
    }
  });

  it("provides next steps without leaking internals", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ reason: "sponsorship quota exceeded" }, false, 400),
    );

    try {
      await dispatchTool("zentrixpay_setup_wallet", {});
    } catch (err: any) {
      const msg = err.message;
      expect(msg).toContain("Next:");
      expect(msg).toMatch(/malformed|client|issue/i);
    }
  });

  it("handles network errors deterministically", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED: Connection refused"));

    try {
      await dispatchTool("zentrixpay_setup_wallet", {});
    } catch (err: any) {
      const msg = err.message;
      expect(msg).toContain("Next:");
      expect(msg).toMatch(/network|connect/i);
    }
  });

  // An outage usually means the service never answers at all. That throws at the
  // transport layer, so these assert the diagnostics survive that path too.
  it("reports full diagnostics when the service is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED: Connection refused"));

    expect.assertions(5);
    try {
      await dispatchTool("zentrixpay_setup_wallet", {});
    } catch (err: any) {
      const msg = err.message;
      expect(msg).toContain("Service:");
      expect(msg).toContain("Issue: unreachable");
      expect(msg).toContain("Reachable: no");
      expect(msg).toContain("Retryable: yes");
      expect(msg).not.toContain("Status:");
    }
  });

  it("marks a rejected request as not worth retrying unchanged", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: "bad request" }, false, 400),
    );

    expect.assertions(2);
    try {
      await dispatchTool("zentrixpay_setup_wallet", {});
    } catch (err: any) {
      expect(err.message).toContain("Retryable: no");
      expect(err.message).toContain("Issue: rejected");
    }
  });

  it("passes the service's Retry-After through to the agent", async () => {
    const res = mockResponse({ error: "too many requests" }, false, 429);
    res.headers = new Headers({ "retry-after": "20" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(res);

    expect.assertions(2);
    try {
      await dispatchTool("zentrixpay_setup_wallet", {});
    } catch (err: any) {
      expect(err.message).toContain("Retry-After: 20s");
      expect(err.message).toContain("20s wait");
    }
  });
});

describe("repairSponsoredAccount", () => {
  const secretKey = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const publicKey = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  beforeEach(() => {
    _resetProfiles();
    vi.doMock("@stellar/stellar-sdk", () => ({
      Keypair: {
        fromSecret: vi.fn().mockReturnValue({ publicKey: () => publicKey }),
      },
    }));
  });

  afterEach(() => {
    _resetProfiles();
    vi.restoreAllMocks();
  });

  it("re-fetches Horizon state before restoring a half-created wallet", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({
        subentry_count: 1,
        balances: [
          { asset_type: "native", balance: "2.0000000" },
          { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "0.0000000" },
        ],
      }),
    );

    const result = JSON.parse(
      await dispatchTool("zentrixpay_repair_sponsored_account", {
        secretKey,
        profile: "recovered",
      }),
    );
    expect(result).toMatchObject({
      status: "repaired",
      profile: "recovered",
      address: publicKey,
      accountStatus: "zero",
      persisted: true,
    });
    expect(JSON.stringify(result)).not.toContain(secretKey);
  });

  it("does not restore a key when Horizon says the account is missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse({}, false, 404));

    await expect(dispatchTool("zentrixpay_repair_sponsored_account", { secretKey })).rejects.toThrow(
      /does not exist.*no local key was changed/i,
    );
  });
});

describe("multi-wallet profiles", () => {
  beforeEach(() => {
    _resetProfiles();
  });
  afterEach(() => {
    _resetProfiles();
    vi.restoreAllMocks();
  });

  const walletA = { publicKey: "GAAA", secretKey: "SAAA" };
  const walletB = { publicKey: "GBBB", secretKey: "SBBB" };

  it("use_profile creates a new empty profile and switches to it", () => {
    const result = useProfile("publisher");
    expect(result).toContain("Active profile: publisher");
    expect(result).toContain("No wallet in this profile yet");
    expect(listProfiles()).toContain("publisher");
  });

  it("use_profile reports the wallet when the profile already has one", () => {
    useProfile("publisher");
    _setAgentWallet(walletA);
    _setAgentApiKey("key-a");

    const result = useProfile("publisher");
    expect(result).toContain("Active profile: publisher");
    expect(result).toContain("GAAA");
    expect(result).toContain("Publisher registered: yes");
  });

  it("use_profile rejects invalid names with a deterministic message", () => {
    expect(() => useProfile("has space")).toThrow("Invalid profile name");
    expect(() => useProfile("")).toThrow("Invalid profile name");
  });

  it("switches the active profile and re-verifies the selected network", () => {
    try {
      const result = JSON.parse(switchNetworkProfile("mainnet", "mainnet"));
      expect(result.profile).toBe("mainnet");
      expect(result.network).toBe("mainnet");
      expect(result.verification.checks).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "STELLAR_NETWORK", ok: true })]),
      );
      expect(listProfiles()).toContain("mainnet");
    } finally {
      switchNetworkProfile("testnet", "testnet");
    }
  });

  it("keeps wallets isolated per profile", () => {
    useProfile("buyer");
    _setAgentWallet(walletA);
    useProfile("publisher");
    _setAgentWallet(walletB);

    const list = listProfiles();
    expect(list).toContain("buyer — GAAA");
    expect(list).toContain("publisher — GBBB");
    // The active profile is marked and its wallet is the one just set.
    expect(list).toMatch(/\*\s*publisher — GBBB/);
  });

  it("list_profiles reports an empty state before any profile exists", () => {
    expect(listProfiles()).toContain("No profiles yet");
  });

  it("list_profiles never exposes secret keys", () => {
    useProfile("publisher");
    _setAgentWallet(walletA);
    expect(listProfiles()).not.toContain("SAAA");
  });

  it("wallet_info shows the active profile and registration state", async () => {
    useProfile("mainnet");
    _setAgentWallet(walletA);
    _setAgentApiKey("key-a");
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        mockResponse({
          subentry_count: 2,
          balances: [
            { asset_type: "native", balance: "100.0000000" },
            { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "12.5" },
          ],
        }),
      ),
    );

    const result = await walletInfo();
    expect(result).toContain("Profile: mainnet");
    expect(result).toContain("Address: GAAA");
    expect(result).toContain("XLM Balance: 100.0000000");
    expect(result).toContain("XLM Reserved: 1.5"); // 0.5 base + 2 * 0.5
    expect(result).toContain("XLM Available: 98.5000000");
    expect(result).toContain("USDC Balance: 12.5");
    expect(result).toContain("USDC Status: funded");
    expect(result).toContain("Publisher registered: yes");
  });
});

describe("wallet_info balance details", () => {
  beforeEach(() => {
    _resetProfiles();
    _setAgentWallet(testWallet);
  });

  afterEach(() => {
    _resetProfiles();
    vi.restoreAllMocks();
  });

  it("distinguishes missing account (404 from Horizon)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse({}, false, 404));

    const result = await walletInfo();
    expect(result).toContain("XLM Balance: 0");
    expect(result).toContain("USDC Balance: 0");
    expect(result).toContain("USDC Status: missing");
    expect(result).toContain("Note: Account");
    expect(result).toContain("does not exist");
  });

  it("distinguishes missing USDC trustline (account exists, no USDC)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({
        subentry_count: 0,
        balances: [{ asset_type: "native", balance: "10.0000000" }],
      }),
    );

    const result = await walletInfo();
    expect(result).toContain("XLM Balance: 10.0000000");
    expect(result).toContain("XLM Reserved: 0.5");
    expect(result).toContain("XLM Available: 9.5000000");
    expect(result).toContain("USDC Balance: 0");
    expect(result).toContain("USDC Status: no-trustline");
    expect(result).toContain("Note: USDC trustline not found");
  });

  it("distinguishes zero USDC balance (trustline exists with 0 balance)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({
        subentry_count: 1,
        balances: [
          { asset_type: "native", balance: "5.0000000" },
          { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "0.0000000" },
        ],
      }),
    );

    const result = await walletInfo();
    expect(result).toContain("XLM Balance: 5.0000000");
    expect(result).toContain("XLM Reserved: 1.0"); // 0.5 base + 1 * 0.5
    expect(result).toContain("XLM Available: 4.0000000");
    expect(result).toContain("USDC Balance: 0.0000000");
    expect(result).toContain("USDC Status: zero");
    expect(result).toContain("Note: USDC balance is zero");
  });

  it("reports funded status when USDC balance is positive", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({
        subentry_count: 1,
        balances: [
          { asset_type: "native", balance: "50.1234567" },
          { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "99.9999999" },
        ],
      }),
    );

    const result = await walletInfo();
    expect(result).toContain("XLM Balance: 50.1234567");
    expect(result).toContain("XLM Reserved: 1.0");
    expect(result).toContain("XLM Available: 49.1234567");
    expect(result).toContain("USDC Balance: 99.9999999");
    expect(result).toContain("USDC Status: funded");
    expect(result).not.toContain("Note:");
  });

  it("calculates XLM reserve with multiple subentries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({
        subentry_count: 5, // 5 trustlines/offers/signers
        balances: [
          { asset_type: "native", balance: "20.0000000" },
          { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "10.0" },
        ],
      }),
    );

    const result = await walletInfo();
    expect(result).toContain("XLM Reserved: 3.0"); // 0.5 base + 5 * 0.5
    expect(result).toContain("XLM Available: 17.0000000"); // 20 - 3
  });

  it("reports zero XLM available when balance equals reserve", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({
        subentry_count: 1,
        balances: [
          { asset_type: "native", balance: "1.0000000" }, // exactly the reserve
          { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "5.0" },
        ],
      }),
    );

    const result = await walletInfo();
    expect(result).toContain("XLM Reserved: 1.0");
    expect(result).toContain("XLM Available: 0.0000000");
  });

  it("throws on Horizon error (non-404)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse({ error: "bad" }, false, 500));

    await expect(walletInfo()).rejects.toThrow("Horizon error 500");
  });
});

// ── networkProfile (#412) ───────────────────────────────────────────────────

describe("networkProfile", () => {
  it("returns all expected fields in deterministic JSON format", () => {
    const result = networkProfile();
    const parsed = JSON.parse(result);

    expect(parsed).toHaveProperty("stellarNetwork");
    expect(parsed).toHaveProperty("x402Network");
    expect(parsed).toHaveProperty("sorobanRpcUrl");
    expect(parsed).toHaveProperty("horizonUrl");
    expect(parsed).toHaveProperty("registryContractId");
    expect(parsed).toHaveProperty("usdcContractId");
    expect(parsed).toHaveProperty("warnings");
    expect(Array.isArray(parsed.warnings)).toBe(true);
  });

  it("reports testnet as stellarNetwork in test environment", () => {
    const result = networkProfile();
    const parsed = JSON.parse(result);

    expect(parsed.stellarNetwork).toBe("testnet");
  });

  it("includes expected testnet preset values", () => {
    const result = networkProfile();
    const parsed = JSON.parse(result);

    // Test environment uses testnet presets (from mocked registry-client)
    expect(parsed.sorobanRpcUrl).toBeTruthy();
    expect(parsed.horizonUrl).toBeTruthy();
    expect(parsed.registryContractId).toBeTruthy();
    expect(parsed.usdcContractId).toBeTruthy();
  });

  it("returns empty warnings array when no env overrides present", () => {
    const result = networkProfile();
    const parsed = JSON.parse(result);

    // In default test environment with no custom env vars
    expect(parsed.warnings).toEqual([]);
  });

  it("produces valid JSON that can be parsed", () => {
    const result = networkProfile();
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it("formats output with indentation for readability", () => {
    const result = networkProfile();
    // JSON.stringify with null, 2 produces indented output
    expect(result).toContain("\n");
    expect(result).toMatch(/{\s+"stellarNetwork":/);
  });

  it("includes x402Network field with valid network identifier", () => {
    const result = networkProfile();
    const parsed = JSON.parse(result);

    expect(parsed.x402Network).toBeTruthy();
    expect(typeof parsed.x402Network).toBe("string");
  });
});

// ── Tool dispatch argument validation ───────────────────────────────────────

describe("dispatchTool argument validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects an unknown tool without touching the network", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(dispatchTool("zentrixpay_nope", {})).rejects.toThrow(
      "Unknown tool: zentrixpay_nope",
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("produces the same error message for the same invalid call", async () => {
    const first = await dispatchTool("zentrixpay_tx_status", { txHash: "nope" }).catch((e) => e);
    const second = await dispatchTool("zentrixpay_tx_status", { txHash: "nope" }).catch((e) => e);
    expect(first.message).toBe(second.message);
    expect(first.message).toContain("hexadecimal");
  });
});

describe("API health preflight before mutation tools (#603)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _setAgentWallet(null);
    _setAgentApiKey(null);
    _resetProfiles();
  });

  it("refuses register before touching the network when the API is unreachable", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => mockResponse({ error: "down" }, false, 401));

    await expect(
      dispatchTool("zentrixpay_register", { name: "n", email: "e@example.com" }),
    ).rejects.toThrow("not reachable");

    // Only the preflight GET happened — no POST /publishers.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/health");
  });

  it("refuses rotate_key when the API is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      mockResponse({ error: "down" }, false, 401),
    );

    await expect(dispatchTool("zentrixpay_rotate_publisher_key", {})).rejects.toThrow(
      "not reachable",
    );
  });

  it("lets register proceed past the preflight when the API is healthy", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => mockResponse(sampleResources));

    // Preflight passes; the handler then fails on the missing wallet before
    // issuing any POST — proving the gate is passed, not that the tool ran.
    await expect(
      dispatchTool("zentrixpay_register", { name: "n", email: "e@example.com" }),
    ).rejects.toThrow("No wallet in profile");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

});

// ── half-completed sponsored-account creation (#839) ────────────────────────

describe("setupWallet – half-completed sponsored creation", () => {
  const sponsored = Keypair.random();
  const other = Keypair.random();

  beforeEach(() => {
    // Earlier suites stub @stellar/stellar-sdk with vi.doMock, which
    // restoreAllMocks does not undo. Key derivation must be the real thing here.
    vi.doUnmock("@stellar/stellar-sdk");
    _resetProfiles();
  });

  afterEach(() => {
    _resetProfiles();
    vi.restoreAllMocks();
  });

  it("persists a wallet whose secret derives the address it was given", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ publicKey: sponsored.publicKey(), secretKey: sponsored.secret() }),
    );

    const out = await dispatchTool("zentrixpay_setup_wallet", {});
    expect(out).toContain("Wallet created.");
    expect(out).toContain(`Address: ${sponsored.publicKey()}`);
    expect(out).toContain("persisted");
  });

  it("refuses a funded address that arrives without its secret key", async () => {
    // The shape a creation that funds the account and then times out leaves:
    // the agent would otherwise hold an address it can never sign for.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ publicKey: sponsored.publicKey() }),
    );

    await expect(dispatchTool("zentrixpay_setup_wallet", {})).rejects.toThrow(
      /no secret key|cannot sign/i,
    );
  });

  it("refuses a secret key belonging to a different account", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ publicKey: sponsored.publicKey(), secretKey: other.secret() }),
    );

    await expect(dispatchTool("zentrixpay_setup_wallet", {})).rejects.toThrow(/belongs to/i);
  });

  it("explains that nothing was persisted and a funded account may be orphaned", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ publicKey: sponsored.publicKey(), secretKey: "" }),
    );

    try {
      await dispatchTool("zentrixpay_setup_wallet", {});
      throw new Error("expected setup_wallet to reject");
    } catch (err: any) {
      expect(err.message).toContain("Nothing was persisted");
      expect(err.message).toContain("orphaned");
    }
  });

  it("leaves no wallet behind when the response is rejected", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ publicKey: sponsored.publicKey(), secretKey: other.secret() }),
    );

    await expect(dispatchTool("zentrixpay_setup_wallet", {})).rejects.toThrow();
    // No wallet was stored, so the next tool must report the wallet as missing
    // rather than reporting a balance for an address this agent cannot use.
    await expect(walletInfo()).rejects.toThrow(/zentrixpay_setup_wallet/);
  });

  it("warns in wallet_info when the stored secret does not own the address", async () => {
    _setAgentWallet({ publicKey: sponsored.publicKey(), secretKey: other.secret() });
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        mockResponse({
          subentry_count: 1,
          balances: [
            { asset_type: "native", balance: "10.0000000" },
            { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "25.0" },
          ],
        }),
      ),
    );

    const out = await walletInfo();
    expect(out).toContain("USDC Balance: 25.0");
    expect(out).toContain("Keystore:");
    expect(out).toContain("NOT spendable");
  });

  it("does not warn when the stored keypair is consistent", async () => {
    _setAgentWallet({ publicKey: sponsored.publicKey(), secretKey: sponsored.secret() });
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        mockResponse({
          subentry_count: 1,
          balances: [{ asset_type: "native", balance: "10.0000000" }],
        }),
      ),
    );

    expect(await walletInfo()).not.toContain("NOT spendable");
  });
});

// ── state-mutating calls are serialized (#550) ──────────────────────────────

describe("state-mutating calls are serialized (#550)", () => {
  // setupWallet verifies that the secret the service returns derives the
  // address it returns (#839), so these fixtures are real keypairs rather than
  // placeholder strings.
  const sponsored = Keypair.random();
  const SPONSORED_PUBLIC = sponsored.publicKey();
  const SPONSORED_SECRET = sponsored.secret();

  beforeEach(() => {
    vi.doUnmock("@stellar/stellar-sdk");
    _resetProfiles();
  });

  afterEach(() => {
    _resetProfiles();
    vi.restoreAllMocks();
  });

  it("persists the results of two concurrent mutating calls", async () => {
    // Each setupWallet call read-modify-writes the module-level profile state
    // across an `await` boundary (the sponsored-account POST). Serialized under
    // the state mutex, neither may clobber the other's saveState(), so both
    // profiles must survive.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ publicKey: SPONSORED_PUBLIC, secretKey: SPONSORED_SECRET }),
    );

    const [alice, bob] = await Promise.all([
      dispatchTool("zentrixpay_setup_wallet", { profile: "alice" }),
      dispatchTool("zentrixpay_setup_wallet", { profile: "bob" }),
    ]);

    expect(alice).toContain("Wallet created.");
    expect(bob).toContain("Wallet created.");
    expect(alice).toContain(`Address: ${SPONSORED_PUBLIC}`);
    expect(bob).toContain(`Address: ${SPONSORED_PUBLIC}`);

    const list = listProfiles();
    expect(list).toContain(`alice — ${SPONSORED_PUBLIC}`);
    expect(list).toContain(`bob — ${SPONSORED_PUBLIC}`);
  });

  it("keeps a serialized mutating call from losing an earlier profile", async () => {
    // Interleave a quick synchronous mutating call with a slow async one. Both
    // go through the same lock, so the slow wallet setup cannot run its
    // read-modify-write while use_profile is mid-flight and drop its profile.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ publicKey: SPONSORED_PUBLIC, secretKey: SPONSORED_SECRET }),
    );

    const [profile, wallet] = await Promise.all([
      dispatchTool("zentrixpay_use_profile", { name: "buyer" }),
      dispatchTool("zentrixpay_setup_wallet", { profile: "bob" }),
    ]);

    expect(profile).toContain("Active profile: buyer");
    expect(wallet).toContain(`Address: ${SPONSORED_PUBLIC}`);

    const list = listProfiles();
    expect(list).toContain("buyer");
    expect(list).toContain(`bob — ${SPONSORED_PUBLIC}`);
  });
});

// ── offline catalog cache fallback (#556) ────────────────────────────────────

describe("offline catalog cache fallback (#556)", () => {
  beforeEach(() => {
    _clearCatalogCache();
    _resetProfiles();
  });

  afterEach(() => {
    _clearCatalogCache();
    _resetProfiles();
    vi.restoreAllMocks();
  });

  const catalogItem = {
    id: "c1",
    title: "Cached One",
    price: "3",
    description: "A cached resource",
    accessUrl: "https://example.com/c1",
  };

  it("a mutating tool never falls back to the cached catalog", async () => {
    // Prime the cache as if a successful read had happened earlier.
    recordCatalogSnapshot([catalogItem]);
    _setAgentWallet(testWallet);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    // register must surface the network failure — not silently serve stale data.
    await expect(
      dispatchTool("zentrixpay_register", { name: "N", email: "e@example.com" }),
    ).rejects.toThrow();
  });
});

// ── disputeResource (#869) ──────────────────────────────────────────────────

describe("disputeResource", () => {
  beforeEach(() => {
    _resetProfiles();
  });

  it("throws when no wallet is set up", async () => {
    await expect(disputeResource("res-001", "flag", "Spam")).rejects.toThrow("No wallet");
  });

  it("succeeds (flag) in mock mode when wallet is present", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.ZENTRIXPAY_MOCK = "1";
    try {
      const res = await disputeResource("res-001", "flag", "Duplicate listing");
      const parsed = JSON.parse(res);
      expect(parsed.status).toBe("success");
      expect(parsed.resourceId).toBe("res-001");
      expect(parsed.action).toBe("flag");
      expect(parsed.reason).toBe("Duplicate listing");
      expect(parsed.txHash).toMatch(/MOCK_TX_DISPUTE_FLAG/);
    } finally {
      delete process.env.ZENTRIXPAY_MOCK;
    }
  });

  it("succeeds (unflag) in mock mode when wallet is present", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.ZENTRIXPAY_MOCK = "1";
    try {
      const res = await disputeResource("res-001", "unflag", "Issue resolved");
      const parsed = JSON.parse(res);
      expect(parsed.status).toBe("success");
      expect(parsed.action).toBe("unflag");
      expect(parsed.txHash).toMatch(/MOCK_TX_DISPUTE_UNFLAG/);
    } finally {
      delete process.env.ZENTRIXPAY_MOCK;
    }
  });

  it("dispatches through dispatchTool with valid arguments", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.ZENTRIXPAY_MOCK = "1";
    try {
      const res = await dispatchTool("zentrixpay_dispute", {
        resourceId: "res-001",
        action: "flag",
        reason: "Test flag",
      });
      expect(res).toContain("success");
      expect(res).toContain("flag");
    } finally {
      delete process.env.ZENTRIXPAY_MOCK;
    }
  });

  it("rejects an invalid action value", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.ZENTRIXPAY_MOCK = "1";
    try {
      await expect(
        dispatchTool("zentrixpay_dispute", {
          resourceId: "res-001",
          action: "delete",
          reason: "bad",
        }),
      ).rejects.toThrow();
    } finally {
      delete process.env.ZENTRIXPAY_MOCK;
    }
  });

  it("rejects a missing reason", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.ZENTRIXPAY_MOCK = "1";
    try {
      await expect(
        dispatchTool("zentrixpay_dispute", { resourceId: "res-001", action: "flag" }),
      ).rejects.toThrow();
    } finally {
      delete process.env.ZENTRIXPAY_MOCK;
    }
  });
});
