#!/usr/bin/env node
/**
 * ZentrixPay MCP Server
 * Exposes the pay-per-call gateway, wallet and profile tools to AI agents via the Model Context Protocol.
 */

import { checkContractBindings } from "@zentrixpay/registry-client";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PROMPT_DEFINITIONS, getPrompt } from "./prompts.js";
import { createProgressEmitter, scopeProgressToRequest } from "./progress.js";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { buildConfig, resolveConfig } from "./config.js";
import {
  assertMainnetMutationAllowed,
  formatMainnetBanner,
  formatMainnetDiagnostics,
  mainnetAllowedFromEnv,
} from "./mainnetGuardrails.js";
import {
  assertPaidOperationConfirmed,
  formatPaidConfirmationDiagnostics,
} from "./paidOperations.js";
import { assertToolAllowedInReadOnlyMode } from "./readOnlyMode.js";
import {
  createMetricsRecorder,
  measureTool,
  metricsEnabledFromEnv,
  metricsExportLine,
  metricsExportToConsoleEnabled,
  normalizeMetricsExportFormat,
  resolveToolDurationBudget,
  serializeMetricsExport,
  type MetricsExportFormat,
} from "./metrics.js";
import { createMockFetch, mockEnabledFromEnv } from "./mock.js";
import { purchaseHistoryTool, recordPurchase } from "./purchaseHistory.js";
import { Mutex } from "./mutex.js";
import { debugBundleTool } from "./debugBundle.js";
import { exportReceiptsToolWithTimeout } from "./receipts.js";
import { normalizeToolResult, outcomeText, type ToolOutcome } from "./toolResult.js";
import { advertisedTools, hasOutputSchema } from "./toolSurface.js";
import { correlationHeaders } from "./correlation.js";
import { API_TOOL_NAMES, createApiToolHandler } from "./apiTools.js";
import { initAuditLogging } from "./auditLog.js";
import {
  flag,
  optionalString,
  requiredString,
  TOOL_ARGUMENT_SPECS,
  TOOLS_WITHOUT_ARG_VALIDATION,
  UnknownToolError,
  validateToolArgs,
  type ValidatedArgs,
} from "./validation.js";
import {
  DEFAULT_PROFILE,
  isValidProfileName,
  migrateState,
  STATE_VERSION,
  type AgentWallet,
  type ProfileState,
  type WalletProfile,
} from "./profiles.js";
import { type ApiResponse } from "./apiResponse.js";
import { safeErrorMessage } from "./redaction.js";
import { assertAutoPaymentWithinCeiling } from "./paymentCeiling.js";
import {
  compareUsdc,
  normalizeUsdcBalance,
  stroopsToUsdc,
  trimUsdc,
  usdcToStroops as toStroops,
} from "./usdcAmount.js";
import { signMutatingHeaders } from "./requestSignature.js";
import {
  exportStateFile,
  restoreState,
  checkStatePermissions,
  preserveLegacyState,
  quarantineStateFile,
  writeAtomically,
} from "./stateBackup.js";
import { logger } from "./logger.js";
import { formatResetPreview, isResetConfirmed, type ResetScope } from "./resetGuard.js";
import { verifyInstall, formatVerifyInstall } from "./verifyInstall.js";
import {
  describeTimeouts,
  fetchWithTimeout,
  resolveTimeouts,
  resolveUserAgent,
  withTimeout,
  type TimeoutService,
} from "./httpTimeout.js";
import { resolveToolTimeouts, timeoutForTool } from "./toolTimeoutOverrides.js";
import {
  describeRetryPolicy,
  formatRetryLog,
  isIdempotentMethod,
  isRetryableStatus,
  retryAfterDelay,
  retryPolicyFromEnv,
  withRetry,
  type RetryAttemptInfo,
} from "./retry.js";
import {
  mapRegistryError,
  mapTransportError,
  mappedErrorOf,
  mcpError,
  troubleshootingHint,
  throwHttpError,
  type CredentialContext,
  type ErrorSource,
} from "./errorMapping.js";
import {
  mapSponsoredHttpFailure,
  mapSponsoredTransportFailure,
  sanitizeServiceUrl,
  SPONSORED_CREATE_PATH,
} from "./sponsoredDiagnostics.js";
import {
  checkWalletIntegrity,
  sponsoredWalletIntegrityError,
  unownedWalletNote,
  type DerivePublicKey,
} from "./sponsoredWallet.js";
import { type CatalogFilters } from "./catalogFilters.js";

// ── Config ────────────────────────────────────────────────────────────────────

// Network, URL, and contract-id resolution lives in ./config.ts as a pure,
// unit-tested function so the config path no longer runs as an untestable
// top-level side effect. The named aliases below keep the rest of this file
// unchanged.
const initialConfig = buildConfig(process.env);
let STELLAR_NETWORK = initialConfig.stellarNetwork;
let networkPreset = initialConfig.networkPreset;
let NETWORK = initialConfig.x402Network;
const BASE_URL = initialConfig.baseUrl;
let REGISTRY_CONTRACT_ID = initialConfig.registryContractId;
let REGISTRY_NETWORK_PASSPHRASE = initialConfig.registryNetworkPassphrase;
const SPONSORED_ACCOUNT_URL = initialConfig.sponsoredAccountUrl;
let HORIZON_URL = initialConfig.horizonUrl;
let SOROBAN_RPC_URL = initialConfig.sorobanRpcUrl;
const PLATFORM_WALLET_ADDRESS = initialConfig.platformWalletAddress;

function applyNetworkConfig(network: "testnet" | "mainnet"): void {
  process.env.STELLAR_NETWORK = network;
  const next = buildConfig(process.env);
  STELLAR_NETWORK = next.stellarNetwork;
  networkPreset = next.networkPreset;
  NETWORK = next.x402Network;
  REGISTRY_CONTRACT_ID = next.registryContractId;
  REGISTRY_NETWORK_PASSPHRASE = next.registryNetworkPassphrase;
  HORIZON_URL = next.horizonUrl;
  SOROBAN_RPC_URL = next.sorobanRpcUrl;
}

// Startup diagnostics: collect every configuration problem in one pass so the
// operator sees the full list (with exact variable names and expected values)
// instead of fixing them one failed launch at a time. `resolveConfig` returns
// the validation result rather than exiting; the fail-fast decision stays here.
// Warnings are printed but non-fatal; any error stops the server. Skipped under
// tests and in mock mode so unit runs and offline local development never exit.
if (!process.env.VITEST && !mockEnabledFromEnv(process.env)) {
  const startup = resolveConfig(process.env);
  if (startup.report) console.error(startup.report);
  if (!startup.ok) process.exit(1);
}

const metrics = createMetricsRecorder(
  metricsEnabledFromEnv(process.env),
  resolveToolDurationBudget(process.env),
);

initAuditLogging(process.env);

const MOCK = mockEnabledFromEnv(process.env);
function _isMock(): boolean {
  return mockEnabledFromEnv(process.env);
}
export function _setMockMode(on: boolean): void {
  if (on) process.env.ZENTRIXPAY_MOCK = "1";
  else delete process.env.ZENTRIXPAY_MOCK;
}
const httpFetch: typeof fetch = MOCK
  ? createMockFetch(() => currentWallet()?.publicKey)
  : (input, init) => fetch(input as RequestInfo | URL, init);

const TIMEOUTS = resolveTimeouts(process.env);
const TOOL_TIMEOUTS = resolveToolTimeouts(process.env).overrides;

const RETRY_POLICY = retryPolicyFromEnv(process.env);

const USER_AGENT = resolveUserAgent(process.env);

const logRetry = process.env.VITEST
  ? undefined
  : (info: RetryAttemptInfo) => logger.info(`ZentrixPay MCP: ${formatRetryLog(info)}`);

function httpRetryOptions(label: string) {
  return {
    policy: RETRY_POLICY,
    label,
    shouldRetryResult: (res: Response) => isRetryableStatus(res.status),
    describeResult: (res: Response) => `HTTP ${res.status}`,
    delayFromResult: (res: Response) =>
      retryAfterDelay(res.headers?.get?.("retry-after"), RETRY_POLICY),
    onRetry: logRetry,
  };
}

function sorobanRpcFetch(init: RequestInit, label: string): Promise<Response> {
  const initWithUA: RequestInit = {
    ...init,
    headers: {
      "User-Agent": USER_AGENT,
      ...correlationHeaders(init.headers as Record<string, string> | undefined),
    },
  };
  return withRetry(
    () => fetchWithTimeout(httpFetch, SOROBAN_RPC_URL, initWithUA, "soroban", TIMEOUTS.soroban),
    httpRetryOptions(label),
  );
}

