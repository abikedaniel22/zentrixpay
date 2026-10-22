/**
 * MCP tool definitions for the ZentrixPay server.
 *
 * This array is the single source of truth for the tool surface advertised to
 * agent clients (ListTools). It lives outside index.ts so tests and the
 * argument-validation layer can import it without booting the server or its
 * stdio transport. Every tool listed here must have a matching entry in
 * TOOL_ARGUMENT_SPECS (see validation.ts) — enforced by validation.test.ts.
 *
 * `toolSurface.ts` turns this array into the ListTools payload, and
 * `listToolsContract.test.ts` checks the live response against it along with
 * the argument validator and the dispatch switch. Until #596 the handler in
 * index.ts kept its own copy of this list and the two had drifted apart in
 * both directions; the contract test exists so that cannot recur silently.
 */

import { API_TOOL_DEFINITIONS } from "./apiTools.js";

import {
  LIST_PROFILES_OUTPUT_SCHEMA,
  METRICS_OUTPUT_SCHEMA,
  NETWORK_PROFILE_OUTPUT_SCHEMA,
  PURCHASE_HISTORY_OUTPUT_SCHEMA,
  TX_STATUS_OUTPUT_SCHEMA,
  USE_PROFILE_OUTPUT_SCHEMA,
  WALLET_INFO_OUTPUT_SCHEMA,
  WALLET_SETUP_OUTPUT_SCHEMA,
} from "./outputSchemas.js";
import { RECEIPT_EXPORT_MAX_LIMIT, RECEIPT_EXPORT_OUTPUT_SCHEMA } from "./receipts.js";
import {
  DEBUG_BUNDLE_DEFAULT_AUDIT_LINES,
  DEBUG_BUNDLE_MAX_AUDIT_LINES,
  DEBUG_BUNDLE_OUTPUT_SCHEMA,
} from "./debugBundleSchema.js";

/**
 * The `confirmPaid` argument advertised by every tool the paid-operation policy
 * can gate (#594).
 *
 * Declared once and spread into each schema so the wording an agent reads can
 * never drift between two tools that answer to the same guardrail.
 */
const CONFIRM_PAID_PROPERTY = {
  type: "boolean",
  description:
    "Required when the server runs with ZENTRIXPAY_CONFIRM_PAID_OPERATIONS=usdc or =all. Explicitly confirm that this call may spend from the agent wallet. Ignored when the policy is off (the default) and on dry runs.",
} as const;

/** JSON Schema (draft subset) advertised for a tool's arguments. */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required: string[];
}

/**
 * MCP tool annotations (2025-06-18). These are advisory **hints** only — clients
 * never gate tool use on them, but they let agents know which calls are safe to
 * repeat and which can destroy local state.
 */
