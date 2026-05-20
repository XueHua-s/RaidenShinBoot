import * as robot3Module from "robot3";
import { z } from "zod";
import { errorMessage, isAbortError, timeoutSignal } from "./fetch-timeout.js";
import type { BootSearchChannel, WebSearchRequest, WebSearchResponse, WebSearchResult } from "./schemas.js";

const robot3 =
  "default" in robot3Module
    ? (robot3Module as typeof robot3Module & { default: typeof robot3Module }).default
    : robot3Module;
const { createMachine, interpret, invoke, reduce, state, transition } = robot3;

const optionalString = z.preprocess((value) => (value === "" ? undefined : value), z.string().optional());
const optionalUrl = z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional());
const timeoutMs = z.coerce.number().int().min(1_000).max(120_000);

const searchEnvSchema = z.object({
  BOOT_SEARCH_PROVIDER: z.enum(["disabled", "tavily", "brave", "serper"]).default("disabled"),
  BOOT_SEARCH_API_KEY: optionalString,
  BOOT_SEARCH_BASE_URL: optionalUrl,
  BOOT_SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).max(10).default(5),
  BOOT_SEARCH_DEPTH: z.enum(["basic", "advanced"]).default("basic"),
  BOOT_SEARCH_TIMEOUT_MS: timeoutMs.default(15_000),
  BOOT_WIKIPEDIA_API_URL: z.string().url().default("https://zh.wikipedia.org/w/api.php"),
  BOOT_MOEGIRL_API_URL: z.string().url().default("https://zh.moegirl.org.cn/api.php")
});

export type BootSearchConfig = z.infer<typeof searchEnvSchema>;
export type BootSearchProvider = BootSearchConfig["BOOT_SEARCH_PROVIDER"];
export type BootSearchErrorCode =
  | "search_disabled"
  | "search_missing_api_key"
  | "search_provider_failed"
  | "search_provider_bad_json"
  | "search_no_channels"
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
  channels?: BootSearchChannel[];
  forceGoogle?: boolean;
};

type SearchPlan = {
  query: string;
  maxResults: number;
  channels: BootSearchChannel[];
};

type SearchMachineContext = {
  request: WebSearchRequest;
  config: BootSearchConfig;
  fetchImpl: typeof fetch;
  channels?: BootSearchChannel[];
  forceGoogle: boolean;
  plan?: SearchPlan;
  response?: WebSearchResponse;
  error?: unknown;
};

type DoneEvent<T> = { type: "done"; data: T };
type ErrorEvent = { type: "error"; error: unknown };

const searchMachine = createMachine(
  "planning",
  {
    planning: invoke(
      async (context: SearchMachineContext) => planSearch(context.request, context.config, context),
      transition(
        "done",
        "searching",
        reduce((context: SearchMachineContext, event: DoneEvent<SearchPlan>) => ({
          ...context,
          plan: event.data
        }))
      ),
      transition(
        "error",
        "failed",
        reduce((context: SearchMachineContext, event: ErrorEvent) => ({ ...context, error: event.error }))
      )
    ),
    searching: invoke(
      async (context: SearchMachineContext) => executeSearchPlan(requiredPlan(context), context),
      transition(
        "done",
        "completed",
        reduce((context: SearchMachineContext, event: DoneEvent<WebSearchResponse>) => ({
          ...context,
          response: event.data
        }))
      ),
      transition(
        "error",
        "failed",
        reduce((context: SearchMachineContext, event: ErrorEvent) => ({ ...context, error: event.error }))
      )
    ),
    completed: state(),
    failed: state()
  },
  (context: SearchMachineContext) => context
);

export function getBootSearchConfig(env: NodeJS.ProcessEnv = process.env): BootSearchConfig {
  const result = searchEnvSchema.safeParse(env);
  if (!result.success) {
    throw new BootSearchError("search_configuration_invalid", result.error.issues[0]?.message ?? "Invalid search configuration.", 500);
  }

  return result.data;
}