// ── State persistence ─────────────────────────────────────────────────────────

const STATE_DIR = join(homedir(), ".zentrixpay");
const STATE_FILE = join(STATE_DIR, "state.json");

let profiles: Record<string, WalletProfile> = {};
let activeProfileName: string = DEFAULT_PROFILE;

function activeProfile(): WalletProfile {
  return (profiles[activeProfileName] ??= {});
}

function bindActiveProfileToNetwork(): void {
  activeProfile().network ??= NETWORK as "testnet" | "mainnet";
}

function currentWallet(): AgentWallet | null {
  return profiles[activeProfileName]?.wallet ?? null;
}

function currentApiKey(): string | null {
  return profiles[activeProfileName]?.apiKey ?? null;
}

export function _setAgentWallet(w: AgentWallet | null): void {
  if (w) {
    activeProfile().wallet = w;
    bindActiveProfileToNetwork();
  } else delete activeProfile().wallet;
}
export function _setAgentApiKey(k: string | null): void {
  if (k) activeProfile().apiKey = k;
  else delete activeProfile().apiKey;
}
export function _resetProfiles(): void {
  profiles = {};
  activeProfileName = DEFAULT_PROFILE;
}

function applyRestoredState(state: ProfileState): void {
  profiles = state.profiles;
  activeProfileName = state.activeProfile;
  saveState();
}

export function backupState(passphrase: string, confirm: unknown = false): string {
  if (!isResetConfirmed(confirm)) {
    return [
      "Backup NOT performed — confirmation required.",
      "This will export every wallet secret key and publisher API key in encrypted form.",
      "To proceed, call zentrixpay_backup_state again with confirm: true.",
    ].join("\n");
  }
  const path = exportStateFile(passphrase);
  return [
    "Encrypted state backup written.",
    `File: ${path}`,
    "The file is mode 0600 and contains no plaintext secrets.",
    "Restore with zentrixpay_restore_state using the file contents as blob and the same passphrase.",
  ].join("\n");
}

export function restoreStateTool(blob: string, passphrase: string): string {
  return restoreState(blob, passphrase, applyRestoredState, {
    expectedNetwork: NETWORK,
  });
}

function quarantineCorruptState(reason: string, detail: string): void {
  try {
    const quarantined = quarantineStateFile(STATE_FILE);
    console.error(
      `ZentrixPay MCP: state file ${STATE_FILE} ${reason} and was quarantined to ${quarantined}; ` +
        `starting fresh.${detail ? ` ${detail}` : ""}`,
    );
  } catch (err) {
    console.error(
      `ZentrixPay MCP: state file ${STATE_FILE} ${reason}; starting fresh ` +
        `(could not quarantine the file: ${safeErrorMessage(err)}).`,
    );
  }
}

function loadState(): void {
  if (!existsSync(STATE_FILE)) return;

  let raw: string;
  try {
    raw = readFileSync(STATE_FILE, "utf-8");
  } catch (err) {
    quarantineCorruptState("could not be read", safeErrorMessage(err));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    quarantineCorruptState("is not valid JSON", safeErrorMessage(err));
    return;
  }

  const { state, migrated, legacy } = migrateState(parsed);

  if (Object.keys(state.profiles).length === 0) {
    quarantineCorruptState("did not contain a recognisable profile", "");
    return;
  }

  profiles = state.profiles;
  activeProfileName = state.activeProfile;
  if (migrated) {
    try {
      preserveLegacyState(legacy);
    } catch (err) {
      console.error(
        "ZentrixPay MCP: failed to preserve legacy state before migration:",
        safeErrorMessage(err),
      );
    }
    saveState();
  }
}

function persistableProfiles(): Record<string, WalletProfile> {
  const out: Record<string, WalletProfile> = {};
  for (const [name, profile] of Object.entries(profiles)) {
    if (profile.wallet || profile.apiKey || name === activeProfileName) out[name] = profile;
  }
  return out;
}

/**
 * Persist the profile state, reporting whether the write landed.
 *
 * A failed write stays non-fatal — losing the state file must not take the
 * server down mid-session — but callers that just told the agent its wallet is
 * safe on disk need to know when it is not (#839). Callers that do not care can
 * keep ignoring the result.
 */
function saveState(): boolean {
  try {
    const state: ProfileState = {
      version: STATE_VERSION,
      activeProfile: activeProfileName,
      profiles: persistableProfiles(),
    };
    writeAtomically(STATE_FILE, JSON.stringify(state, null, 2), 0o600);
    return true;
  } catch (err) {
    console.error("ZentrixPay MCP: failed to persist state:", safeErrorMessage(err));
    return false;
  }
}

function currentResetScope(all: boolean): ResetScope {
  return {
    all,
    activeProfile: activeProfileName,
    profileNames: Object.keys(profiles),
    hasWallet: !!currentWallet(),
    hasApiKey: !!currentApiKey(),
    stateFile: STATE_FILE,
  };
}

export function resetState(all: boolean, confirm: unknown = false): string {
  if (!isResetConfirmed(confirm)) return formatResetPreview(currentResetScope(all));

  if (all) {
    profiles = {};
    activeProfileName = DEFAULT_PROFILE;
    try {
      if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
    } catch (err) {
      return `All profiles cleared from memory. Warning: could not delete state file (${STATE_FILE}): ${err}`;
    }
    return `Reset complete. All profiles removed from memory and disk.\nState file: ${STATE_FILE}`;
  }

  const name = activeProfileName;
  delete profiles[name];
  saveState();
  return [
    `Profile "${name}" cleared (wallet and publisher API key removed).`,
    `Remaining profiles: ${Object.keys(profiles).length}.`,
    `State file: ${STATE_FILE}`,
  ].join("\n");
}

