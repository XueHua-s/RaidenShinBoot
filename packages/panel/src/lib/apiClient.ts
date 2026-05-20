import { hc } from "hono/client";
import type { AppType } from "@raiden/server/app";

const csrfStorageKey = "raiden-admin-csrf";

function resolveApiBaseUrl() {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/$/, "");
  }

  return window.location.origin.replace(/\/$/, "");
}

export const apiBaseUrl = resolveApiBaseUrl();

export function getCsrfToken() {
  return window.localStorage.getItem(csrfStorageKey);
}

export function setCsrfToken(value: string | null) {
  if (value) {
    window.localStorage.setItem(csrfStorageKey, value);
    return;
  }

  window.localStorage.removeItem(csrfStorageKey);
}

export const apiClient = hc<AppType>(apiBaseUrl, {
  init: {
    credentials: "include"
  },
  headers: () => {
    const csrfToken = getCsrfToken();
    return csrfToken ? { "X-CSRF-Token": csrfToken } : {};
  }
});

export async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    try {
      const payload = JSON.parse(text) as { error?: string; message?: string };
      throw new Error(payload.error ?? payload.message ?? `Request failed with ${response.status}`);
    } catch (parseError) {
      if (parseError instanceof Error && parseError.name === "Error") {
        throw parseError;
      }
      throw new Error(text || `Request failed with ${response.status}`);
    }
  }

  return response.json() as Promise<T>;
}
