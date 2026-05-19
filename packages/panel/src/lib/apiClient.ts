import { hc } from "hono/client";
import type { AppType } from "@raiden/server/app";

export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787").replace(/\/$/, "");

export const apiClient = hc<AppType>(apiBaseUrl);

export async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}

