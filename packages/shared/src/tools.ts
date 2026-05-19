import { webSearchRequestSchema, webSearchResponseSchema, type WebSearchRequest, type WebSearchResponse } from "./schemas.js";
import { isWebSearchConfigured, searchWeb, type BootSearchConfig, type SearchWebOptions } from "./search.js";

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

const webSearchTool = {
  name: "web_search",
  description: "Search the live web and return grounded page results for a user query.",
  exposure: "direct",
  inputSchema: webSearchRequestSchema,
  outputSchema: webSearchResponseSchema,
  execute: async (input, context) => {
    const options: SearchWebOptions = {};
    if (context?.searchConfig) {
      options.config = context.searchConfig;
    }
    if (context?.fetch) {
      options.fetch = context.fetch;
    }
    return searchWeb(input, options);
  }
} satisfies BootToolDefinition<WebSearchRequest, WebSearchResponse>;

const bootTools = {
  web_search: webSearchTool
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
    return `联网搜索已执行，但没有找到结果。查询：${output.query}`;
  }

  return [
    `联网搜索结果（provider: ${output.provider}，query: ${output.query}）：`,
    ...output.results.map((result, index) => {
      const publishedAt = result.publishedAt ? `，时间：${result.publishedAt}` : "";
      const snippet = result.snippet ? `\n摘要：${result.snippet}` : "";
      return `${index + 1}. ${result.title}${publishedAt}\nURL：${result.url}${snippet}`;
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
      return `${index + 1}. ${result.title}\n${result.url}${snippet}`;
    })
    .join("\n\n");
}

function trimForTelegram(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

export function shouldUseWebSearchForMessage(content: string) {
  return /(联网|搜索|搜一下|查一下|帮我查|查找|资料来源|最新|新闻|当前|现在的|目前的|今天.*(新闻|消息|价格|进展)|web\s*search|search\s+the\s+web|look\s+up)/i.test(
    content
  );
}

export async function maybeExecuteWebSearchForMessage(content: string, context?: BootToolContext) {
  if (!shouldUseWebSearchForMessage(content)) {
    return null;
  }

  const configured = context?.searchConfig
    ? context.searchConfig.BOOT_SEARCH_PROVIDER !== "disabled" && Boolean(context.searchConfig.BOOT_SEARCH_API_KEY)
    : isWebSearchConfigured();
  if (!configured) {
    return null;
  }

  return executeBootTool(
    "web_search",
    {
      query: content,
      maxResults: 4
    },
    context
  );
}
