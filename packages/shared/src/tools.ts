import {
  bootToolDescriptorSchema,
  bootToolSearchRequestSchema,
  bootToolSearchResponseSchema,
  imageGenerationRequestSchema,
  imageGenerationResponseSchema,
  webSearchRequestSchema,
  webSearchResponseSchema,
  type BootSearchChannel,
  type BootToolCapability,
  type BootToolDescriptor,
  type BootToolExposure,
  type BootToolSearchRequest,
  type BootToolSearchResponse,
  type ImageGenerationRequest,
  type ImageGenerationResponse,
  type WebSearchRequest,
  type WebSearchResponse
} from "./schemas.js";
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

export type BootToolPermissionContext = {
  actorId?: string | null;
  chatId?: string | null;
  allowedToolNames?: readonly string[];
  deniedToolNames?: readonly string[];
  requireExplicitAllowForDestructive?: boolean;
};

export type BootToolAuditEvent = {
  toolName: string;
  status: "completed" | "failed" | "denied";
  durationMs: number;
  readOnly: boolean;
  destructive: boolean;
  concurrencySafe: boolean;
  actorId?: string | null;
  chatId?: string | null;
  inputSummary?: string;
  resultSizeChars?: number;
  error?: string;
};

export type BootToolContext = {
  searchConfig?: BootSearchConfig;
  fetch?: typeof fetch;
  imageGenerator?: (input: ImageGenerationRequest) => Promise<ImageGenerationResponse>;
  permission?: BootToolPermissionContext;
  audit?: (event: BootToolAuditEvent) => void | Promise<void>;
};

export type BootToolValidationResult =
  | { result: true }
  | {
      result: false;
      message: string;
      errorCode?: string | number;
    };

export type BootToolPermissionResult<Input> =
  | { behavior: "allow"; input?: Input; reason?: string }
  | { behavior: "deny"; message: string; reason?: string; statusCode?: number };

export class BootToolRuntimeError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly toolName: string;

  constructor(code: string, message: string, statusCode: number, toolName: string) {
    super(message);
    this.name = "BootToolRuntimeError";
    this.code = code;
    this.statusCode = statusCode;
    this.toolName = toolName;
  }
}

export type BootToolDefinition<Input, Output> = {
  name: string;
  description: string;
  searchHint: string;
  exposure: BootToolExposure;
  capabilities: BootToolCapability[];
  channels: BootSearchChannel[];
  readOnly: boolean;
  destructive: boolean;
  concurrencySafe: boolean;
  maxResultCount: number;
  resultBudgetChars: number;
  inputSchema: { parse: (input: unknown) => Input };
  outputSchema: { parse: (input: unknown) => Output };
  inputSummary?: (input: Input) => string;
  validateInput?: (input: Input, context?: BootToolContext) => BootToolValidationResult | Promise<BootToolValidationResult>;
  checkPermissions?: (input: Input, context?: BootToolContext) => BootToolPermissionResult<Input> | Promise<BootToolPermissionResult<Input>>;
  budgetOutput?: (output: Output, budgetChars: number) => Output;
  execute: (input: Input, context?: BootToolContext) => Promise<Output>;
};

type BootToolDescriptorSource = {
  name: string;
  description: string;
  searchHint: string;
  exposure: BootToolExposure;
  capabilities: BootToolCapability[];
  channels: BootSearchChannel[];
  readOnly: boolean;
  destructive: boolean;
  concurrencySafe: boolean;
  maxResultCount: number;
  resultBudgetChars: number;
};

export type WebSearchForMessageResult =
  | { status: "skipped"; response: null; error: null }
  | { status: "completed"; response: WebSearchResponse; error: null }
  | { status: "failed"; response: null; error: string };

export function buildBootTool<Input, Output>(tool: BootToolDefinition<Input, Output>) {
  return tool;
}