export function isWebSearchConfigured(env: NodeJS.ProcessEnv = process.env) {
  const config = getBootSearchConfig(env);
  return Boolean(config.BOOT_WIKIPEDIA_API_URL || config.BOOT_MOEGIRL_API_URL || config.BOOT_SEARCH_API_KEY);
}

export async function searchWeb(input: WebSearchRequest, options: SearchWebOptions = {}): Promise<WebSearchResponse> {
  const config = options.config ?? getBootSearchConfig();
  const context: SearchMachineContext = {
    request: input,
    config,
    fetchImpl: options.fetch ?? fetch,
    forceGoogle: options.forceGoogle ?? false
  };
  if (options.channels) {
    context.channels = options.channels;
  }
  return runSearchStateMachine(context);
}

export async function searchGoogle(input: WebSearchRequest, options: SearchWebOptions = {}): Promise<WebSearchResponse> {
  const config = options.config ?? getBootSearchConfig();
  const maxResults = Math.min(input.maxResults, config.BOOT_SEARCH_MAX_RESULTS);
  const results = await searchGoogleResults(input.query, maxResults, config, options.fetch ?? fetch);
  return {
    query: input.query,
    provider: `google:${config.BOOT_SEARCH_PROVIDER}`,
    status: "completed",
    channels: ["google"],
    failures: [],
    results
  };
}

export async function searchWikipedia(input: WebSearchRequest, options: SearchWebOptions = {}): Promise<WebSearchResponse> {
  const config = options.config ?? getBootSearchConfig();
  const maxResults = Math.min(input.maxResults, config.BOOT_SEARCH_MAX_RESULTS);
  const results = await mediaWikiSearch({
    query: input.query,
    maxResults,
    apiUrl: config.BOOT_WIKIPEDIA_API_URL,
    source: "wikipedia",
    timeoutMs: config.BOOT_SEARCH_TIMEOUT_MS,
    fetchImpl: options.fetch ?? fetch
  });
  return {
    query: input.query,
    provider: "wikipedia",
    status: "completed",
    channels: ["wikipedia"],
    failures: [],
    results
  };
}

export async function searchMoegirl(input: WebSearchRequest, options: SearchWebOptions = {}): Promise<WebSearchResponse> {
  const config = options.config ?? getBootSearchConfig();
  const maxResults = Math.min(input.maxResults, config.BOOT_SEARCH_MAX_RESULTS);
  const results = await mediaWikiSearch({
    query: input.query,
    maxResults,
    apiUrl: config.BOOT_MOEGIRL_API_URL,
    source: "moegirl",
    timeoutMs: config.BOOT_SEARCH_TIMEOUT_MS,
    fetchImpl: options.fetch ?? fetch
  });
  return {
    query: input.query,
    provider: "moegirl",
    status: "completed",
    channels: ["moegirl"],
    failures: [],
    results
  };
}

function runSearchStateMachine(context: SearchMachineContext) {
  return new Promise<WebSearchResponse>((resolve, reject) => {
    interpret(
      searchMachine,
      (service) => {
        const current = String(service.machine.current);
        const serviceContext = service.context as SearchMachineContext;
        if (current === "completed") {
          resolve(serviceContext.response as WebSearchResponse);
        }
        if (current === "failed") {
          reject(serviceContext.error);
        }
      },
      context
    );
  });
}

function requiredPlan(context: SearchMachineContext) {
  if (!context.plan) {
    throw new BootSearchError("search_no_channels", "Search routing did not produce a plan.", 500);
  }

  return context.plan;
}

