import { z } from "zod";
import type { WebSearchRequest, WebSearchResponse, WebSearchResult } from "./schemas.js";

const optionalString = z.preprocess((value) => (value === "" ? undefined : value), z.string().optional());
const optionalUrl = z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional());

const searchEnvSchema = z.object({
  BOOT_SEARCH_PROVIDER: z.enum(["disabled", "tavily", "brave", "serper"]).default("disabled"),
  BOOT_SEARCH_API_KEY: optionalString,
  BOOT_SEARCH_BASE_URL: optionalUrl,
  BOOT_SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).max(10).default(5),
  BOOT_SEARCH_DEPTH: z.enum(["basic", "advanced"]).default("basic")
});

export type BootSearchConfig = z.infer<typeof searchEnvSchema>;
export type BootSearchProvider = BootSearchConfig["BOOT_SEARCH_PROVIDER"];
export type BootSearchErrorCode =
  | "search_disabled"
  | "search_missing_api_key"
  | "search_provider_failed"
  | "search_provider_bad_json"
  | "search_configuration_invalid";

export class BootSearchError extends Error {
  readonly code: BootSearchErrorCode;
  readonly statusCode: number;

  constructor(code: BootSearchErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = "BootSearchError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type SearchWebOptions = {
  config?: BootSearchConfig;
  fetch?: typeof fetch;
};

export function getBootSearchConfig(env: NodeJS.ProcessEnv = process.env): BootSearchConfig {
  const result = searchEnvSchema.safeParse(env);
  if (!result.success) {
    throw new BootSearchError("search_configuration_invalid", result.error.issues[0]?.message ?? "Invalid search configuration.", 500);
  }

  return result.data;
}

export function isWebSearchConfigured(env: NodeJS.ProcessEnv = process.env) {
  const config = getBootSearchConfig(env);
  return config.BOOT_SEARCH_PROVIDER !== "disabled" && Boolean(config.BOOT_SEARCH_API_KEY);
}

export async function searchWeb(input: WebSearchRequest, options: SearchWebOptions = {}): Promise<WebSearchResponse> {
  const config = options.config ?? getBootSearchConfig();
  const provider = config.BOOT_SEARCH_PROVIDER;

  if (provider === "disabled") {
    throw new BootSearchError(
      "search_disabled",
      "BOOT_SEARCH_PROVIDER is disabled; set it to tavily, brave, or serper to enable web search.",
      503
    );
  }

  if (!config.BOOT_SEARCH_API_KEY) {
    throw new BootSearchError("search_missing_api_key", "BOOT_SEARCH_API_KEY is required when BOOT_SEARCH_PROVIDER is enabled.", 503);
  }

  const fetchImpl = options.fetch ?? fetch;
  const maxResults = Math.min(input.maxResults, config.BOOT_SEARCH_MAX_RESULTS);
  const results =
    provider === "tavily"
      ? await tavilySearch(input.query, maxResults, config, fetchImpl)
      : provider === "brave"
        ? await braveSearch(input.query, maxResults, config, fetchImpl)
        : await serperSearch(input.query, maxResults, config, fetchImpl);

  return {
    query: input.query,
    provider,
    results
  };
}

async function tavilySearch(
  query: string,
  maxResults: number,
  config: BootSearchConfig,
  fetchImpl: typeof fetch
): Promise<WebSearchResult[]> {
  const payload = await fetchJson(
    fetchImpl,
    joinUrl(config.BOOT_SEARCH_BASE_URL ?? "https://api.tavily.com", "/search"),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.BOOT_SEARCH_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        search_depth: config.BOOT_SEARCH_DEPTH,
        include_answer: false,
        include_raw_content: false,
        include_images: false
      })
    }
  );

  const items = arrayFrom(payload, "results");
  return items.map((item) => toSearchResult(item, "tavily")).filter(isSearchResult).slice(0, maxResults);
}

async function braveSearch(
  query: string,
  maxResults: number,
  config: BootSearchConfig,
  fetchImpl: typeof fetch
): Promise<WebSearchResult[]> {
  const url = joinUrl(config.BOOT_SEARCH_BASE_URL ?? "https://api.search.brave.com/res/v1", "/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));

  const payload = await fetchJson(fetchImpl, url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-subscription-token": config.BOOT_SEARCH_API_KEY ?? ""
    }
  });

  const web = recordFrom(payload, "web");
  const items = Array.isArray(web?.results) ? web.results : [];
  return items.map((item) => toSearchResult(item, "brave")).filter(isSearchResult).slice(0, maxResults);
}

async function serperSearch(
  query: string,
  maxResults: number,
  config: BootSearchConfig,
  fetchImpl: typeof fetch
): Promise<WebSearchResult[]> {
  const payload = await fetchJson(
    fetchImpl,
    joinUrl(config.BOOT_SEARCH_BASE_URL ?? "https://google.serper.dev", "/search"),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.BOOT_SEARCH_API_KEY ?? ""
      },
      body: JSON.stringify({
        q: query,
        num: maxResults
      })
    }
  );

  const items = arrayFrom(payload, "organic");
  return items.map((item) => toSearchResult(item, "serper")).filter(isSearchResult).slice(0, maxResults);
}

async function fetchJson(fetchImpl: typeof fetch, url: URL, init: RequestInit) {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new BootSearchError("search_provider_failed", `Web search provider failed with HTTP ${response.status}.`, 502);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BootSearchError("search_provider_bad_json", "Web search provider returned non-JSON response.", 502);
  }
}

export function getBootSearchErrorStatus(error: unknown) {
  return error instanceof BootSearchError ? error.statusCode : 500;
}

export function formatBootSearchError(error: unknown) {
  if (error instanceof BootSearchError) {
    return error.message;
  }

  return error instanceof Error ? error.message : "Web search failed.";
}

function joinUrl(baseUrl: string, path: string) {
  return new URL(path.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

function recordFrom(value: unknown, key: string) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const child = (value as Record<string, unknown>)[key];
  return child && typeof child === "object" ? (child as Record<string, unknown>) : null;
}

function arrayFrom(value: unknown, key: string) {
  if (!value || typeof value !== "object") {
    return [];
  }

  const child = (value as Record<string, unknown>)[key];
  return Array.isArray(child) ? child : [];
}

function toSearchResult(value: unknown, source: string): WebSearchResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const title = stringValue(record.title);
  const url = stringValue(record.url) ?? stringValue(record.link);
  if (!title || !url || !isValidUrl(url)) {
    return null;
  }

  const snippet = stringValue(record.content) ?? stringValue(record.description) ?? stringValue(record.snippet);
  const publishedAt = stringValue(record.published_date) ?? stringValue(record.date) ?? stringValue(record.age);
  const result: WebSearchResult = { title, url, source };
  if (snippet) {
    result.snippet = snippet;
  }
  if (publishedAt) {
    result.publishedAt = publishedAt;
  }
  return result;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isValidUrl(value: string) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isSearchResult(value: WebSearchResult | null): value is WebSearchResult {
  return value !== null;
}