function checkStatePermissionsTool(): string {
  const result = checkStatePermissions();
  const lines = [
    `State file: ${STATE_FILE}`,
    `Exists: ${result.exists}`,
    result.mode ? `Current mode: ${result.mode}` : null,
    `Expected mode: ${result.expectedMode}`,
    `Safe: ${result.isSafe ? "yes" : "no"}`,
    "",
    result.message,
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}

interface DependencyStatus {
  name: string;
  ok: boolean;
  message: string;
}

async function checkDependency(
  name: string,
  url: string,
  init?: RequestInit,
): Promise<DependencyStatus> {
  const initWithUA: RequestInit = {
    ...init,
    headers: {
      "User-Agent": USER_AGENT,
      ...correlationHeaders(init?.headers as Record<string, string> | undefined),
    },
  };
  try {
    const res = await withRetry(
      () => fetchWithTimeout(httpFetch, url, initWithUA, "http", TIMEOUTS.http),
      httpRetryOptions(`health:${name}`),
    );
    if (res.ok) {
      return { name, ok: true, message: `Reachable (HTTP ${res.status})` };
    }
    return { name, ok: false, message: `Returned HTTP ${res.status}` };
  } catch (err) {
    return { name, ok: false, message: `Unreachable: ${safeErrorMessage(err)}` };
  }
}

// ── #878: Mainnet session banner ─────────────────────────────────────────────
// formatMainnetDiagnostics/formatPaidConfirmationDiagnostics are compact
// one-liners meant for repeated diagnostic output. This is the fuller,
// session-level version: a plain-language explanation of the active network
// and the paid-operation confirmation policy together, meant to be read once
// when an agent session starts, before it attempts any paid or destructive
// operation.
export function mainnetBanner(): string {
  const banner = formatMainnetBanner({
    stellarNetwork: STELLAR_NETWORK,
    x402Network: NETWORK,
    registryContractId: REGISTRY_CONTRACT_ID,
    allowMainnetEnv: mainnetAllowedFromEnv(),
  });
  return [banner, "", formatPaidConfirmationDiagnostics()].join("\n");
}

const API_MUTATION_TOOLS = new Set([
  "zentrixpay_register",
  "zentrixpay_rotate_publisher_key",
]);

async function assertApiReachableFor(toolName: string): Promise<void> {
  const dep = await checkDependency("ZentrixPay API", `${BASE_URL}/health`);
  if (dep.ok) return;
  throw mcpError({
    source: "api",
    category: "network",
    summary: `${toolName} was not attempted because the ZentrixPay API is not reachable (${dep.message}).`,
    action:
      "Check network connectivity to the ZentrixPay API and retry; if it stays down the mutation cannot succeed, so defer it.",
  });
}

async function importWallet(args: {
  secretKey?: string;
  profile?: string;
  persist?: boolean;
}): Promise<ToolOutcome> {
  const target = resolveProfileName(args.profile);
  const persist = args.persist !== false;

  let secretKey = args.secretKey;
  if (!secretKey) {
    secretKey = process.env.ZENTRIXPAY_AGENT_SECRET;
  }
  if (!secretKey) {
    throw new Error(
      "No secret key provided. Pass secretKey or set ZENTRIXPAY_AGENT_SECRET in the environment.",
    );
  }

  if (!/^S[A-Z2-7]{55}$/.test(secretKey)) {
    throw new Error("Invalid Stellar secret key. Must be S followed by 55 base32 characters.");
  }

  let publicKey: string;
  try {
    const { Keypair } = await import("@stellar/stellar-sdk");
    const keypair = Keypair.fromSecret(secretKey);
    publicKey = keypair.publicKey();
  } catch (err) {
    throw new Error(`Failed to derive public key: ${safeErrorMessage(err)}`);
  }

  if (persist) {
    activeProfileName = target;
    activeProfile().wallet = { publicKey, secretKey };
    bindActiveProfileToNetwork();
    saveState();
    return {
      text: [
        `Wallet imported.`,
        `Profile: ${target}`,
        `Address: ${publicKey}`,
        `Wallet persisted to ${STATE_FILE} (mode 0600).`,
      ].join("\n"),
      structured: { profile: target, address: publicKey, persisted: true },
    };
  }

  return {
    text: [
      `Wallet validated (not persisted).`,
      `Address: ${publicKey}`,
      `Pass persist: true to save to the state file.`,
    ].join("\n"),
    structured: { profile: target, address: publicKey, persisted: false },
  };
}

async function rotatePublisherKey(profileArg?: string): Promise<string> {
  const target = resolveProfileName(profileArg);
  const wallet = requireWallet();
  const oldApiKey = profiles[target]?.apiKey;
  if (!oldApiKey) {
    throw new Error(`No publisher API key in profile "${target}". Run zentrixpay_register first.`);
  }

  const res = await jsonFetch(`${BASE_URL}/publishers/me/rotate-key`, {
    method: "POST",
    headers: { "x-api-key": oldApiKey },
  });

  if (!res.ok) {
    throwHttpError({
      operation: "Failed to rotate publisher API key",
      source: "api",
      status: res.status,
      data: res.data,
      credential: publisherCredential(target),
    });
  }

  const newApiKey = res.data.apiKey;
  if (typeof newApiKey !== "string" || newApiKey.length === 0) {
    throw new Error("Server returned an empty API key. Contact support.");
  }

  if (!profiles[target]) profiles[target] = {};
  profiles[target].apiKey = newApiKey;
  if (target === activeProfileName) {
    // already active
  } else {
    activeProfileName = target;
  }
  saveState();

  return [
    `Publisher API key rotated.`,
    `Profile: ${target}`,
    `Publisher ID: ${res.data.id ?? "(unknown)"}`,
    `New key persisted to ${STATE_FILE} (not shown).`,
    `The old key has been invalidated server-side.`,
  ].join("\n");
}

function resolveProfileName(name: unknown): string {
  if (name === undefined || name === null || name === "") return activeProfileName;
  if (!isValidProfileName(name)) {
    throw new Error(
      `Invalid profile name. Use 1–64 characters from letters, digits, dot, dash, or underscore.`,
    );
  }
  return name;
}

loadState();

// ── Helpers ───────────────────────────────────────────────────────────────────

function sourceForUrl(url: string): ErrorSource {
  if (url.startsWith(SPONSORED_ACCOUNT_URL)) return "sponsored";
  if (url.startsWith(HORIZON_URL)) return "horizon";
  if (url.startsWith(SOROBAN_RPC_URL)) return "soroban";
  return "api";
}

function timeoutServiceForUrl(url: string): TimeoutService {
  if (url.startsWith(HORIZON_URL)) return "horizon";
  if (url.startsWith(SOROBAN_RPC_URL)) return "soroban";
  return "http";
}

const SERVICE_OPERATION: Record<ErrorSource, string> = {
  api: "ZentrixPay API request failed",
  horizon: "Horizon request failed",
  soroban: "Soroban RPC request failed",
  sponsored: "Sponsored-account request failed",
  x402: "x402 payment request failed",
  registry: "Registry request failed",
};

async function jsonFetch(url: string, init?: RequestInit): Promise<ApiResponse<any>> {
  const method = (init?.method ?? "GET").toUpperCase();
  const body =
    typeof init?.body === "string" ? init.body : init?.body ? JSON.stringify(init.body) : undefined;
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    ...correlationHeaders(init?.headers as Record<string, string> | undefined),
  };
  const headers = signMutatingHeaders(url, method, baseHeaders, body);

  let res: Response;
  try {
    const service = timeoutServiceForUrl(url);
    const call = () =>
      fetchWithTimeout(
        httpFetch,
        url,
        { ...init, method, body: body ?? init?.body, headers },
        service,
        TIMEOUTS[service],
      );
    res = isIdempotentMethod(method)
      ? await withRetry(call, httpRetryOptions(`${method} ${new URL(url).pathname}`))
      : await call();
  } catch (err) {
    const source = sourceForUrl(url);
    throw mcpError(mapTransportError({ operation: SERVICE_OPERATION[source], source, error: err }));
  }

  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key.toLowerCase()] = value;
  });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text), headers: responseHeaders };
  } catch {
    return { ok: res.ok, status: res.status, data: text, headers: responseHeaders };
  }
}

function requireWallet(): AgentWallet {
  const wallet = currentWallet();
  if (!wallet) {
    throw new Error(
      `No wallet in profile "${activeProfileName}". Run zentrixpay_setup_wallet first.`,
    );
  }
  return wallet;
}

function publisherCredential(profile: string = activeProfileName): CredentialContext {
  return { kind: "publisher_api_key", profile };
}

function requireApiKey(): string {
  const apiKey = currentApiKey();
  if (!apiKey) {
    throw new Error(
      `Not registered in profile "${activeProfileName}". Run zentrixpay_register first.`,
    );
  }
  return apiKey;
}

function makePaidFetch(wallet: AgentWallet) {
  const signer = createEd25519Signer(wallet.secretKey, NETWORK);
  const scheme = new ExactStellarScheme(signer);
  const client = new x402Client().register(NETWORK, scheme);
  return wrapFetchWithPayment(withTimeout(httpFetch, "payment", TIMEOUTS.payment), client);
}

interface BalanceDetails {
  status: "missing" | "no-trustline" | "zero" | "funded";
  xlmBalance: string;
  xlmReserve: string;
  xlmAvailable: string;
  usdcBalance: string;
  message?: string;
}

async function getBalanceDetails(publicKey: string): Promise<BalanceDetails> {
  let res: Response;
  try {
    res = await withRetry(
      () =>
        fetchWithTimeout(
          httpFetch,
          `${HORIZON_URL}/accounts/${publicKey}`,
          { headers: { "User-Agent": USER_AGENT } },
          "horizon",
          TIMEOUTS.horizon,
        ),
      httpRetryOptions("GET horizon /accounts"),
    );
  } catch (err) {
    throw mcpError(
      mapTransportError({
        operation: "Horizon request failed",
        source: "horizon",
        error: err,
      }),
    );
  }

  if (res.status === 404) {
    return {
      status: "missing",
      xlmBalance: "0",
      xlmReserve: "0",
      xlmAvailable: "0",
      usdcBalance: "0",
      message: `Account ${publicKey} does not exist. Fund it with at least 1 XLM to activate.`,
    };
  }

  if (!res.ok) {
    throwHttpError({
      operation: `Horizon error ${res.status}`,
      source: "horizon",
      status: res.status,
      data: await res.text().catch(() => null),
    });
  }

  const data: any = await res.json();
  const balances: any[] = data.balances ?? [];

  const xlmBalance = balances.find((b: any) => b.asset_type === "native");
  const xlm = xlmBalance?.balance ?? "0";

  const subentryCount = data.subentry_count ?? 0;
  const baseReserve = 0.5;
  const entryReserve = 0.5;
  const reserve = baseReserve + subentryCount * entryReserve;
  const available = Math.max(0, parseFloat(xlm) - reserve);

  const usdcBalance = balances.find(
    (b: any) => b.asset_type === "credit_alphanum4" && b.asset_code === "USDC",
  );

  if (!usdcBalance) {
    return {
      status: "no-trustline",
      xlmBalance: xlm,
      xlmReserve: reserve.toFixed(1),
      xlmAvailable: available.toFixed(7),
      usdcBalance: "0",
      message: `USDC trustline not found. Add a USDC trustline to receive payments.`,
    };
  }

  // Horizon sends a decimal string; the balance is tagged with that encoding
  // and normalized once, so the number this status is decided from can never be
  // a stroop count read as decimal USDC (#838).
  const usdc = usdcBalance.balance ?? "0";
  const normalized = normalizeUsdcBalance({ source: "horizon", balance: usdc });

  if (normalized === null) {
    return {
      status: "zero",
      xlmBalance: xlm,
      xlmReserve: reserve.toFixed(1),
      xlmAvailable: available.toFixed(7),
      usdcBalance: "0",
      message:
        `Horizon reported a USDC balance this server could not read ("${String(usdc).slice(0, 32)}"), ` +
        `so it is treated as zero rather than guessed at. Re-run zentrixpay_wallet_info; if it persists, the Horizon endpoint is returning an unexpected balance format.`,
    };
  }

  if (toStroops(normalized) === 0n) {
    return {
      status: "zero",
      xlmBalance: xlm,
      xlmReserve: reserve.toFixed(1),
      xlmAvailable: available.toFixed(7),
      usdcBalance: usdc,
      message: `USDC balance is zero. Fund the account to use x402 payments.`,
    };
  }

  return {
    status: "funded",
    xlmBalance: xlm,
    xlmReserve: reserve.toFixed(1),
    xlmAvailable: available.toFixed(7),
    usdcBalance: usdc,
  };
}