export function planSearchChannels(query: string, options: Pick<SearchWebOptions, "channels" | "forceGoogle"> = {}): BootSearchChannel[] {
  if (options.channels?.length) {
    return uniqueChannels(options.channels);
  }

  const normalized = query.trim();
  const channels: BootSearchChannel[] = [];
  const moegirlIntent = shouldUseMoegirlSearch(normalized);
  const wikipediaIntent = shouldUseWikipediaSearch(normalized);
  const googleIntent = options.forceGoogle || shouldUseGoogleSearch(normalized);

  if (moegirlIntent) {
    channels.push("moegirl");
  }
  if (wikipediaIntent) {
    channels.push("wikipedia");
  }
  if (googleIntent || channels.length === 0) {
    channels.push("google");
  }

  return uniqueChannels(channels);
}

function planSearch(request: WebSearchRequest, config: BootSearchConfig, options: Pick<SearchWebOptions, "channels" | "forceGoogle">) {
  const channels = planSearchChannels(request.query, options);
  if (channels.length === 0) {
    throw new BootSearchError("search_no_channels", "Search routing did not select a channel.", 503);
  }

  return {
    query: request.query,
    maxResults: Math.min(request.maxResults, config.BOOT_SEARCH_MAX_RESULTS),
    channels
  };
}

async function executeSearchPlan(plan: SearchPlan, context: SearchMachineContext): Promise<WebSearchResponse> {
  const resultSets: WebSearchResult[][] = [];
  const failures: string[] = [];
  const errors: unknown[] = [];

  for (const channel of plan.channels) {
    try {
      const channelResults = await executeSearchChannel(channel, plan, context);
      resultSets.push(channelResults);
    } catch (error) {
      failures.push(`${channel}: ${formatBootSearchError(error)}`);
      errors.push(error);
    }
  }

  const dedupedResults = mergeChannelResults(resultSets, plan.maxResults);
  if (dedupedResults.length === 0 && failures.length > 0) {
    if (errors[0] instanceof BootSearchError) {
      throw errors[0];
    }
    throw new BootSearchError("search_provider_failed", failures.join("; "), 502);
  }

  return {
    query: plan.query,
    provider: `router:${plan.channels.join(",")}`,
    status: failures.length > 0 ? "partial" : "completed",
    channels: plan.channels,
    failures,
    results: dedupedResults
  };
}

async function executeSearchChannel(channel: BootSearchChannel, plan: SearchPlan, context: SearchMachineContext) {
  if (channel === "google") {
    return searchGoogleResults(plan.query, plan.maxResults, context.config, context.fetchImpl);
  }
  if (channel === "wikipedia") {
    return mediaWikiSearch({
      query: knowledgeSearchQuery(plan.query),
      maxResults: plan.maxResults,
      apiUrl: context.config.BOOT_WIKIPEDIA_API_URL,
      source: "wikipedia",
      timeoutMs: context.config.BOOT_SEARCH_TIMEOUT_MS,
      fetchImpl: context.fetchImpl
    });
  }

  return mediaWikiSearch({
    query: knowledgeSearchQuery(plan.query),
    maxResults: plan.maxResults,
    apiUrl: context.config.BOOT_MOEGIRL_API_URL,
    source: "moegirl",
    timeoutMs: context.config.BOOT_SEARCH_TIMEOUT_MS,
    fetchImpl: context.fetchImpl
  });
}

