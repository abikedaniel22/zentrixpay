/**
 * Encrypted local-state backup and restore for the ZentrixPay MCP server.
 *
 * State holds credentials (wallet secret keys, publisher API keys), so a backup
 * must never leak plaintext secrets. This module encrypts the persisted
 * ProfileState with AES-256-GCM, keyed from a caller-supplied passphrase via
 * scrypt. The output is a single base64 string an agent can copy between
 * environments.
 *
 * Integrity is bound to the ciphertext: any tampering or wrong passphrase fails
 * the GCM auth tag before any state is touched, so restoreState is safe to
 * call on untrusted input.
 *
 * Reset behavior is intentionally untouched — this module only adds export/import.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { STATE_VERSION, type ProfileState, type WalletProfile } from "./profiles.js";

const STATE_DIR = join(homedir(), ".zentrixpay");
const STATE_FILE = join(STATE_DIR, "state.json");
const BACKUP_DIR = join(STATE_DIR, "backups");

// scrypt cost params — tuned for interactive passphrase derivation (not hot path).
// N=2^14 keeps OpenSSL maxmem happy in constrained CI/agent envs.
const SCRYPT_N = 1 << 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const KEY_LEN = 32;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const AUTH_TAG_LEN = 8 * 2;

/** Deterministic, agent-safe error messages (no internal details leaked). */
export class StateBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateBackupError";
  }
}

export interface RestoreStateOptions {
  expectedNetwork?: string;
}

export interface PersistedStateSecretMatch {
  path: string;
  kind: "wallet-secret-key" | "api-key";
}

/**
 * Report secret-bearing fields in an unencrypted persisted-state backup before
 * it is shared. Encrypted `exportState` output is safe to transport instead.
 */
export function scanPersistedStateSecrets(raw: unknown): PersistedStateSecretMatch[] {
  if (!raw || typeof raw !== "object") return [];
  const profiles = (raw as { profiles?: unknown }).profiles;
  if (!profiles || typeof profiles !== "object") return [];

  const matches: PersistedStateSecretMatch[] = [];
  for (const [profileName, value] of Object.entries(profiles as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const profile = value as { apiKey?: unknown; wallet?: { secretKey?: unknown } };
    if (typeof profile.wallet?.secretKey === "string" && profile.wallet.secretKey.length > 0) {
      matches.push({ path: `profiles.${profileName}.wallet.secretKey`, kind: "wallet-secret-key" });
    }
    if (typeof profile.apiKey === "string" && profile.apiKey.length > 0) {
      matches.push({ path: `profiles.${profileName}.apiKey`, kind: "api-key" });
    }
  }
  return matches;
}

/**
 * Read the current persisted state. Returns a normalized ProfileState.
 * Throws a deterministic error when the state file is missing or unreadable.
 */
export function readPersistedState(): ProfileState {
  if (!existsSync(STATE_FILE)) {
    throw new StateBackupError("No state file found. Run zentrixpay_setup_wallet first.");
  }
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizePersisted(parsed);
  } catch {
    throw new StateBackupError("State file is corrupted and could not be read.");
  }
}

/**
 * Export the current state as an encrypted, base64-encoded string.
 *
 * The output is self-contained: v1:<salt>:<nonce>:<ciphertext+tag>. The
 * passphrase is never stored or logged. Plaintext secrets never appear in the
 * output — only the encrypted profile bytes do.
 */
export function exportState(passphrase: string): string {
  if (!passphrase || passphrase.length < 8) {
    throw new StateBackupError("Passphrase must be at least 8 characters.");
  }
  const state = readPersistedState();
  const payload = JSON.stringify(state);
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const key = scryptSync(passphrase, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([ciphertext, tag]);
  return `v1:${salt.toString("base64")}:${nonce.toString("base64")}:${blob.toString("base64")}`;
}

/** Encrypt the current state and write a private recovery file. */
export function exportStateFile(
  passphrase: string,
  now: Date = new Date(),
  directory: string = BACKUP_DIR,
): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const path = join(directory, `state-${stamp}.backup`);
  writeAtomically(path, `${exportState(passphrase)}\n`, 0o600);
  return path;
}

/**
 * Restore state from an encrypted backup string.
 *
 * Validates the passphrase and integrity (GCM auth tag) before writing anything.
 * On success the in-memory state is replaced and re-persisted (mode 0600).
 * On any failure no state is modified and a deterministic error is thrown.
 */