export interface ToolAnnotations {
  /** Human-readable title shown next to the tool in client UIs. */
  title: string;
  /** The tool performs no state changes or side effects. */
  readOnlyHint: boolean;
  /** The tool can irreversibly destroy local state. */
  destructiveHint: boolean;
  /** Repeating the tool with identical arguments is safe and yields the same result. */
  idempotentHint: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  /**
   * Optional JSON Schema for the tool's structured result. Tools that declare
   * one return their result as `structuredContent` as well as text, and MUST
   * conform to it (MCP 2025-06-18, "Structured Content").
   */
  outputSchema?: Record<string, unknown>;
  /** MCP tool annotations advertised in ListTools (title + read/destructive/idempotent hints). */
  annotations: ToolAnnotations;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  ...API_TOOL_DEFINITIONS,
  {
    name: "zentrixpay_setup_wallet",
    description:
      "Create a Stellar wallet using the sponsored account protocol. Optionally pass a profile name to create the wallet under a named profile (e.g. testnet, mainnet, publisher, buyer) and make it active; defaults to the active profile. The wallet (public key + secret key) is persisted to ~/.zentrixpay/state.json (mode 0600) and reloaded automatically on restart.",
    inputSchema: {
      type: "object",
      properties: {
        profile: {
          type: "string",
          description:
            "Optional profile name to create/switch to. Use letters, digits, dot, dash, or underscore (1–64 chars). Examples: 'testnet', 'mainnet-publisher', 'buyer.alice'",
          examples: ["testnet", "mainnet-publisher", "buyer.alice"],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set ZENTRIXPAY_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
        },
      },
      required: [],
    },
    outputSchema: WALLET_SETUP_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Set Up Wallet",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "zentrixpay_wallet_info",
    description:
      "Check the active profile name, its agent wallet address, USDC balance, and whether it is registered as a publisher.",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: WALLET_INFO_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Wallet Info",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "zentrixpay_repair_sponsored_account",
    description:
      "Repair a half-created sponsored account. Derives the address from a recovered secret key, re-fetches its Horizon balances, and restores the wallet to a local profile only when the on-chain account exists. The secret is never returned.",
    inputSchema: {
      type: "object",
      properties: {
        secretKey: {
          type: "string",
          description: "The recovered Stellar secret key returned during the interrupted setup.",
        },
        profile: {
          type: "string",
          description: "Optional profile to repair; defaults to the active profile.",
          examples: ["default", "publisher"],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set ZENTRIXPAY_ALLOW_MAINNET=1). Explicitly confirm restoring credentials for the public Stellar network.",
        },
      },
      required: ["secretKey"],
    },
    annotations: {
      title: "Repair Sponsored Account",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "zentrixpay_use_profile",
    description:
      "Switch the active wallet profile, creating it if it does not exist. Profiles let one agent keep separate identities (e.g. testnet vs mainnet, publisher vs buyer); each has its own wallet and publisher API key. Subsequent tools operate on the active profile.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Profile name to make active. Use letters, digits, dot, dash, or underscore (1–64 chars). Examples: 'mainnet', 'testnet-buyer', 'publisher.bob'",
          examples: ["mainnet", "testnet-buyer", "publisher.bob"],
        },
      },
      required: ["name"],
    },
    outputSchema: USE_PROFILE_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Use Profile",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "zentrixpay_list_profiles",
    description:
      "List all named wallet profiles, marking the active one and showing each profile's wallet address and whether it is registered as a publisher. Secret keys are never shown.",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: LIST_PROFILES_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "List Profiles",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "zentrixpay_switch_network_profile",
    description:
      "Switch the active wallet profile and Stellar network together, then re-run install verification for the selected network.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Profile name to activate." },
        network: {
          type: "string",
          enum: ["testnet", "mainnet"],
          description: "Stellar network for this profile.",
        },
      },
      required: ["name", "network"],
    },
    annotations: {
      title: "Switch Network Profile",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "zentrixpay_register",
    description:
      "Register as a publisher using the agent wallet. The API key is persisted to ~/.zentrixpay/state.json (mode 0600, key not shown in output) and reloaded on restart so zentrixpay_publish works across sessions.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Publisher display name shown in the catalog (1–128 characters).",
          examples: ["Agent A", "Research Bot"],
        },
        email: {
          type: "string",
          description:
            "Contact email for the publisher record. Must be a valid address (max 254 chars).",
          examples: ["agent-a@example.com"],
        },
        walletAddress: {
          type: "string",
          description:
            "Optional Stellar public key to receive payouts (G… , 56 chars). Defaults to the active profile's agent wallet.",
          examples: ["GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH"],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set ZENTRIXPAY_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
        },
      },
      required: ["name", "email"],
    },
    annotations: {
      title: "Register Publisher",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "zentrixpay_export_receipts",
    description:
      "Export receipts for resources this agent has purchased as a schema-versioned document (JSON, RFC 4180 CSV in the envelope's csv field, or Newline-Delimited JSON in the envelope's ndjson field). Filter by resource, network, and date range. Reports a row count and the summed USDC total, so an agent can reconcile spend without re-reading each purchase.",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["json", "csv", "ndjson"],
          description:
            'Output format. "json" (default) returns the receipts array; "csv" additionally renders the same rows as an RFC 4180 document in the envelope\'s csv field; "ndjson" renders each row as a JSON object on its own line in the envelope\'s ndjson field.',
          examples: ["json", "csv", "ndjson"],
        },
        resourceId: {
          type: "string",
          description: "Export only receipts for this resource id.",
          examples: ["cm7x8y9z", "swcn98besxpp6t1u8e77fqz3"],
        },
        network: {
          type: "string",
          description:
            "Export only receipts settled on this x402 network id. Example: 'stellar:testnet'.",
          examples: ["stellar:testnet", "stellar:pubnet"],
        },
        since: {
          type: "string",
          description:
            "Inclusive lower bound on the purchase time (ISO-8601 date or timestamp; a bare date is read as midnight UTC).",
          examples: ["2026-08-01", "2026-08-01T12:00:00Z"],
        },
        until: {
          type: "string",
          description: "Inclusive upper bound on the purchase time (ISO-8601 date or timestamp).",
          examples: ["2026-08-31", "2026-08-31T23:59:59Z"],
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: RECEIPT_EXPORT_MAX_LIMIT,
          description: `Max receipts to export, newest first (1–${RECEIPT_EXPORT_MAX_LIMIT}).`,
          examples: [50, 100],
        },
        groupBy: {
          type: "string",
          enum: ["month"],
          description:
            'Optional grouping. Use "month" to include per-month receipt counts and USDC totals (UTC) in monthlySummaries.',
          examples: ["month"],
        },
      },
      required: [],
    },
    outputSchema: RECEIPT_EXPORT_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Export Receipts",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "zentrixpay_network_profile",
    description:
      "Report current Stellar/x402 network configuration (testnet/mainnet), RPC URLs, registry contract ID, and warnings for custom overrides. Use this to verify which network the MCP is connected to and diagnose configuration issues.",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: NETWORK_PROFILE_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Network Profile",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "zentrixpay_tx_status",
    description:
      "Look up the status of a Stellar transaction by hash via Soroban RPC. Returns SUCCESS, FAILED, or NOT_FOUND along with ledger number, close time, application order, and XDR envelopes. Useful for debugging on-chain registration failures.",
    inputSchema: {
      type: "object",
      properties: {
        txHash: {
          type: "string",
          description:
            "The 64-character hex transaction hash from Stellar (a sha256 digest; case-insensitive, 'sha256:' prefix accepted). From zentrixpay_register_onchain or zentrixpay_publish output.",
          examples: [
            "f47ac10b58cc4372a5670e02b2c3d479c3e5d0a1b2c3d4e5f6a7b8c9d0e1f2a3",
            "3fdba35f04dc8c462986c992bcf875546257113072a909c162f7e470e581e278",
          ],
        },
      },
      required: ["txHash"],
    },
    outputSchema: TX_STATUS_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Transaction Status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "zentrixpay_reset",
    description:
      "Clear credentials from memory and disk (~/.zentrixpay/state.json). By default only the active profile is cleared; pass all=true to remove every profile and delete the state file. After reset, run zentrixpay_setup_wallet and zentrixpay_register again.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          description:
            "Required to actually clear anything. Omitted or false returns a warning describing what would be removed and performs no deletion. Example: true clears the credentials.",
          examples: [true, false],
        },
        all: {
          type: "boolean",
          description:
            "Clear every profile and delete the state file (default: false clears active profile only). Example: true removes all profiles.",
          examples: [true, false],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set ZENTRIXPAY_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
        },
      },
      required: [],
    },
    annotations: {
      title: "Reset State",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
  },
  {
    name: "zentrixpay_backup_state",
    description:
      "Export ~/.zentrixpay/state.json to a mode-0600 encrypted recovery file after an explicit confirmation step. Requires a passphrase (min 8 chars); wallet secret keys and API keys never appear in plaintext. Restore with zentrixpay_restore_state using the file contents and same passphrase.",
    inputSchema: {
      type: "object",
      properties: {
        passphrase: {
          type: "string",
          description: "Passphrase used to encrypt the backup (min 8 characters). Keep it offline.",
        },
        confirm: {
          type: "boolean",
          description:
            "Required to write the encrypted recovery file. Omitted or false returns a safety preview.",
        },
      },
      required: ["passphrase"],
    },
    annotations: {
      title: "Back Up State",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "zentrixpay_restore_state",
    description:
      "Restore ~/.zentrixpay/state.json from an encrypted backup produced by zentrixpay_backup_state. Validates integrity (wrong passphrase or tampered data fails before any write). Replaces in-memory profiles and re-persists to disk (mode 0600). Existing reset behavior is unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        blob: {
          type: "string",
          description: "Encrypted backup blob from zentrixpay_backup_state (v1:… format).",
        },
        passphrase: {
          type: "string",
          description: "Passphrase used when the backup was created (min 8 characters).",
        },
      },
      required: ["blob", "passphrase"],
    },
    annotations: {
      title: "Restore State",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  {
    name: "zentrixpay_metrics",
    description:
      "Return opt-in tool-level metrics: per-tool call/error counts and durations, plus payment attempt/failure totals. Enable by setting ZENTRIXPAY_METRICS=1 on the server. Output contains only tool names, counts, and durations — never arguments, wallets, or API keys. Pass reset=true to clear counters after reading. format=otlp renders the same snapshot as an OTLP/JSON ExportMetricsServiceRequest body for direct submission to an OpenTelemetry collector.",
    inputSchema: {
      type: "object",
      properties: {
        reset: {
          type: "boolean",
          description:
            "Clear all counters after returning the current snapshot (default: false leaves counters intact). Example: true resets metrics after reading.",
          examples: [true, false],
        },
        format: {
          type: "string",
          enum: ["json", "otlp"],
          description:
            "Metrics export format. json (default) returns the snapshot object; otlp returns the same data as an OTLP/JSON ExportMetricsServiceRequest payload (a resourceMetrics envelope ready for an OpenTelemetry collector).",
          default: "json",
          examples: ["json", "otlp"],
        },
      },
      required: [],
    },
    outputSchema: METRICS_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Tool Metrics",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "zentrixpay_check_state_permissions",
    description:
      "Verify the state file (~/.zentrixpay/state.json) has safe permissions (mode 0600). Warns when the file is world-readable or group-readable, which would expose wallet secret keys and API keys to other system users. Safe by default; run after any manual file operations or environment migration.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: {
      title: "Check State Permissions",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "zentrixpay_client_config",
    description:
      "Emit a copy-paste MCP client config (mirrors docs/mcp-client-configs.md) pre-filled with this server's actual entrypoint path and detected network profile — no placeholder path or env values to hand-edit. Pass client to target one of claude-code, claude-desktop, codex, cursor, vscode, windsurf; omit it to get every supported client.",
    inputSchema: {
      type: "object",
      properties: {
        client: {
          type: "string",
          enum: ["claude-code", "claude-desktop", "codex", "cursor", "vscode", "windsurf"],
          description:
            "Which client's config to emit. Omit to receive a config block for every supported client.",
          examples: ["claude-code", "cursor", "vscode"],
        },
      },
      required: [],
    },
    annotations: {
      title: "Generate Client Config",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "zentrixpay_mainnet_banner",
    description:
      "Session-level explanation of the active network, what paid tools (zentrixpay_publish, zentrixpay_buy) and on-chain writes actually cost, and exactly how to confirm a mainnet mutation (confirmMainnet: true, or ZENTRIXPAY_ALLOW_MAINNET=1) — plus the current paid-operation confirmation policy (confirmPaid / ZENTRIXPAY_CONFIRM_PAID_OPERATIONS), when the operator has one configured. Call this once at the start of a session, especially before any paid or destructive operation on mainnet.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: {
      title: "Mainnet Session Banner",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "zentrixpay_import_wallet",
    description:
      "Import an existing Stellar wallet by providing a secret key (or reading ZENTRIXPAY_AGENT_SECRET from the environment). Validates the key, optionally persists it to the active profile (or a named profile), and never logs the secret. Use this to restore a wallet from backup or connect to an existing identity.",
    inputSchema: {
      type: "object",
      properties: {
        secretKey: {
          type: "string",
          description:
            "Stellar secret key (S… , 56 chars) to import. If omitted, reads from ZENTRIXPAY_AGENT_SECRET env var.",
          examples: ["SCHZPJ..."],
        },
        profile: {
          type: "string",
          description: "Optional profile name to import into. Defaults to the active profile.",
          examples: ["testnet", "mainnet-publisher"],
        },
        persist: {
          type: "boolean",
          description:
            "When true (default), save the imported wallet to the state file. When false, validate only and return the public key without writing to disk.",
          examples: [true, false],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set ZENTRIXPAY_ALLOW_MAINNET=1). Explicitly confirm this mutation on the public Stellar network.",
        },
      },
      required: [],
    },
    outputSchema: WALLET_SETUP_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Import Wallet",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "zentrixpay_rotate_publisher_key",
    description:
      "Rotate the publisher API key for the active profile. Calls the ZentrixPay server rotation endpoint (POST /publishers/me/rotate-key), stores the new key in the state file, and returns the updated publisher ID. The old key is invalidated server-side. Requires an existing registration (zentrixpay_register).",
    inputSchema: {
      type: "object",
      properties: {
        profile: {
          type: "string",
          description:
            "Optional profile name to rotate the key for. Defaults to the active profile.",
          examples: ["testnet", "mainnet-publisher"],
        },
        confirmMainnet: {
          type: "boolean",
          description:
            "Required on mainnet (or set ZENTRIXPAY_ALLOW_MAINNET=1). Explicitly confirm this mutation on the public Stellar network.",
        },
      },
      required: [],
    },
    annotations: {
      title: "Rotate Publisher Key",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "zentrixpay_verify_install",
    description:
      "Verify the ZentrixPay MCP server is installed and configured correctly. Checks Node.js version (>=20), network settings, URL variables, vault-registry contract ID, and warns about plaintext secrets in the environment. No network calls are made — all checks are local. Run this first when setting up a new agent or diagnosing a configuration problem.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: {
      title: "Verify Install",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "zentrixpay_debug_bundle",
    description:
      "Export a sanitized debug bundle to attach to a bug report or support ticket: resolved configuration, startup diagnostics, install checks, a profile summary (addresses only), state-file permissions, metrics, catalog cache status, and the tail of the audit log. Secret keys, API keys, and tokens never enter the bundle; public keys and contract ids are kept so it stays useful. Local and read-only, no network calls.",
    inputSchema: {
      type: "object",
      properties: {
        auditLogLines: {
          type: "integer",
          minimum: 0,
          maximum: DEBUG_BUNDLE_MAX_AUDIT_LINES,
          description: `Audit-log entries to include from the end of ZENTRIXPAY_AUDIT_LOG_FILE (0–${DEBUG_BUNDLE_MAX_AUDIT_LINES}, default ${DEBUG_BUNDLE_DEFAULT_AUDIT_LINES}). 0 omits the section.`,
          examples: [50, 200],
        },
        includeEnvironment: {
          type: "boolean",
          description:
            "Include the ZentrixPay-related environment variables with credential-like values masked. Default true; pass false to omit the section entirely.",
          examples: [true, false],
        },
      },
      required: [],
    },
    outputSchema: DEBUG_BUNDLE_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Export Debug Bundle",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "zentrixpay_purchase_history",
    description:
      "List locally persisted purchase receipts from successful zentrixpay_buy calls (~/.zentrixpay/purchases.json). Read-only. Filter by resourceId and network (exact match), or search resource ids and titles with a case-insensitive query. Filters can be combined. Returns newest first. Each receipt includes a pre-resolved explorerUrl for the settlement transaction (null when no txHash was recorded) — no external join is needed. To check live on-chain settlement status, pass the receipt's txHash to zentrixpay_tx_status.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          description: "Optional. Only return receipts for this resource id. Example: 'cm7x8y9z'",
          examples: ["cm7x8y9z", "res-001"],
        },
        network: {
          type: "string",
          description:
            "Optional. Only return receipts recorded on this x402 network id. Example: 'stellar:testnet'",
          examples: ["stellar:testnet", "stellar:pubnet"],
        },
        query: {
          type: "string",
          description:
            "Optional case-insensitive text search across receipt resource ids and titles.",
          examples: ["stellar", "res-001"],
        },
      },
      required: [],
    },
    outputSchema: PURCHASE_HISTORY_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Purchase History",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
];