async function getUsdcBalance(publicKey: string): Promise<string> {
  try {
    const details = await getBalanceDetails(publicKey);
    return details.usdcBalance;
  } catch {
    return "0";
  }
}

async function getAccountBalances(
  publicKey: string,
): Promise<{ usdc: string; native: string; funded: boolean }> {
  const res = await withRetry(
    () =>
      fetchWithTimeout(
        httpFetch,
        `${HORIZON_URL}/accounts/${publicKey}`,
        { headers: { "User-Agent": USER_AGENT } },
        "horizon",
        TIMEOUTS.horizon,
      ),
    httpRetryOptions("GET horizon /accounts"),
  );
  if (!res.ok) return { usdc: "0", native: "0", funded: false };
  const data: any = await res.json();
  const balances: any[] = data.balances ?? [];
  const usdc = balances.find((b) => b.asset_type === "credit_alphanum4" && b.asset_code === "USDC");
  const native = balances.find((b) => b.asset_type === "native");
  return { usdc: usdc?.balance ?? "0", native: native?.balance ?? "0", funded: true };
}

export type SearchFilters = CatalogFilters;

async function insufficientFundsMessage(
  wallet: AgentWallet,
  amountNeeded: string | number,
  action: string,
): Promise<string | null> {
  const need = typeof amountNeeded === "number" ? amountNeeded : parseFloat(amountNeeded);
  if (!Number.isFinite(need)) return null;
  const balance = await getUsdcBalance(wallet.publicKey);

  // Compared in stroops rather than floats, so the decision to spend never
  // depends on binary rounding, and an amount that cannot be parsed blocks the
  // payment instead of reading as "enough" (#838).
  const needAmount = need.toFixed(7);
  const comparison = compareUsdc(balance, needAmount);
  if (comparison === null) {
    return [
      `Cannot confirm the USDC balance before paying to ${action}.`,
      `Amount needed: ${trimUsdc(needAmount)} USDC`,
      `Reported balance: "${String(balance).slice(0, 32)}" could not be read as a USDC amount.`,
      `No payment was submitted. Check the wallet with zentrixpay_wallet_info and retry.`,
    ].join("\n");
  }
  if (comparison >= 0) return null;

  const shortfallStroops = (toStroops(needAmount) ?? 0n) - (toStroops(balance) ?? 0n);
  return [
    `Insufficient USDC to ${action}.`,
    `Amount needed: ${trimUsdc(needAmount)} USDC`,
    `Current balance: ${trimUsdc(balance)} USDC`,
    `Shortfall: ${trimUsdc(stroopsToUsdc(shortfallStroops))} USDC`,
    `Fund ${wallet.publicKey} with the shortfall and retry.`,
  ].join("\n");
}