const webSearchTool = buildBootTool({
  name: "web_search",
  description: "Route a user query across Google-style web search, Wikipedia, and Moegirl according to intent.",
  searchHint: "intent router for web knowledge persona context",
  exposure: "direct",
  capabilities: ["router", "web", "knowledge", "persona_context", "fallback_safe"],
  channels: ["google", "wikipedia", "moegirl"],
  readOnly: true,
  destructive: false,
  concurrencySafe: true,
  maxResultCount: 10,
  resultBudgetChars: 4000,
  inputSchema: webSearchRequestSchema,
  outputSchema: webSearchResponseSchema,
  inputSummary: (input) => input.query,
  budgetOutput: budgetWebSearchResponse,
  execute: async (input, context) => {
    return searchWeb(input, searchOptions(context));
  }
} satisfies BootToolDefinition<WebSearchRequest, WebSearchResponse>);

const googleSearchTool = buildBootTool({
  name: "google_search",
  description: "Search the general web through the configured Google-compatible provider.",
  searchHint: "current news external sources google compatible",
  exposure: "deferred",
  capabilities: ["web", "provider_specific"],
  channels: ["google"],
  readOnly: true,
  destructive: false,
  concurrencySafe: true,
  maxResultCount: 10,
  resultBudgetChars: 4000,
  inputSchema: webSearchRequestSchema,
  outputSchema: webSearchResponseSchema,
  inputSummary: (input) => input.query,
  budgetOutput: budgetWebSearchResponse,
  execute: async (input, context) => searchGoogle(input, searchOptions(context))
} satisfies BootToolDefinition<WebSearchRequest, WebSearchResponse>);

const wikipediaSearchTool = buildBootTool({
  name: "wikipedia_search",
  description: "Search Chinese Wikipedia for encyclopedic background and factual context.",
  searchHint: "encyclopedia factual background definitions history",
  exposure: "deferred",
  capabilities: ["knowledge", "provider_specific"],
  channels: ["wikipedia"],
  readOnly: true,
  destructive: false,
  concurrencySafe: true,
  maxResultCount: 10,
  resultBudgetChars: 4000,
  inputSchema: webSearchRequestSchema,
  outputSchema: webSearchResponseSchema,
  inputSummary: (input) => input.query,
  budgetOutput: budgetWebSearchResponse,
  execute: async (input, context) => searchWikipedia(input, searchOptions(context))
} satisfies BootToolDefinition<WebSearchRequest, WebSearchResponse>);

const moegirlSearchTool = buildBootTool({
  name: "moegirl_search",
  description: "Search Moegirl for ACG characters, settings, plots, and persona-adjacent story context.",
  searchHint: "anime character setting plot genshin makoto persona",
  exposure: "deferred",
  capabilities: ["knowledge", "persona_context", "provider_specific"],
  channels: ["moegirl"],
  readOnly: true,
  destructive: false,
  concurrencySafe: true,
  maxResultCount: 10,
  resultBudgetChars: 4000,
  inputSchema: webSearchRequestSchema,
  outputSchema: webSearchResponseSchema,
  inputSummary: (input) => input.query,
  budgetOutput: budgetWebSearchResponse,
  execute: async (input, context) => searchMoegirl(input, searchOptions(context))
} satisfies BootToolDefinition<WebSearchRequest, WebSearchResponse>);

const makotoImageTool = buildBootTool({
  name: "makoto_image",
  description: "Generate a Raiden Makoto atmosphere image through the configured image provider.",
  searchHint: "draw image illustration makoto atmosphere",
  exposure: "direct",
  capabilities: ["image", "generation", "persona_context"],
  channels: [],
  readOnly: false,
  destructive: false,
  concurrencySafe: true,
  maxResultCount: 4,
  resultBudgetChars: 8_000_000,
  inputSchema: imageGenerationRequestSchema,
  outputSchema: imageGenerationResponseSchema,
  inputSummary: (input) => input.prompt,
  execute: async (input, context) => {
    if (!context?.imageGenerator) {
      throw new BootToolRuntimeError("tool_context_missing", "Image generation is not configured for this runtime.", 503, "makoto_image");
    }

    return context.imageGenerator(input);
  }
} satisfies BootToolDefinition<ImageGenerationRequest, ImageGenerationResponse>);