export function restoreState(
  blob: string,
  passphrase: string,
  write: (state: ProfileState) => void,
  options: RestoreStateOptions = {},
): string {
  if (!passphrase || passphrase.length < 8) {
    throw new StateBackupError("Passphrase must be at least 8 characters.");
  }
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new StateBackupError("Invalid backup format.");
  }
  let salt: Buffer;
  let nonce: Buffer;
  let payload: Buffer;
  try {
    salt = Buffer.from(parts[1], "base64");
    nonce = Buffer.from(parts[2], "base64");
    payload = Buffer.from(parts[3], "base64");
  } catch {
    throw new StateBackupError("Invalid backup encoding.");
  }
  if (salt.length !== SALT_LEN || nonce.length !== NONCE_LEN || payload.length < AUTH_TAG_LEN) {
    throw new StateBackupError("Invalid backup payload.");
  }
  const key = scryptSync(passphrase, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  const ciphertext = payload.subarray(0, payload.length - AUTH_TAG_LEN);
  const tag = payload.subarray(payload.length - AUTH_TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  let plaintext: string;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new StateBackupError(
      "Backup integrity check failed (wrong passphrase or tampered data).",
    );
  }
  let state: ProfileState;
  try {
    state = normalizePersisted(JSON.parse(plaintext));
  } catch {
    throw new StateBackupError("Backup contents are not valid state.");
  }
  if (options.expectedNetwork) {
    const mismatched = Object.entries(state.profiles).find(
      ([, profile]) => profile.network && profile.network !== options.expectedNetwork,
    );
    if (mismatched) {
      throw new StateBackupError(
        `Backup belongs to network "${mismatched[1].network}" but the active profile uses "${options.expectedNetwork}".`,
      );
    }
  }
  write(state);
  return `State restored: ${Object.keys(state.profiles).length} profile(s), active "${state.activeProfile}".`;
}

/**
 * Normalize an unknown parsed value into a valid ProfileState, mirroring the
 * rules in profiles.ts (valid profile names, valid wallets, non-empty API
 * keys). Unrecognized fields are dropped so restored state cannot smuggle junk.
 */
function normalizePersisted(raw: unknown): ProfileState {
  if (!raw || typeof raw !== "object") {
    return { version: STATE_VERSION, activeProfile: "default", profiles: {} };
  }
  const obj = raw as {
    version?: unknown;
    activeProfile?: unknown;
    profiles?: unknown;
  };
  const profiles: Record<string, WalletProfile> = {};
  if (obj.profiles && typeof obj.profiles === "object") {
    for (const [name, value] of Object.entries(obj.profiles as Record<string, unknown>)) {
      if (!isValidProfileName(name)) continue;
      const profile = normalizeProfile(value);
      if (profile) profiles[name] = profile;
    }
  }
  const activeProfile =
    typeof obj.activeProfile === "string" && isValidProfileName(obj.activeProfile)
      ? obj.activeProfile
      : "default";
  return { version: STATE_VERSION, activeProfile, profiles };
}

function normalizeProfile(raw: unknown): WalletProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as {
    network?: unknown;
    apiKey?: unknown;
    wallet?: unknown;
  };
  const profile: WalletProfile = {};
  if (typeof obj.network === "string" && obj.network.length > 0) {
    profile.network = obj.network;
  }
  if (typeof obj.apiKey === "string" && obj.apiKey.length > 0) {
    profile.apiKey = obj.apiKey;
  }
  if (obj.wallet && typeof obj.wallet === "object") {
    const wallet = normalizeWallet(obj.wallet);
    if (wallet) profile.wallet = wallet;
  }
  return profile;
}

function normalizeWallet(raw: unknown): WalletProfile["wallet"] | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as {
    publicKey?: unknown;
    secretKey?: unknown;
    address?: unknown;
  };
  if (typeof obj.publicKey !== "string" || obj.publicKey.length === 0) return null;
  if (typeof obj.secretKey !== "string" || obj.secretKey.length === 0) return null;
  const wallet: NonNullable<WalletProfile["wallet"]> = {
    publicKey: obj.publicKey,
    secretKey: obj.secretKey,
  };
  if (typeof obj.address === "string" && obj.address.length > 0) {
    wallet.address = obj.address;
  }
  return wallet;
}

function isValidProfileName(name: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(name);
}

function writeAtomically(path: string, contents: string, mode: number): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, contents, { mode });
  try {
    chmodSync(tmp, mode);
  } catch {
    // best-effort on platforms without chmod semantics
  }
  renameSync(tmp, path);
  try {
    if (statSync(path).mode & 0o077) chmodSync(path, mode);
  } catch {
    // best-effort
  }
}

// Keep unlinkSync referenced for parity with reset flows that may import it.
void unlinkSync;