export async function txStatus(txHash: string): Promise<string> {
  const hash = (txHash ?? "").trim();
  if (!hash) return "Provide a transaction hash to look up.";
  const res = await sorobanRpcFetch(
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: { hash },
      }),
    },
    "POST soroban getTransaction",
  );
  if (!res.ok)
    throwHttpError({
      operation: `Soroban RPC error: ${res.status}`,
      source: "soroban",
      status: res.status,
      data: await res.text().catch(() => null),
    });
  const data: any = await res.json();
  if (data.error)
    throw mcpError(
      mapRegistryError({
        operation: "RPC error",
        message: JSON.stringify(data.error),
        source: "soroban",
      }),
    );
  const tx = data.result;
  if (tx.status === "NOT_FOUND") {
    return JSON.stringify(
      {
        status: "NOT_FOUND",
        hash,
        message:
          "Transaction not found on the configured Soroban RPC. It may be unconfirmed, on a different network, or outside the RPC's retention window.",
        oldestLedger: tx.oldestLedger,
        latestLedger: tx.latestLedger,
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      status: tx.status,
      hash,
      ledger: tx.ledger,
      ledgerCloseTime: tx.createdAt ? new Date(tx.createdAt * 1000).toISOString() : null,
      applicationOrder: tx.applicationOrder,
      feeBump: tx.feeBump,
      envelopeXdr: tx.envelopeXdr,
      resultXdr: tx.resultXdr,
      resultMetaXdr: tx.resultMetaXdr,
    },
    null,
    2,
  );
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

function hasPublicErrorDetail(data: unknown): boolean {
  if (typeof data === "string") return data.trim().length > 0;
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  return ["error", "message", "detail", "reason"].some((key) => {
    const value = obj[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function sponsoredAccountErrorData(status: number, data: unknown): unknown {
  if (status >= 500 && !hasPublicErrorDetail(data)) {
    return { message: "internal service error" };
  }
  return data;
}

/**
 * Stellar key derivation for the wallet integrity checks, loaded on demand.
 *
 * The SDK import is deferred — as `zentrixpay_import_wallet` already does — so
 * the full Stellar SDK stays off the server's startup path.
 */
async function stellarDerivePublicKey(): Promise<DerivePublicKey> {
  const { Keypair } = await import("@stellar/stellar-sdk");
  return (secretKey: string) => Keypair.fromSecret(secretKey).publicKey();
}

async function setupWallet(profileArg?: string): Promise<ToolOutcome> {
  const target = resolveProfileName(profileArg);
  const operation = "zentrixpay_setup_wallet failed to create wallet";

  let res: Awaited<ReturnType<typeof jsonFetch>>;
  try {
    res = await jsonFetch(`${SPONSORED_ACCOUNT_URL}${SPONSORED_CREATE_PATH}`, { method: "POST" });
  } catch (err) {
    const mapped = mappedErrorOf(err);
    if (!mapped) throw err;
    throw mcpError(
      mapSponsoredTransportFailure({ operation, serviceUrl: SPONSORED_ACCOUNT_URL, mapped }),
    );
  }

  if (!res.ok) {
    throw mcpError(
      mapSponsoredHttpFailure({
        operation,
        serviceUrl: SPONSORED_ACCOUNT_URL,
        status: res.status,
        data: res.data,
        headers: res.headers,
      }),
    );
  }
  // A 200 is not proof the service completed: a half-finished creation can
  // answer with an address whose secret is missing or belongs to a different
  // account. Persisting that gives the agent a funded address it cannot sign
  // for, which every later tool then reports as a healthy wallet (#839).
  const integrity = checkWalletIntegrity(res.data ?? {}, await stellarDerivePublicKey());
  if (!integrity.ok) {
    throw sponsoredWalletIntegrityError(integrity, sanitizeServiceUrl(SPONSORED_ACCOUNT_URL));
  }

  activeProfileName = target;
  activeProfile().wallet = { publicKey: integrity.publicKey, secretKey: integrity.secretKey };
  const persisted = saveState();
  const text = [
    `Wallet created.`,
    `Profile: ${target}`,
    `Address: ${integrity.publicKey}`,
    persisted
      ? `Wallet persisted to ${STATE_FILE} (mode 0600).`
      : `⚠ Wallet held in memory only — writing ${STATE_FILE} failed, so it is lost when this server stops. ` +
        `Back it up now with zentrixpay_backup_state, then fix the state directory's permissions.`,
  ].join("\n");
  return {
    text,
    structured: { profile: target, address: integrity.publicKey, persisted },
  };
}

async function repairSponsoredAccount(secretKey: string, profileArg?: string): Promise<string> {
  const target = resolveProfileName(profileArg);
  const { Keypair } = await import("@stellar/stellar-sdk");
  const publicKey = Keypair.fromSecret(secretKey).publicKey();
  const details = await getBalanceDetails(publicKey);

  if (details.status === "missing") {
    throw new Error(
      `Sponsored-account repair stopped: ${publicKey} does not exist on the configured Stellar network. Retry zentrixpay_setup_wallet; no local key was changed.`,
    );
  }

  activeProfileName = target;
  activeProfile().wallet = { publicKey, secretKey };
  saveState();
  return JSON.stringify(
    {
      status: "repaired",
      profile: target,
      address: publicKey,
      accountStatus: details.status,
      xlmBalance: details.xlmBalance,
      usdcBalance: details.usdcBalance,
      persisted: true,
      message:
        details.status === "no-trustline"
          ? "Wallet key restored, but the sponsored account still needs a USDC trustline."
          : "Wallet key restored after confirming the sponsored account on Horizon.",
    },
    null,
    2,
  );
}

async function walletInfoOutcome(): Promise<ToolOutcome> {
  const wallet = requireWallet();
  const details = await getBalanceDetails(wallet.publicKey);
  const publisherRegistered = !!currentApiKey();

  // A stored keypair can name an address this agent cannot sign for — a
  // half-completed sponsored creation, a hand-edited state file, a restored
  // backup from another profile. The balance below is real either way, so say
  // plainly when it is not spendable rather than letting it read as funds (#839).
  const integrity = checkWalletIntegrity(wallet, await stellarDerivePublicKey());
  const ownsAddress = integrity.ok;

  const lines = [
    `Profile: ${activeProfileName}`,
    `Address: ${wallet.publicKey}`,
    `XLM Balance: ${details.xlmBalance}`,
    `XLM Reserved: ${details.xlmReserve} (base + subentries)`,
    `XLM Available: ${details.xlmAvailable}`,
    `USDC Balance: ${details.usdcBalance}`,
    `USDC Status: ${details.status}`,
    `Publisher registered: ${publisherRegistered ? "yes" : "no"}`,
  ];

  if (!ownsAddress) {
    lines.push(`⚠ Keystore: ${unownedWalletNote(integrity)}`);
  }

  if (details.message) {
    lines.push(`Note: ${details.message}`);
  }

  return {
    text: lines.join("\n"),
    structured: {
      profile: activeProfileName,
      address: wallet.publicKey,
      xlmBalance: details.xlmBalance,
      xlmReserve: details.xlmReserve,
      xlmAvailable: details.xlmAvailable,
      usdcBalance: details.usdcBalance,
      usdcStatus: details.status,
      publisherRegistered,
      /** False when the stored secret does not derive this address (#839). */
      ownsAddress,
      note: details.message ?? null,
    },
  };
}

export async function walletInfo(): Promise<string> {
  return outcomeText(await walletInfoOutcome());
}

// ── Wallet balances (#889) ───────────────────────────────────────────────────

const STELLAR_PUBLIC_KEY_PATTERN = /^G[A-Z2-7]{55}$/;

interface WalletBalanceRow {
  profile?: string;
  active?: boolean;
  publisherRegistered?: boolean;
  address: string;
  details: BalanceDetails | null;
  note: string | null;
}

async function loadBalanceRow(input: {
  address: string;
  profile?: string;
  active?: boolean;
  publisherRegistered?: boolean;
}): Promise<WalletBalanceRow> {
  if (!input.address || !STELLAR_PUBLIC_KEY_PATTERN.test(input.address)) {
    return {
      ...input,
      address: input.address,
      details: null,
      note: "Address does not look like a Stellar public key (G…, 56 chars).",
    };
  }
  try {
    return {
      ...input,
      address: input.address,
      details: await getBalanceDetails(input.address),
      note: null,
    };
  } catch (err) {
    return {
      ...input,
      address: input.address,
      details: null,
      note: `Balance lookup failed: ${safeErrorMessage(err)}`,
    };
  }
}

function trimDecimalZeros(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

function sumBalances(values: string[]): string {
  const total = values.reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
  return trimDecimalZeros(total.toFixed(7));
}

function balanceRowStructured(row: WalletBalanceRow): Record<string, unknown> {
  return {
    profile: row.profile ?? null,
    address: row.address,
    active: row.active ?? null,
    publisherRegistered: row.publisherRegistered ?? null,
    xlmBalance: row.details?.xlmBalance ?? null,
    xlmReserve: row.details?.xlmReserve ?? null,
    xlmAvailable: row.details?.xlmAvailable ?? null,
    usdcBalance: row.details?.usdcBalance ?? null,
    usdcStatus: row.details?.status ?? null,
    note: row.note,
  };
}

/**
 * Balances for every agent wallet plus the platform wallet (from
 * PLATFORM_WALLET_ADDRESS, when configured). One wallet failing to load does
 * not fail the tool: its row carries a note and the rest of the list stands.
 */
async function walletBalancesOutcome(): Promise<ToolOutcome> {
  const agentNames = Object.entries(profiles)
    .filter(([, profile]) => !!profile.wallet?.publicKey)
    .map(([name]) => name)
    .sort();

  const agents = await Promise.all(
    agentNames.map((name) =>
      loadBalanceRow({
        address: profiles[name].wallet?.publicKey ?? "",
        profile: name,
        active: name === activeProfileName,
        publisherRegistered: profiles[name].apiKey != null,
      }),
    ),
  );

  const platformAddress = PLATFORM_WALLET_ADDRESS?.trim() || null;
  const platform = platformAddress ? await loadBalanceRow({ address: platformAddress }) : null;

  const usdcTotal = sumBalances(
    [...agents, ...(platform ? [platform] : [])]
      .filter((row) => row.details?.usdcBalance)
      .map((row) => row.details!.usdcBalance),
  );
  const xlmTotal = sumBalances(
    [...agents, ...(platform ? [platform] : [])]
      .filter((row) => row.details?.xlmBalance)
      .map((row) => row.details!.xlmBalance),
  );

  const lines: Array<string | null> = ["Wallet balances", `Horizon: ${HORIZON_URL}`];

  if (platform) {
    const d = platform.details;
    lines.push(
      `Platform (PLATFORM_WALLET_ADDRESS): ${platform.address}`,
      d
        ? `  XLM ${d.xlmBalance} (available ${d.xlmAvailable}) · USDC ${d.usdcBalance} (${d.status})`
        : `  ${platform.note ?? "unavailable"}`,
    );
  } else {
    lines.push("Platform wallet: not configured (set PLATFORM_WALLET_ADDRESS).");
  }

  lines.push(
    agents.length > 0 ? `Agent wallets (${agents.length}):` : "Agent wallets: none configured.",
  );
  for (const row of agents) {
    const active = row.active ? " [active]" : "";
    if (row.details) {
      lines.push(
        `  - ${row.profile}${active}: ${row.address}`,
        `      XLM ${row.details.xlmBalance} (available ${row.details.xlmAvailable}) · USDC ${row.details.usdcBalance} (${row.details.status})`,
        row.note ? `      Note: ${row.note}` : null,
      );
    } else {
      lines.push(`  - ${row.profile}${active}: ${row.address} — ${row.note ?? "unavailable"}`);
    }
  }
  lines.push(`Totals (unique wallets): USDC ${usdcTotal} · XLM ${xlmTotal}`);
  lines.push(
    "Publisher payout target on the server is PAY_TO; this list mirrors the agent wallets and PLATFORM_WALLET_ADDRESS.",
  );

  return {
    text: lines.filter((line) => line !== null).join("\n"),
    structured: {
      source: "horizon",
      requestedAt: new Date().toISOString(),
      platform: platform
        ? {
            configured: true,
            ...balanceRowStructured(platform),
          }
        : null,
      agents: agents.map((row) => balanceRowStructured(row)),
      count: agents.length,
      statistics: { totalUsdc: usdcTotal, totalXlm: xlmTotal },
      message:
        agents.length > 0
          ? `Listed ${agents.length} agent wallet(s).`
          : "No agent wallets configured.",
    },
  };
}

// ── Server endpoints (#890) ──────────────────────────────────────────────────

const HTTP_METHOD_ORDER = ["get", "post", "put", "patch", "delete"];

function methodIndex(method: string): number {
  const index = HTTP_METHOD_ORDER.indexOf(method);
  return index === -1 ? HTTP_METHOD_ORDER.length : index;
}

/**
 * Surface the ZentrixPay HTTP API's endpoints from its published OpenAPI spec
 * (`${BASE_URL}/openapi.json`), so an agent can discover what the server
 * exposes without guessing paths. Read-only and network-only.
 */
async function serverEndpointsOutcome(): Promise<ToolOutcome> {
  const res = await jsonFetch(`${BASE_URL}/openapi.json`);
  if (!res.ok)
    throwHttpError({
      operation: "OpenAPI spec fetch failed",
      source: "api",
      status: res.status,
      data: res.data,
    });
  const spec =
    res.data && typeof res.data === "object" && !Array.isArray(res.data)
      ? (res.data as Record<string, any>)
      : null;
  const paths =
    spec?.paths && typeof spec.paths === "object" ? (spec.paths as Record<string, any>) : {};

  const operations: Array<{
    method: string;
    path: string;
    operationId: string | null;
    tags: string[];
    summary: string | null;
  }> = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object") continue;
    for (const [method, op] of Object.entries(item as Record<string, unknown>)) {
      if (typeof op !== "object" || op === null) continue;
      const operation = op as Record<string, unknown>;
      operations.push({
        method: method.toUpperCase(),
        path,
        operationId: typeof operation.operationId === "string" ? operation.operationId : null,
        tags: Array.isArray(operation.tags)
          ? (operation.tags as unknown[]).filter((tag): tag is string => typeof tag === "string")
          : [],
        summary: typeof operation.summary === "string" ? operation.summary : null,
      });
    }
  }
  operations.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      methodIndex(a.method.toLowerCase()) - methodIndex(b.method.toLowerCase()),
  );

  const info =
    spec && typeof spec.info === "object" ? (spec.info as Record<string, unknown>) : null;
  const serverName = info && typeof info.title === "string" ? info.title : null;
  const openapiVersion =
    typeof spec?.openapi === "string"
      ? spec.openapi
      : typeof spec?.swagger === "string"
        ? spec.swagger
        : null;

  const uniquePaths = [...new Set(operations.map((op) => op.path))].sort((a, b) =>
    a.localeCompare(b),
  );

  return {
    text: [
      "Server endpoints",
      `Base URL: ${BASE_URL}`,
      `Source: OpenAPI spec (${openapiVersion ?? "unknown"})${serverName ? ` — ${serverName}` : ""}`,
      `Endpoints: ${operations.length}`,
      ...operations.map((op) => {
        const id = op.operationId ? ` (${op.operationId})` : "";
        const summary = op.summary ? ` — ${op.summary}` : "";
        const tags = op.tags.length > 0 ? ` [${op.tags.join(", ")}]` : "";
        return `  ${op.method.padEnd(6)} ${op.path}${tags}${id}${summary}`;
      }),
      operations.length === 0 ? "No parseable operations found in the published spec." : null,
      "Reflects the deployment configured by ZENTRIXPAY_URL; for discovery only.",
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
    structured: {
      source: "openapi",
      baseUrl: BASE_URL,
      openapi: openapiVersion,
      server: info,
      endpointCount: operations.length,
      operations,
      paths: uniquePaths,
      message:
        operations.length > 0
          ? `Discovered ${operations.length} endpoint(s) across ${uniquePaths.length} path(s) from ${BASE_URL}/openapi.json.`
          : "No operations could be parsed from the published OpenAPI spec.",
    },
  };
}

/** Switch the active profile, creating it if new. */
function useProfileOutcome(nameArg: string): ToolOutcome {
  if (!isValidProfileName(nameArg)) {
    throw new Error(
      `Invalid profile name. Use 1–64 characters from letters, digits, dot, dash, or underscore.`,
    );
  }
  activeProfileName = nameArg;
  const profile = activeProfile();
  saveState();
  if (profile.wallet) {
    return {
      text: [
        `Active profile: ${nameArg}`,
        `Address: ${profile.wallet.publicKey}`,
        `Publisher registered: ${profile.apiKey ? "yes" : "no"}`,
      ].join("\n"),
      structured: {
        profile: nameArg,
        address: profile.wallet.publicKey,
        publisherRegistered: !!profile.apiKey,
      },
    };
  }
  return {
    text: `Active profile: ${nameArg}\nNo wallet in this profile yet. Run zentrixpay_setup_wallet to create one.`,
    structured: { profile: nameArg, address: null, publisherRegistered: null },
  };
}

export function useProfile(nameArg: string): string {
  return outcomeText(useProfileOutcome(nameArg));
}

export function switchNetworkProfile(name: string, network: "testnet" | "mainnet"): string {
  if (!isValidProfileName(name)) throw new Error("Invalid profile name.");
  activeProfileName = name;
  activeProfile().network = network;
  applyNetworkConfig(network);
  saveState();
  const verification = verifyInstall({ ...process.env, STELLAR_NETWORK: network });
  return JSON.stringify(
    { profile: name, network, verification: { ok: verification.ok, checks: verification.checks } },
    null,
    2,
  );
}

/** List every named profile, marking the active one. Secrets are never shown. */
function listProfilesOutcome(): ToolOutcome {
  const names = Object.keys(profiles).sort();
  const structured = {
    active: activeProfileName,
    profiles: names.map((name) => ({
      name,
      address: profiles[name].wallet ? profiles[name].wallet!.publicKey : null,
      publisherRegistered: !!profiles[name].apiKey,
      active: name === activeProfileName,
    })),
  };
  if (names.length === 0) {
    return {
      text: `No profiles yet. Run zentrixpay_setup_wallet to create one (default profile: "${DEFAULT_PROFILE}").`,
      structured,
    };
  }
  const lines = names.map((name) => {
    const profile = profiles[name];
    const marker = name === activeProfileName ? "*" : " ";
    const address = profile.wallet ? profile.wallet.publicKey : "(no wallet)";
    const registered = profile.apiKey ? ", registered" : "";
    return `${marker} ${name} — ${address}${registered}`;
  });
  return { text: [`Profiles (* = active):`, ...lines].join("\n"), structured };
}

export function listProfiles(): string {
  return outcomeText(listProfilesOutcome());
}

async function register(name: string, email: string, walletAddress?: string): Promise<string> {
  const wallet = requireWallet();
  const res = await jsonFetch(`${BASE_URL}/publishers`, {
    method: "POST",
    body: JSON.stringify({ name, email, walletAddress: walletAddress ?? wallet.publicKey }),
  });
  if (!res.ok)
    throwHttpError({
      operation: "Register failed",
      source: "api",
      status: res.status,
      data: res.data,
    });
  activeProfile().apiKey = res.data.apiKey;
  saveState();
  return `Registered as publisher.\nProfile: ${activeProfileName}\nID: ${res.data.id}\nAPI key persisted to ${STATE_FILE} (not shown). Run zentrixpay_reset to revoke.`;
}

/**
 * Decimal USDC for an on-chain stroop amount, throwing on an amount the shared
 * converter will not accept. The registry contract takes stroops, so a price
 * that cannot be expressed exactly must stop here rather than be rounded into
 * a transaction (#838).
 */
export function usdcToStroops(usdc: string): bigint {
  const stroops = toStroops(usdc);
  if (stroops === null) {
    throw new Error(
      `Invalid USDC amount "${usdc}". Use a non-negative decimal with at most 7 decimal places, e.g. "5.00".`,
    );
  }
  return stroops;
}

/**
 * Report the current Stellar and x402 network configuration in use by this MCP
 * instance. Includes testnet/mainnet selection, RPC/Horizon URLs, registry and
 * USDC contract IDs, and warnings for environment variable overrides that
 * diverge from presets.
 */
export function networkProfile(): string {
  const warnings: string[] = [];

  const usdcContractId = process.env.USDC_CONTRACT_ID ?? networkPreset.usdcSacContractId;
  if (
    process.env.USDC_CONTRACT_ID &&
    process.env.USDC_CONTRACT_ID !== networkPreset.usdcSacContractId
  ) {
    warnings.push(
      `USDC_CONTRACT_ID overrides preset (${networkPreset.usdcSacContractId} → ${process.env.USDC_CONTRACT_ID})`,
    );
  }
  if (process.env.SOROBAN_RPC_URL && process.env.SOROBAN_RPC_URL !== networkPreset.sorobanRpcUrl) {
    warnings.push(
      `SOROBAN_RPC_URL overrides preset (${networkPreset.sorobanRpcUrl} → ${process.env.SOROBAN_RPC_URL})`,
    );
  }
  if (process.env.HORIZON_URL && process.env.HORIZON_URL !== networkPreset.horizonUrl) {
    warnings.push(
      `HORIZON_URL overrides preset (${networkPreset.horizonUrl} → ${process.env.HORIZON_URL})`,
    );
  }
  if (
    process.env.VAULT_REGISTRY_CONTRACT_ID &&
    networkPreset.defaultRegistryContractId &&
    process.env.VAULT_REGISTRY_CONTRACT_ID !== networkPreset.defaultRegistryContractId
  ) {
    warnings.push(
      `VAULT_REGISTRY_CONTRACT_ID overrides preset (${networkPreset.defaultRegistryContractId} → ${process.env.VAULT_REGISTRY_CONTRACT_ID})`,
    );
  }
  if (process.env.NETWORK && process.env.NETWORK !== networkPreset.x402Network) {
    warnings.push(
      `NETWORK overrides preset (${networkPreset.x402Network} → ${process.env.NETWORK})`,
    );
  }

  const profile = {
    stellarNetwork: STELLAR_NETWORK,
    x402Network: NETWORK,
    sorobanRpcUrl: SOROBAN_RPC_URL,
    horizonUrl: HORIZON_URL,
    registryContractId: REGISTRY_CONTRACT_ID,
    usdcContractId,
    timeouts: describeTimeouts(TIMEOUTS),
    retries: describeRetryPolicy(RETRY_POLICY),
    warnings,
  };

  return JSON.stringify(profile, null, 2);
}

// ── #883: Client config emitter ──────────────────────────────────────────────
// docs/mcp-client-configs.md documents copy-paste configs per client with a
// placeholder path and testnet defaults. This mirrors that content
// programmatically, pre-filled with this running process's actual entrypoint
// path and whichever environment values were actually detected (so an agent
// already connected to one client can generate the config for another without
// hand-editing placeholders).

type ClientConfigId = "claude-code" | "claude-desktop" | "codex" | "cursor" | "vscode" | "windsurf";

const CLIENT_CONFIG_PROFILES: Record<
  ClientConfigId,
  { label: string; format: "json" | "toml"; topLevelKey: "mcpServers" | "servers" }
> = {
  "claude-code": { label: "Claude Code (.mcp.json)", format: "json", topLevelKey: "mcpServers" },
  "claude-desktop": {
    label: "Claude Desktop (claude_desktop_config.json)",
    format: "json",
    topLevelKey: "mcpServers",
  },
  codex: { label: "Codex (~/.codex/config.toml)", format: "toml", topLevelKey: "mcpServers" },
  cursor: { label: "Cursor (.cursor/mcp.json)", format: "json", topLevelKey: "mcpServers" },
  vscode: { label: "VS Code (.vscode/mcp.json)", format: "json", topLevelKey: "servers" },
  windsurf: {
    label: "Windsurf (~/.codeium/windsurf/mcp_config.json)",
    format: "json",
    topLevelKey: "mcpServers",
  },
};

/**
 * The path this server was actually launched with, when it looks like a real
 * built entrypoint (ends in mcp/dist/index.js). Falls back to the same
 * placeholder the docs use when running under a dev/test harness (tsx,
 * vitest), where process.argv[1] isn't a useful path to hand back to a client.
 */
function detectEntrypointPath(): string {
  const argv1 = process.argv[1];
  if (argv1 && /mcp[\\/]dist[\\/]index\.js$/.test(argv1)) return argv1;
  return "/absolute/path/to/zentrixpay/mcp/dist/index.js";
}

/** Non-default environment values worth carrying into a generated config. */
function detectConfigEnv(): Record<string, string> {
  const env: Record<string, string> = { STELLAR_NETWORK };
  const passthrough = [
    "ZENTRIXPAY_URL",
    "SPONSORED_ACCOUNT_URL",
    "SOROBAN_RPC_URL",
    "HORIZON_URL",
    "USDC_CONTRACT_ID",
    "VAULT_REGISTRY_CONTRACT_ID",
    "ZENTRIXPAY_ALLOW_MAINNET",
  ] as const;
  for (const key of passthrough) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

function buildClientConfigSnippet(
  clientId: ClientConfigId,
  entrypoint: string,
  env: Record<string, string>,
): string {
  const profile = CLIENT_CONFIG_PROFILES[clientId];
  const serverName = env.STELLAR_NETWORK === "mainnet" ? "zentrixpay-mainnet" : "zentrixpay";

  if (profile.format === "toml") {
    const lines = [`[mcp_servers.${serverName}]`, `command = "node"`, `args = ["${entrypoint}"]`];
    if (Object.keys(env).length > 0) {
      lines.push("", `[mcp_servers.${serverName}.env]`);
      for (const [key, value] of Object.entries(env)) lines.push(`${key} = "${value}"`);
    }
    return lines.join("\n");
  }

  const body: Record<string, unknown> = {
    ...(clientId === "vscode" ? { type: "stdio" } : {}),
    command: "node",
    args: [entrypoint],
    env,
  };
  return JSON.stringify({ [profile.topLevelKey]: { [serverName]: body } }, null, 2);
}

/**
 * Emit a copy-paste MCP client config for one client (or every supported
 * client when omitted), using this server's detected entrypoint path and
 * network profile instead of the placeholders in docs/mcp-client-configs.md.
 */
export function clientConfig(client?: string): string {
  const entrypoint = detectEntrypointPath();
  const env = detectConfigEnv();

  if (client !== undefined) {
    if (!(client in CLIENT_CONFIG_PROFILES)) {
      const known = Object.keys(CLIENT_CONFIG_PROFILES).join(", ");
      throw new Error(`Unknown client "${client}". Supported clients: ${known}.`);
    }
    const id = client as ClientConfigId;
    const fence = CLIENT_CONFIG_PROFILES[id].format;
    return [
      `## ${CLIENT_CONFIG_PROFILES[id].label}`,
      "",
      "```" + fence,
      buildClientConfigSnippet(id, entrypoint, env),
      "```",
    ].join("\n");
  }

  const sections = (Object.keys(CLIENT_CONFIG_PROFILES) as ClientConfigId[]).map((id) => {
    const fence = CLIENT_CONFIG_PROFILES[id].format;
    return [
      `## ${CLIENT_CONFIG_PROFILES[id].label}`,
      "",
      "```" + fence,
      buildClientConfigSnippet(id, entrypoint, env),
      "```",
    ].join("\n");
  });
  return sections.join("\n\n");
}

/**
 * Return opt-in tool-level metrics in the requested export format (json or
 * otlp). Pass reset=true to clear counters after reading. Text-only when
 * disabled (still JSON so structuredContent works).
 */
function toolMetrics(reset: boolean, format: MetricsExportFormat): string {
  const snapshot = metrics.snapshot();
  if (reset) metrics.reset();
  if (!snapshot.enabled) {
    return JSON.stringify(
      {
        enabled: false,
        message:
          "Metrics are disabled. Set ZENTRIXPAY_METRICS=1 (or true/yes/on) and restart the server to collect tool-level metrics.",
      },
      null,
      2,
    );
  }
  return serializeMetricsExport(snapshot, format);
}

const SELF_VALIDATING_TOOLS = new Set(TOOLS_WITHOUT_ARG_VALIDATION);

function isDispatchableTool(name: string): boolean {
  return name in TOOL_ARGUMENT_SPECS || SELF_VALIDATING_TOOLS.has(name) || API_TOOL_NAMES.has(name);
}

// Pay-per-call API tools live in apiTools.ts; they receive the wallet, paid
// fetch and HTTP plumbing from here rather than importing this module.
const handleApiTool = createApiToolHandler({
  baseUrl: () => BASE_URL,
  network: () => NETWORK,
  jsonFetch,
  requireApiKey,
  requireWallet,
  paidFetch: (wallet) => makePaidFetch(wallet as AgentWallet),
  assertWithinCeiling: (price, maxAutoPayUsdc) =>
    assertAutoPaymentWithinCeiling({ price, maxAutoPayUsdc }),
  insufficientFundsMessage: (wallet, amount, action) =>
    insufficientFundsMessage(wallet as AgentWallet, amount, action),
  recordPurchase,
});

const STATE_MUTATING_TOOLS = new Set([
  "zentrixpay_setup_wallet",
  "zentrixpay_repair_sponsored_account",
  "zentrixpay_use_profile",
  "zentrixpay_switch_network_profile",
  "zentrixpay_register",
  "zentrixpay_reset",
  "zentrixpay_restore_state",
  "zentrixpay_import_wallet",
  "zentrixpay_rotate_publisher_key",
  "zentrixpay_metrics",
]);

const stateMutex = new Mutex();

async function dispatchToolOutcome(
  name: string,
  rawArgs: unknown,
  onProgress?: (progress: number, total?: number, message?: string) => Promise<void>,
): Promise<ToolOutcome> {
  if (!isDispatchableTool(name)) {
    throw new UnknownToolError(name);
  }

  // Read-only mode is checked before argument validation (#593): when the
  // server cannot run this tool at all, a malformed-arguments error would be
  // a misleading thing to report, and the refusal does not depend on the
  // arguments being well-formed.
  assertToolAllowedInReadOnlyMode(name, process.env);

  const rawRecord =
    typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};

  const isDryRunCall =
    name === "zentrixpay_call" && rawRecord.dryRun === true;

  const args: ValidatedArgs =
    name in TOOL_ARGUMENT_SPECS && !isDryRunCall ? validateToolArgs(name, rawArgs) : {};

  assertMainnetMutationAllowed(NETWORK, name, rawRecord);

  // Network-independent spend confirmation (#594). Distinct from the mainnet
  // guardrail above (which only fires on pubnet) and from the auto-pay ceiling
  // in buy() (which only fires above an amount); a call may have to satisfy
  // all three. Off unless ZENTRIXPAY_CONFIRM_PAID_OPERATIONS says otherwise.
  assertPaidOperationConfirmed({
    toolName: name,
    args: rawRecord,
    dryRun: isDryRunCall,
    env: process.env,
  });

  if (API_MUTATION_TOOLS.has(name) && !isDryRunCall) {
    await assertApiReachableFor(name);
  }

  const execute = async (): Promise<ToolOutcome> => {
    if (API_TOOL_NAMES.has(name)) return handleApiTool(name, rawRecord);
    switch (name) {
      case "zentrixpay_setup_wallet":
        return setupWallet(optionalString(args, "profile"));
      case "zentrixpay_repair_sponsored_account":
        return repairSponsoredAccount(
          requiredString(args, "secretKey"),
          optionalString(args, "profile"),
        );
      case "zentrixpay_wallet_info":
        return walletInfoOutcome();
      case "zentrixpay_use_profile":
        return useProfileOutcome(requiredString(args, "name"));
      case "zentrixpay_switch_network_profile":
        return switchNetworkProfile(
          requiredString(args, "name"),
          requiredString(args, "network") as "testnet" | "mainnet",
        );
      case "zentrixpay_list_profiles":
        return listProfilesOutcome();
      case "zentrixpay_register":
        return register(
          requiredString(args, "name"),
          requiredString(args, "email"),
          optionalString(args, "walletAddress"),
        );
      case "zentrixpay_purchase_history":
        return purchaseHistoryTool(rawRecord);
      case "zentrixpay_export_receipts":
        return exportReceiptsToolWithTimeout(
          rawRecord,
          timeoutForTool("zentrixpay_export_receipts", "http", TIMEOUTS, TOOL_TIMEOUTS),
        );
      case "zentrixpay_network_profile":
        return networkProfile();
      case "zentrixpay_tx_status":
        return txStatus(requiredString(args, "txHash"));
      case "zentrixpay_reset":
        return resetState(flag(args, "all"), rawRecord.confirm);
      case "zentrixpay_backup_state":
        return backupState(requiredString(args, "passphrase"), rawRecord.confirm);
      case "zentrixpay_restore_state":
        return restoreStateTool(requiredString(args, "blob"), requiredString(args, "passphrase"));
      case "zentrixpay_metrics":
        return toolMetrics(flag(args, "reset"), normalizeMetricsExportFormat(args.format));
      case "zentrixpay_check_state_permissions":
        return checkStatePermissionsTool();
      case "zentrixpay_client_config":
        return clientConfig(optionalString(args, "client"));
      case "zentrixpay_mainnet_banner":
        return mainnetBanner();
      case "zentrixpay_import_wallet":
        return importWallet({
          secretKey: optionalString(args, "secretKey"),
          profile: optionalString(args, "profile"),
          persist: flag(args, "persist"),
        });
      case "zentrixpay_rotate_publisher_key":
        return rotatePublisherKey(optionalString(args, "profile"));
      case "zentrixpay_verify_install":
        return formatVerifyInstall(verifyInstall(process.env));
      case "zentrixpay_debug_bundle":
        return debugBundleTool(rawRecord);
      case "zentrixpay_wallet_balances":
        return walletBalancesOutcome();
      case "zentrixpay_server_endpoints":
        return serverEndpointsOutcome();
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };

  if (STATE_MUTATING_TOOLS.has(name)) {
    return stateMutex.runExclusive(execute);
  }
  return execute();
}

/** Dispatch a tool and return the human-readable text block (unit-test surface). */
export async function dispatchTool(
  name: string,
  rawArgs: unknown,
  onProgress?: (progress: number, total?: number, message?: string) => Promise<void>,
): Promise<string> {
  return outcomeText(await dispatchToolOutcome(name, rawArgs, onProgress));
}

/** Test helper: wrap a handler outcome the same way CallTool does. */
export function normalizeToolResultForTest(name: string, outcome: ToolOutcome) {
  return normalizeToolResult(name, outcome, hasOutputSchema);
}

const server = new Server(
  { name: "zentrixpay", version: "1.0.0" },
  { capabilities: { tools: {}, prompts: {} } },
);

// ListTools is derived from TOOL_DEFINITIONS rather than restated here (#596).
// The handler used to carry its own copy of the whole list, which had drifted
// from tools.ts in both directions — six implemented tools were undiscoverable,
// two advertised tools were missing from the generated docs, and several
// schemas had lost their field descriptions and optional arguments.
// `listToolsContract.test.ts` checks this response against the definitions, the
// argument validator, and the dispatch switch on every run.
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: advertisedTools(process.env),
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args = {} } = request.params;
  const progressToken = request.params._meta?.progressToken;
  // Settled in `finally`, before the result is returned, so every progress
  // notification for this call goes out ahead of it and none after (#841).
  const progress =
    progressToken != null
      ? scopeProgressToRequest(
          createProgressEmitter({ token: progressToken, send: extra.sendNotification }),
        )
      : undefined;
  try {
    const result = await measureTool(metrics, name, () =>
      dispatchToolOutcome(name, args, progress?.emit),
    );
    // Opt-in structured telemetry stream (#891): one OTLP line to stderr per
    // tool call when ZENTRIXPAY_METRICS_EXPORT_CONSOLE is set, so a log
    // collector or otel-collector can tail the export without touching stdout.
    if (metricsExportToConsoleEnabled(process.env) && metrics.enabled) {
      console.error(metricsExportLine(metrics.snapshot(), "otlp"));
    }
    return normalizeToolResult(name, result, hasOutputSchema);
  } catch (err: any) {
    const mapped = mappedErrorOf(err);
    return {
      content: [{ type: "text", text: `Error: ${safeErrorMessage(err)}` }],
      isError: true,
      ...(mapped ? { structuredContent: { troubleshooting: troubleshootingHint(mapped) } } : {}),
    };
  } finally {
    await progress?.settle();
  }
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: PROMPT_DEFINITIONS.map((p) => ({
    name: p.name,
    description: p.description,
    arguments: p.arguments.map((a) => ({
      name: a.name,
      description: a.description,
      required: a.required,
    })),
  })),
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const result = getPrompt(name, args as Record<string, string | undefined>);
  return {
    description: result.description,
    messages: result.messages,
  };
});

if (!process.env.VITEST && !MOCK) {
  void checkContractBindings({
    contractId: REGISTRY_CONTRACT_ID,
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
    network: STELLAR_NETWORK,
  })
    .then((result: { status: string; message: string }) => {
      if (result.status === "mismatch") logger.warn(`ZentrixPay MCP: ${result.message}`);
    })
    .catch(() => {});
}

export { server };

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    saveState();
    await server.close();
  } catch {
    void 0;
  }

  const exitCode = signal === "SIGINT" ? 130 : 0;
  process.exit(exitCode);
}

if (!process.env.VITEST) {
  const transport = new StdioServerTransport();

  transport.onclose = () => shutdown("transport-close");
  transport.onerror = () => shutdown("transport-error");

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.stdin.on("end", () => shutdown("stdin-EOF"));

  await server.connect(transport);
}