const bootTools = {
  web_search: webSearchTool,
  google_search: googleSearchTool,
  wikipedia_search: wikipediaSearchTool,
  moegirl_search: moegirlSearchTool,
  makoto_image: makotoImageTool
} as const;

export type BootToolName = keyof typeof bootTools;
export type BootToolInput<Name extends BootToolName> = Parameters<(typeof bootTools)[Name]["execute"]>[0];
export type BootToolOutput<Name extends BootToolName> = Awaited<ReturnType<(typeof bootTools)[Name]["execute"]>>;

function getBootToolDescriptorsSource(): BootToolDescriptorSource[] {
  return Object.values(bootTools);
}

export function listBootTools() {
  return getBootToolDescriptorsSource().map(toBootToolDescriptor);
}

export function searchBootTools(input: BootToolSearchRequest): BootToolSearchResponse {
  const { query, maxResults } = bootToolSearchRequestSchema.parse(input);
  const tools = getBootToolDescriptorsSource();
  const selectMatch = query.match(/^select:(.+)$/i);

  if (selectMatch) {
    const requested = (selectMatch[1] ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    const selected = requested
      .map((name) => tools.find((tool) => tool.name.toLowerCase() === name))
      .filter((tool): tool is (typeof tools)[number] => tool !== undefined)
      .filter((tool, index, selectedTools) => selectedTools.findIndex((item) => item.name === tool.name) === index);
    const matches = selected
      .slice(0, maxResults)
      .map((tool) => ({ ...toBootToolDescriptor(tool), score: 100 }));

    return bootToolSearchResponseSchema.parse({
      query,
      totalTools: tools.length,
      matches
    });
  }

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  const requiredTerms = terms.filter((term) => term.startsWith("+") && term.length > 1).map((term) => term.slice(1));
  const optionalTerms = terms.filter((term) => !term.startsWith("+") || term.length === 1);
  const scoringTerms = requiredTerms.length > 0 ? [...requiredTerms, ...optionalTerms] : terms;

  const scored = tools
    .map((tool) => {
      const searchable = searchableToolText(tool);
      if (requiredTerms.length > 0 && !requiredTerms.every((term) => searchable.includes(term))) {
        return null;
      }
      const score = scoreToolMatch(tool, scoringTerms);
      return score > 0 ? { ...toBootToolDescriptor(tool), score } : null;
    })
    .filter((tool): tool is BootToolDescriptor & { score: number } => tool !== null)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, maxResults);

  return bootToolSearchResponseSchema.parse({
    query,
    totalTools: tools.length,
    matches: scored
  });
}

function toBootToolDescriptor(tool: BootToolDescriptorSource): BootToolDescriptor {
  return bootToolDescriptorSchema.parse({
    name: tool.name,
    description: tool.description,
    exposure: tool.exposure,
    searchHint: tool.searchHint,
    capabilities: tool.capabilities,
    channels: tool.channels,
    readOnly: tool.readOnly,
    destructive: tool.destructive,
    concurrencySafe: tool.concurrencySafe,
    maxResultCount: tool.maxResultCount,
    resultBudgetChars: tool.resultBudgetChars
  });
}

function searchableToolText(tool: BootToolDescriptorSource) {
  return [
    tool.name,
    ...tool.name.split("_"),
    tool.description,
    tool.searchHint,
    ...tool.capabilities,
    ...tool.channels
  ]
    .join(" ")
    .toLowerCase();
}

