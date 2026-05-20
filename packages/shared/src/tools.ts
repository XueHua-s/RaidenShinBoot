import { webSearchRequestSchema, webSearchResponseSchema, type WebSearchRequest, type WebSearchResponse } from "./schemas.js";
import {
  formatBootSearchError,
  searchGoogle,
  searchMoegirl,
  searchWeb,
  searchWikipedia,
  shouldUseWebSearchForMessage as shouldRouteSearchForMessage,
  type BootSearchConfig,
  type SearchWebOptions
} from "./search.js";

export type BootToolExposure = "direct" | "deferred";

export type BootToolContext = {
  searchConfig?: BootSearchConfig;
  fetch?: typeof fetch;
};

export type BootToolDefinition<Input, Output> = {
  name: string;
  description: string;
  exposure: BootToolExposure;
  inputSchema: { parse: (input: unknown) => Input };
  outputSchema: { parse: (input: unknown) => Output };
  execute: (input: Input, context?: BootToolContext) => Promise<Output>;
};

export type WebSearchForMessageResult =
  | { status: "skipped"; response: null; error: null }
  | { status: "completed"; response: WebSearchResponse; error: null }
  | { status: "failed"; response: null; error: string };

const webSearchTool = {
  name: "web_search",
  description: "Route a user query across Google-style web search, Wikipedia, and Moegirl according to intent.",
  exposure: "direct",
  inputSchema: webSearchRequestSchema,
  outputSchema: webSearchResponseSchema,
  execute: async (input, context) => {
    return searchWeb(input, searchOptions(context));
  }
} satisfies BootToolDefinition<WebSearchRequest, WebSearchResponse>;

const googleSearchTool = {
  name: "google_search",
  description: "Search the general web through the configured Google-compatible provider.",
  exposure: "direct",
  inputSchema: webSearchRequestSchema,
  outputSchema: webSearchResponseSchema,
  execute: async (input, context) => searchGoogle(input, searchOptions(context))
} satisfies BootToolDefinition<WebSearchRequest, WebSearchResponse>;

const wikipediaSearchTool = {
  name: "wikipedia_search",
  description: "Search Chinese Wikipedia for encyclopedic background and factual context.",
  exposure: "direct",
  inputSchema: webSearchRequestSchema,
  outputSchema: webSearchResponseSchema,
  execute: async (input, context) => searchWikipedia(input, searchOptions(context))
} satisfies BootToolDefinition<WebSearchRequest, WebSearchResponse>;

const moegirlSearchTool = {
  name: "moegirl_search",
  description: "Search Moegirl for ACG characters, settings, plots, and persona-adjacent story context.",
  exposure: "direct",
  inputSchema: webSearchRequestSchema,
  outputSchema: webSearchResponseSchema,
  execute: async (input, context) => searchMoegirl(input, searchOptions(context))
} satisfies BootToolDefinition<WebSearchRequest, WebSearchResponse>;

const bootTools = {
  web_search: webSearchTool,
  google_search: googleSearchTool,
  wikipedia_search: wikipediaSearchTool,
  moegirl_search: moegirlSearchTool
} as const;

export type BootToolName = keyof typeof bootTools;
export type BootToolInput<Name extends BootToolName> = Parameters<(typeof bootTools)[Name]["execute"]>[0];
export type BootToolOutput<Name extends BootToolName> = Awaited<ReturnType<(typeof bootTools)[Name]["execute"]>>;

export function listBootTools() {
  return Object.values(bootTools).map((tool) => ({
    name: tool.name,
    description: tool.description,
    exposure: tool.exposure
  }));
}

export async function executeBootTool<Name extends BootToolName>(
  name: Name,
  input: BootToolInput<Name>,
  context?: BootToolContext
): Promise<BootToolOutput<Name>> {
  const tool = bootTools[name] as unknown as BootToolDefinition<unknown, unknown> | undefined;
  if (!tool) {
    throw new Error(`Unknown boot tool: ${name}`);
  }

  const parsedInput = tool.inputSchema.parse(input);
  const output = await tool.execute(parsedInput, context);
  return tool.outputSchema.parse(output) as BootToolOutput<Name>;
}

export function formatWebSearchResultsForPrompt(output: WebSearchResponse) {
  if (output.results.length === 0) {
    return `搜索状态：${output.status}。渠道：${output.channels.join(", ") || output.provider}。没有找到结果。查询：${output.query}`;
  }

  const failures = output.failures.length > 0 ? `\n失败渠道：${output.failures.join("；")}` : "";
  return [
    `搜索状态：${output.status}。渠道：${output.channels.join(", ") || output.provider}。查询：${output.query}${failures}`,
    ...output.results.map((result, index) => {
      const publishedAt = result.publishedAt ? `，时间：${result.publishedAt}` : "";
      const source = result.source ? `，来源：${result.source}` : "";
      const snippet = result.snippet ? `\n摘要：${result.snippet}` : "";
      return `${index + 1}. ${result.title}${publishedAt}${source}\nURL：${result.url}${snippet}`;
    })
  ].join("\n");
}

export function formatWebSearchResultsForTelegram(output: WebSearchResponse) {
  if (output.results.length === 0) {
    return "我搜索了，但没有找到足够可靠的结果。";
  }

  return output.results
    .map((result, index) => {
      const snippet = result.snippet ? `\n${trimForTelegram(result.snippet, 220)}` : "";
      const source = result.source ? ` [${result.source}]` : "";
      return `${index + 1}. ${result.title}${source}\n${result.url}${snippet}`;
    })
    .join("\n\n");
}

function trimForTelegram(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

export function shouldUseBootSearchForMessage(content: string) {
  return shouldRouteSearchForMessage(content);
}

export async function maybeExecuteWebSearchForMessage(content: string, context?: BootToolContext) {
  return (await resolveWebSearchForMessage(content, context)).response;
}

function searchOptions(context: BootToolContext | undefined, defaults: Partial<SearchWebOptions> = {}) {
  const options: SearchWebOptions = { ...defaults };
  if (context?.searchConfig) {
    options.config = context.searchConfig;
  }
  if (context?.fetch) {
    options.fetch = context.fetch;
  }
  return options;
}

export async function resolveWebSearchForMessage(content: string, context?: BootToolContext): Promise<WebSearchForMessageResult> {
  if (!shouldUseBootSearchForMessage(content)) {
    return { status: "skipped", response: null, error: null };
  }

  try {
    const response = await executeBootTool(
      "web_search",
      {
        query: content,
        maxResults: 4
      },
      context
    );
    return { status: "completed", response, error: null };
  } catch (error) {
    return {
      status: "failed",
      response: null,
      error: formatBootSearchError(error)
    };
  }
}
