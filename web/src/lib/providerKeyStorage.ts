/**
 * Where the provider dashboard keeps the publisher API key.
 *
 * Session-only is the default: the key lives in sessionStorage and is
 * forgotten when the tab closes. Providers can opt in to "remember on this
 * device", which also writes it to localStorage. Signing out clears both.
 */

export const PROVIDER_KEY_STORAGE = "zentrixpay-provider-api-key";

function session(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function local(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // Storage unavailable (private mode, quota): the key just won't survive a reload.
  }
}

/** The stored key for this tab, falling back to a remembered one. */
export function readProviderKey(): string {
  try {
    return (
      session()?.getItem(PROVIDER_KEY_STORAGE) ?? local()?.getItem(PROVIDER_KEY_STORAGE) ?? ""
    );
  } catch {
    return "";
  }
}

/** True when the key is persisted on this device (survives closing the tab). */
export function isProviderKeyRemembered(): boolean {
  try {
    return Boolean(local()?.getItem(PROVIDER_KEY_STORAGE));
  } catch {
    return false;
  }
}

/**
 * Store the key for this session. With `remember` it is also persisted on the
 * device; without it any previously remembered copy is removed, so choosing
 * session-only never leaves an older key behind.
 */
export function saveProviderKey(key: string, remember: boolean): void {
  safely(() => session()?.setItem(PROVIDER_KEY_STORAGE, key));
  safely(() => {
    if (remember) local()?.setItem(PROVIDER_KEY_STORAGE, key);
    else local()?.removeItem(PROVIDER_KEY_STORAGE);
  });
}

/** Sign-out: remove the key from every storage it may be in. */
export function clearProviderKey(): void {
  safely(() => session()?.removeItem(PROVIDER_KEY_STORAGE));
  safely(() => local()?.removeItem(PROVIDER_KEY_STORAGE));
}