async function searchGoogleResults(
  query: string,
  maxResults: number,
  config: BootSearchConfig,
  fetchImpl: typeof fetch
): Promise<WebSearchResult[]> {
  const provider = config.BOOT_SEARCH_PROVIDER;

  if (provider === "disabled") {
    throw new BootSearchError(
      "search_disabled",
      "BOOT_SEARCH_PROVIDER is disabled; set it to tavily, brave, or serper to enable Google-style web search.",
      503
    );
  }

  if (!config.BOOT_SEARCH_API_KEY) {
    throw new BootSearchError("search_missing_api_key", "BOOT_SEARCH_API_KEY is required when BOOT_SEARCH_PROVIDER is enabled.", 503);
  }

  return provider === "tavily"
    ? tavilySearch(query, maxResults, config, fetchImpl)
    : provider === "brave"
      ? braveSearch(query, maxResults, config, fetchImpl)
      : serperSearch(query, maxResults, config, fetchImpl);
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
    },
    "Google-style search provider",
    config.BOOT_SEARCH_TIMEOUT_MS
  );

  const items = arrayFrom(payload, "results");
  return items.map((item) => toSearchResult(item, "google:tavily")).filter(isSearchResult).slice(0, maxResults);
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

  const payload = await fetchJson(
    fetchImpl,
    url,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-subscription-token": config.BOOT_SEARCH_API_KEY ?? ""
      }
    },
    "Google-style search provider",
    config.BOOT_SEARCH_TIMEOUT_MS
  );

  const web = recordFrom(payload, "web");
  const items = Array.isArray(web?.results) ? web.results : [];
  return items.map((item) => toSearchResult(item, "google:brave")).filter(isSearchResult).slice(0, maxResults);
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
    },
    "Google-style search provider",
    config.BOOT_SEARCH_TIMEOUT_MS
  );

  const items = arrayFrom(payload, "organic");
  return items.map((item) => toSearchResult(item, "google:serper")).filter(isSearchResult).slice(0, maxResults);
}

async function mediaWikiSearch(input: {
  query: string;
  maxResults: number;
  apiUrl: string;
  source: "wikipedia" | "moegirl";
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<WebSearchResult[]> {
  const url = new URL(input.apiUrl);
  url.searchParams.set("action", "opensearch");
  url.searchParams.set("search", input.query);
  url.searchParams.set("limit", String(input.maxResults));
  url.searchParams.set("namespace", "0");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");

  const payload = await fetchJson(
    input.fetchImpl,
    url,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "RaidenShinBoot/0.1 search-router"
      }
    },
    input.source,
    input.timeoutMs
  );

  if (!Array.isArray(payload)) {
    throw new BootSearchError("search_provider_bad_json", `${input.source} returned an unexpected search payload.`, 502);
  }

  const titles = stringArray(payload[1]).slice(0, input.maxResults);
  const descriptions = stringArray(payload[2]);
  const urls = stringArray(payload[3]);
  const extracts = await fetchMediaWikiExtracts(input.fetchImpl, input.apiUrl, titles, input.source, input.timeoutMs);

  return titles
    .map((title, index) => {
      const urlValue = urls[index] ?? articleUrl(input.source, title);
      const snippet = trimSnippet(extracts.get(title) ?? descriptions[index] ?? "");
      const result: WebSearchResult = {
        title,
        url: urlValue,
        source: input.source
      };
      if (snippet) {
        result.snippet = snippet;
      }
      return result;
    })
    .filter((result) => isValidUrl(result.url));
}

async function fetchMediaWikiExtracts(
  fetchImpl: typeof fetch,
  apiUrl: string,
  titles: string[],
  source: "wikipedia" | "moegirl",
  timeoutMsValue: number
) {
  const extracts = new Map<string, string>();
  if (titles.length === 0) {
    return extracts;
  }

  const url = new URL(apiUrl);
  url.searchParams.set("action", "query");
  url.searchParams.set("prop", "extracts");
  url.searchParams.set("titles", titles.join("|"));
  url.searchParams.set("exintro", "1");
  url.searchParams.set("explaintext", "1");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");

  try {
    const payload = await fetchJson(
      fetchImpl,
      url,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": "RaidenShinBoot/0.1 search-router"
        }
      },
      source,
      timeoutMsValue
    );
    const pages = recordFrom(recordFrom(payload, "query"), "pages");
    for (const value of Object.values(pages ?? {})) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const record = value as Record<string, unknown>;
      const title = stringValue(record.title);
      const extract = stringValue(record.extract);
      if (title && extract) {
        extracts.set(title, extract);
      }
    }
  } catch {
    return extracts;
  }

  return extracts;
}