function scoreToolMatch(tool: BootToolDescriptorSource, terms: string[]) {
  const nameParts = tool.name.toLowerCase().split("_");
  const description = tool.description.toLowerCase();
  const searchHint = tool.searchHint.toLowerCase();
  const capabilities = tool.capabilities.map((capability) => capability.toLowerCase());
  const channels = tool.channels.map((channel) => channel.toLowerCase());
  let score = 0;

  for (const term of terms) {
    if (term.length === 0) {
      continue;
    }
    if (tool.name.toLowerCase() === term) {
      score += 16;
    }
    if (nameParts.includes(term)) {
      score += 10;
    } else if (nameParts.some((part) => part.includes(term))) {
      score += 5;
    }
    if (channels.includes(term)) {
      score += 8;
    }
    if (capabilities.includes(term)) {
      score += 7;
    } else if (capabilities.some((capability) => capability.includes(term))) {
      score += 3;
    }
    if (wordPattern(term).test(searchHint)) {
      score += 4;
    }
    if (wordPattern(term).test(description)) {
      score += 2;
    }
  }

  return score;
}

function wordPattern(term: string) {
  return new RegExp(`\\b${escapeRegExp(term)}\\b`, "i");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function budgetWebSearchResponse(output: WebSearchResponse, budgetChars: number): WebSearchResponse {
  const budgeted: WebSearchResponse = {
    ...output,
    channels: [...output.channels],
    failures: [...output.failures],
    results: output.results.map((result) => ({ ...result }))
  };
  let serializedLength = JSON.stringify(budgeted).length;

  while (serializedLength > budgetChars && budgeted.results.length > 0) {
    const overBy = serializedLength - budgetChars;
    const lastResult = budgeted.results[budgeted.results.length - 1];
    if (lastResult?.snippet) {
      const targetLength = Math.max(0, lastResult.snippet.length - overBy - 3);
      if (targetLength <= 0) {
        delete lastResult.snippet;
      } else if (targetLength < lastResult.snippet.length) {
        lastResult.snippet = `${lastResult.snippet.slice(0, targetLength)}...`;
      } else {
        budgeted.results.pop();
      }
    } else {
      budgeted.results.pop();
    }
    serializedLength = JSON.stringify(budgeted).length;
  }

  return budgeted;
}

function toolInputSummary<Input, Output>(tool: BootToolDefinition<Input, Output>, input: Input) {
  if (!tool.inputSummary) {
    return undefined;
  }

  return trimForAudit(tool.inputSummary(input), 500);
}

function trimForAudit(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function outputSizeChars(value: unknown) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

function hasToolName(list: readonly string[] | undefined, name: string) {
  return Boolean(list?.some((item) => item.toLowerCase() === name.toLowerCase()));
}

function defaultPermissionCheck<Input, Output>(
  tool: BootToolDefinition<Input, Output>,
  input: Input,
  context: BootToolContext | undefined
): BootToolPermissionResult<Input> {
  const permission = context?.permission;

  if (hasToolName(permission?.deniedToolNames, tool.name)) {
    return {
      behavior: "deny",
      message: `Tool ${tool.name} is denied by runtime policy.`,
      reason: "denied_tool",
      statusCode: 403
    };
  }

  if (permission?.allowedToolNames && !hasToolName(permission.allowedToolNames, tool.name)) {
    return {
      behavior: "deny",
      message: `Tool ${tool.name} is not allowed by runtime policy.`,
      reason: "tool_not_allowed",
      statusCode: 403
    };
  }

  if (tool.destructive && permission?.requireExplicitAllowForDestructive && !hasToolName(permission.allowedToolNames, tool.name)) {
    return {
      behavior: "deny",
      message: `Tool ${tool.name} requires explicit permission before destructive execution.`,
      reason: "destructive_requires_allow",
      statusCode: 403
    };
  }

  return { behavior: "allow", input };
}

async function checkToolPermission<Input, Output>(
  tool: BootToolDefinition<Input, Output>,
  input: Input,
  context: BootToolContext | undefined
) {
  const runtimePermission = defaultPermissionCheck(tool, input, context);
  if (runtimePermission.behavior === "deny") {
    return runtimePermission;
  }

  return tool.checkPermissions ? tool.checkPermissions(runtimePermission.input ?? input, context) : runtimePermission;
}

async function emitBootToolAudit(context: BootToolContext | undefined, event: BootToolAuditEvent) {
  try {
    await context?.audit?.(event);
  } catch (error) {
    console.warn("Boot tool audit hook failed.", error instanceof Error ? error.message : error);
  }
}

function baseAuditEvent<Input, Output>(
  tool: BootToolDefinition<Input, Output>,
  context: BootToolContext | undefined,
  startTime: number
): BootToolAuditEvent {
  const event: BootToolAuditEvent = {
    toolName: tool.name,
    status: "failed",
    durationMs: Date.now() - startTime,
    readOnly: tool.readOnly,
    destructive: tool.destructive,
    concurrencySafe: tool.concurrencySafe
  };

  const actorId = context?.permission?.actorId;
  const chatId = context?.permission?.chatId;
  if (actorId !== undefined) {
    event.actorId = actorId;
  }
  if (chatId !== undefined) {
    event.chatId = chatId;
  }

  return event;
}

export function getBootToolErrorStatus(error: unknown) {
  if (error instanceof BootToolRuntimeError) {
    return error.statusCode;
  }

  const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
  return typeof statusCode === "number" && Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 500;
}

export function formatBootToolError(error: unknown) {
  if (error instanceof BootToolRuntimeError) {
    return error.message;
  }

  return error instanceof Error ? error.message : "Boot tool failed.";
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

  const startTime = Date.now();
  let parsedInput: unknown;
  try {
    parsedInput = tool.inputSchema.parse(input);
  } catch (error) {
    const runtimeError = new BootToolRuntimeError("tool_input_schema_invalid", `Invalid input for tool ${tool.name}.`, 400, tool.name);
    const event = baseAuditEvent(tool, context, startTime);
    event.error = error instanceof Error ? error.message : "Input schema validation failed.";
    await emitBootToolAudit(context, event);
    throw runtimeError;
  }

  const inputSummary = toolInputSummary(tool, parsedInput);
  const validation = await tool.validateInput?.(parsedInput, context);
  if (validation?.result === false) {
    const error = new BootToolRuntimeError("tool_input_invalid", validation.message, 400, tool.name);
    const event = baseAuditEvent(tool, context, startTime);
    event.error = error.message;
    if (inputSummary) {
      event.inputSummary = inputSummary;
    }
    await emitBootToolAudit(context, event);
    throw error;
  }

  const permission = await checkToolPermission(tool, parsedInput, context);
  if (permission.behavior === "deny") {
    const error = new BootToolRuntimeError("tool_permission_denied", permission.message, permission.statusCode ?? 403, tool.name);
    const event = baseAuditEvent(tool, context, startTime);
    event.status = "denied";
    event.error = error.message;
    if (inputSummary) {
      event.inputSummary = inputSummary;
    }
    await emitBootToolAudit(context, event);
    throw error;
  }

  const executableInput = permission.input ?? parsedInput;
  try {
    const output = await tool.execute(executableInput, context);
    const parsedOutput = tool.outputSchema.parse(output);
    const budgetedOutput = tool.budgetOutput ? tool.budgetOutput(parsedOutput, tool.resultBudgetChars) : parsedOutput;
    const finalOutput = tool.outputSchema.parse(budgetedOutput);
    const event = baseAuditEvent(tool, context, startTime);
    event.status = "completed";
    event.resultSizeChars = outputSizeChars(finalOutput);
    if (inputSummary) {
      event.inputSummary = inputSummary;
    }
    await emitBootToolAudit(context, event);
    return finalOutput as BootToolOutput<Name>;
  } catch (error) {
    const event = baseAuditEvent(tool, context, startTime);
    event.error = error instanceof Error ? error.message : "Tool execution failed.";
    if (inputSummary) {
      event.inputSummary = inputSummary;
    }
    await emitBootToolAudit(context, event);
    throw error;
  }
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
