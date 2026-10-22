import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  PROVIDER_KEY_STORAGE,
  clearProviderKey,
  isProviderKeyRemembered,
  readProviderKey,
  saveProviderKey,
} from "../lib/providerKeyStorage.js";

// Issue #137: provider API keys are session-only by default, remembering them
// on the device is an explicit opt-in, and sign-out clears every copy.

const { mockFetchMyApis } = vi.hoisted(() => ({ mockFetchMyApis: vi.fn() }));

vi.mock("../api/apis.js", () => ({
  HTTP_METHODS: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  fetchMyApis: mockFetchMyApis,
  createApi: vi.fn(),
  fetchApiStats: vi.fn(),
  registerPublisher: vi.fn(),
  updateApi: vi.fn(),
  verifyApiOwnership: vi.fn(),
}));

import { ProviderDashboard } from "./ProviderDashboard.js";

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

const wallet = {
  status: "disconnected" as const,
  address: null,
  error: null,
  connect: vi.fn(),
  disconnect: vi.fn(),
};

function renderDashboard() {
  return render(<ProviderDashboard wallet={wallet as never} onCopy={vi.fn()} />);
}

function enterKey(key: string, remember: boolean) {
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: key } });
  if (remember) fireEvent.click(document.getElementById("remember-pasted-key")!);
  fireEvent.click(screen.getByRole("button", { name: "Open dashboard" }));
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", memoryStorage());
  vi.stubGlobal("localStorage", memoryStorage());
  mockFetchMyApis.mockReset();
  mockFetchMyApis.mockResolvedValue([]);
});

describe("providerKeyStorage", () => {
  it("stores the key for this session only by default", () => {
    saveProviderKey("mv_session", false);

    expect(sessionStorage.getItem(PROVIDER_KEY_STORAGE)).toBe("mv_session");
    expect(localStorage.getItem(PROVIDER_KEY_STORAGE)).toBeNull();
    expect(isProviderKeyRemembered()).toBe(false);
    expect(readProviderKey()).toBe("mv_session");
  });

  it("persists the key on the device when remember is chosen", () => {
    saveProviderKey("mv_remembered", true);

    expect(sessionStorage.getItem(PROVIDER_KEY_STORAGE)).toBe("mv_remembered");
    expect(localStorage.getItem(PROVIDER_KEY_STORAGE)).toBe("mv_remembered");
    expect(isProviderKeyRemembered()).toBe(true);
  });

  it("reads a remembered key in a new session", () => {
    localStorage.setItem(PROVIDER_KEY_STORAGE, "mv_remembered");

    expect(readProviderKey()).toBe("mv_remembered");
  });

  it("drops a previously remembered key when switching to session-only", () => {
    saveProviderKey("mv_old", true);
    saveProviderKey("mv_new", false);

    expect(localStorage.getItem(PROVIDER_KEY_STORAGE)).toBeNull();
    expect(readProviderKey()).toBe("mv_new");
  });

  it("clears the key from both storages", () => {
    saveProviderKey("mv_remembered", true);
    clearProviderKey();

    expect(sessionStorage.getItem(PROVIDER_KEY_STORAGE)).toBeNull();
    expect(localStorage.getItem(PROVIDER_KEY_STORAGE)).toBeNull();
    expect(readProviderKey()).toBe("");
  });

  it("does not throw when storage is unavailable", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    vi.stubGlobal("sessionStorage", broken);
    vi.stubGlobal("localStorage", broken);

    expect(() => saveProviderKey("mv_x", true)).not.toThrow();
    expect(() => clearProviderKey()).not.toThrow();
    expect(readProviderKey()).toBe("");
  });
});

describe("ProviderDashboard key storage", () => {
  it("leaves 'remember' unticked by default and keeps the key session-only", async () => {
    renderDashboard();
    const remember = document.getElementById("remember-pasted-key") as HTMLInputElement;
    expect(remember.checked).toBe(false);

    enterKey("mv_session", false);

    await waitFor(() => expect(mockFetchMyApis).toHaveBeenCalledWith("mv_session"));
    expect(sessionStorage.getItem(PROVIDER_KEY_STORAGE)).toBe("mv_session");
    expect(localStorage.getItem(PROVIDER_KEY_STORAGE)).toBeNull();
    expect(screen.getByText(/kept for this browser tab only/)).toBeTruthy();
  });

  it("remembers the key on the device when the provider opts in", async () => {
    renderDashboard();

    enterKey("mv_remembered", true);

    await waitFor(() => expect(mockFetchMyApis).toHaveBeenCalledWith("mv_remembered"));
    expect(localStorage.getItem(PROVIDER_KEY_STORAGE)).toBe("mv_remembered");
    expect(screen.getByText(/remembered on this device until you sign out/)).toBeTruthy();
  });

  it("opens the dashboard with a remembered key in a new session", async () => {
    localStorage.setItem(PROVIDER_KEY_STORAGE, "mv_remembered");

    renderDashboard();

    await waitFor(() => expect(mockFetchMyApis).toHaveBeenCalledWith("mv_remembered"));
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it.each([
    { label: "session-only", remember: false },
    { label: "remembered", remember: true },
  ])("sign-out clears a $label key from all storage", async ({ remember }) => {
    renderDashboard();
    enterKey("mv_key", remember);
    await waitFor(() => expect(mockFetchMyApis).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(sessionStorage.getItem(PROVIDER_KEY_STORAGE)).toBeNull();
    expect(localStorage.getItem(PROVIDER_KEY_STORAGE)).toBeNull();
    expect(screen.getByRole("button", { name: "Open dashboard" })).toBeTruthy();
  });
});