async function fetchJson(fetchImpl: typeof fetch, url: URL, init: RequestInit, source: string, timeoutMsValue: number) {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: timeoutSignal(timeoutMsValue)
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new BootSearchError("search_provider_failed", `${source} timed out after ${timeoutMsValue}ms.`, 504);
    }
    throw new BootSearchError("search_provider_failed", `${source} request failed: ${errorMessage(error)}`, 502);
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (isAbortError(error)) {
      throw new BootSearchError("search_provider_failed", `${source} response body timed out after ${timeoutMsValue}ms.`, 504);
    }
    throw new BootSearchError("search_provider_failed", `${source} response body failed: ${errorMessage(error)}`, 502);
  }

  if (!response.ok) {
    throw new BootSearchError("search_provider_failed", `${source} failed with HTTP ${response.status}.`, 502);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BootSearchError("search_provider_bad_json", `${source} returned non-JSON response.`, 502);
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

export function shouldUseWebSearchForMessage(content: string) {
  return shouldUseGoogleSearch(content) || shouldUseWikipediaSearch(content) || shouldUseMoegirlSearch(content);
}

function shouldUseGoogleSearch(content: string) {
  return /(联网|搜索|搜一下|查一下|帮我查|查找|资料来源|最新|新闻|当前|现在的|目前的|今天.*(新闻|消息|价格|进展)|google|谷歌|web\s*search|search\s+the\s+web|look\s+up)/i.test(
    content
  );
}

function shouldUseWikipediaSearch(content: string) {
  return /(wikipedia|维基|百科|词条|是什么|是谁|介绍|背景|历史|定义|概念|资料)/i.test(content);
}

function shouldUseMoegirlSearch(content: string) {
  return /(萌娘|moegirl|二次元|动漫|动画|漫画|角色|人设|设定|剧情|原神|稻妻|雷电真|雷电影|雷电将军|八重神子|巴尔泽布|巴尔|影向山|眷属|身边人)/i.test(
    content
  );
}

function knowledgeSearchQuery(query: string) {
  const knownEntity = query.match(/雷电真|雷电影|雷电将军|八重神子|巴尔泽布|巴尔|狐斋宫|影向山|稻妻|原神/u)?.[0];
  if (knownEntity) {
    return knownEntity;
  }

  const cleaned = query
    .replace(/(请|帮我|搜索|查一下|结合|二次元|动漫|动画|漫画|角色|人设|设定|百科|背景|故事|回答|介绍|资料|是谁|是什么|和|以及|相关|身边人)/gu, " ")
    .replace(/[?？!！。，“”"':：；;、,，()[\]{}<>《》]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.split(" ").find((part) => part.length >= 2) ?? query.trim();
}

function uniqueChannels(channels: BootSearchChannel[]) {
  return Array.from(new Set(channels));
}

function mergeChannelResults(resultSets: WebSearchResult[][], maxResults: number) {
  const seen = new Set<string>();
  const merged: WebSearchResult[] = [];
  const maxLength = Math.max(0, ...resultSets.map((results) => results.length));

  for (let index = 0; index < maxLength && merged.length < maxResults; index += 1) {
    for (const results of resultSets) {
      const result = results[index];
      if (!result) {
        continue;
      }
      const key = result.url.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(result);
      if (merged.length >= maxResults) {
        break;
      }
    }
  }

  return merged;
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

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
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

  const snippet = trimSnippet(stringValue(record.content) ?? stringValue(record.description) ?? stringValue(record.snippet) ?? "");
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

function trimSnippet(value: string) {
  const cleaned = stripHtml(value).replace(/\s+/g, " ").trim();
  return cleaned.length > 320 ? `${cleaned.slice(0, 319)}...` : cleaned;
}

function stripHtml(value: string) {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, " "));
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function articleUrl(source: "wikipedia" | "moegirl", title: string) {
  const base = source === "wikipedia" ? "https://zh.wikipedia.org/wiki/" : "https://zh.moegirl.org.cn/";
  return `${base}${encodeURIComponent(title).replace(/%20/g, "_")}`;
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
