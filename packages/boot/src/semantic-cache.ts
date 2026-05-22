import { createClient, type RedisClientType } from "redis";
import * as robot3Module from "robot3";
import { fixedBootEmbeddingModel } from "@raiden/shared/boot";
import {
  conversationCachePolicyVersion,
  isStandaloneCacheCandidate,
  normalizeCacheQuery,
  stableHash
} from "./semantic-cache-policy.js";

export {
  buildConversationCacheContextFingerprint,
  conversationCachePolicyVersion,
  conversationCacheScope,
  isStandaloneCacheCandidate,
  normalizeCacheQuery
} from "./semantic-cache-policy.js";

const robot3 =
  "default" in robot3Module
    ? (robot3Module as typeof robot3Module & { default: typeof robot3Module }).default
    : robot3Module;
const { createMachine, guard, immediate, interpret, invoke, reduce, state, transition } = robot3;

export type ConversationCacheStatus = "disabled" | "miss" | "l1_hit" | "l2_hit" | "write_skipped" | "written" | "write_failed";
export type ConversationCacheWebSearchStatus = "skipped" | "completed" | "failed";

export type ConversationCacheMetadata = {
  memoryCount: number;
  webSearchResultCount: number;
  webSearchStatus: ConversationCacheWebSearchStatus;
};

export type SemanticCacheConfig = {
  enabled: boolean;
  l1Enabled: boolean;
  l2Enabled: boolean;
  redisUrl: string | null;
  prefix: string;
  namespace: string;
  ttlSeconds: number;
  similarityThreshold: number;
  maxCandidates: number;
  indexName: string;
  operationTimeoutMs: number;
};

export type ConversationCacheHit = {
  status: "l1_hit" | "l2_hit";
  reply: string;
  similarity: number | null;
  sourceKey: string;
} & ConversationCacheMetadata;

export type ConversationCacheLookup = ConversationCacheHit | { status: "disabled" | "miss"; reason?: string };

export type ConversationCacheWriteResult = {
  status: "write_skipped" | "written" | "write_failed";
  reason?: string;
};

type LookupContext = {
  config: SemanticCacheConfig;
  scope: string;
  contextFingerprint: string;
  content: string;
  normalizedQuery: string;
  embedding?: number[] | undefined;
  hit?: ConversationCacheHit | undefined;
  reason?: string | undefined;
};

type ConversationCacheWriteInput = {
  scope: string;
  contextFingerprint: string;
  content: string;
  reply: string;
  embedding: number[];
  model: string;
  metadata: ConversationCacheMetadata;
  config?: SemanticCacheConfig | undefined;
};

type WriteContext = Omit<ConversationCacheWriteInput, "config"> & {
  config: SemanticCacheConfig;
  normalizedQuery: string;
  result?: ConversationCacheWriteResult | undefined;
};

type DoneEvent<T> = { type: "done"; data: T };
type ErrorEvent = { type: "error"; error: unknown };

const defaultCachePrefix = "boot:semantic-cache";
const requiredEmbeddingDimensions = 3072;

let redisClientPromise: Promise<RedisClientType> | null = null;
let redisClientUrl: string | null = null;
let redisClientGeneration = 0;
const readyIndexes = new Set<string>();
const unavailableIndexes = new Set<string>();

const lookupMachine = createMachine(
  "checking",
  {
    checking: state(
      immediate(
        "disabled",
        guard((context: LookupContext) => !context.config.enabled || !context.config.redisUrl),
        reduce((context: LookupContext) => ({
          ...context,
          reason: !context.config.enabled ? "semantic cache disabled" : "REDIS_URL is not configured"
        }))
      ),
      immediate(
        "disabled",
        guard((context: LookupContext) => !isStandaloneCacheCandidate(context.content)),
        reduce((context: LookupContext) => ({ ...context, reason: "query is not cacheable" }))
      ),
      immediate("exact")
    ),
    exact: invoke(
      async (context: LookupContext) => withCacheTimeout(() => readExactCache(context), context.config, "L1 lookup"),
      transition(
        "done",
        "hit",
        guard((_: LookupContext, event: DoneEvent<ConversationCacheHit | null>) => event.data !== null),
        reduce((context: LookupContext, event: DoneEvent<ConversationCacheHit | null>) => ({
          ...context,
          hit: event.data ?? context.hit
        }))
      ),
      transition(
        "done",
        "semantic",
        guard((context: LookupContext) => Boolean(context.embedding))
      ),
      transition("done", "miss"),
      transition(
        "error",
        "miss",
        reduce((context: LookupContext, event: ErrorEvent) => ({
          ...context,
          reason: errorMessage(event.error)
        }))
      )
    ),
    semantic: state(
      immediate(
        "miss",
        guard((context: LookupContext) => !context.config.l2Enabled || !context.embedding),
        reduce((context: LookupContext) => ({
          ...context,
          reason: !context.config.l2Enabled ? "semantic cache L2 disabled" : "query embedding unavailable"
        }))
      ),
      immediate("semanticLookup")
    ),
    semanticLookup: invoke(
      async (context: LookupContext) => withCacheTimeout(() => readSemanticCache(context), context.config, "L2 lookup"),
      transition(
        "done",
        "hit",
        guard((_: LookupContext, event: DoneEvent<ConversationCacheHit | null>) => event.data !== null),
        reduce((context: LookupContext, event: DoneEvent<ConversationCacheHit | null>) => ({
          ...context,
          hit: event.data ?? context.hit
        }))
      ),
      transition("done", "miss"),
      transition(
        "error",
        "miss",
        reduce((context: LookupContext, event: ErrorEvent) => ({
          ...context,
          reason: errorMessage(event.error)
        }))
      )
    ),
    hit: state(),
    miss: state(),
    disabled: state()
  },
  (context: LookupContext) => context
);

const writeMachine = createMachine(
  "checking",
  {
    checking: state(
      immediate(
        "skipped",
        guard((context: WriteContext) => !context.config.enabled || !context.config.redisUrl),
        reduce((context: WriteContext) => ({
          ...context,
          result: writeSkipped("semantic cache disabled or REDIS_URL missing")
        }))
      ),
      immediate(
        "skipped",
        guard((context: WriteContext) => !isStandaloneCacheCandidate(context.content)),
        reduce((context: WriteContext) => ({
          ...context,
          result: writeSkipped("query is not cacheable")
        }))
      ),
      immediate(
        "skipped",
        guard((context: WriteContext) => context.embedding.length !== requiredEmbeddingDimensions),
        reduce((context: WriteContext) => ({
          ...context,
          result: writeSkipped(`embedding must have ${requiredEmbeddingDimensions} dimensions`)
        }))
      ),
      immediate("writing")
    ),
    writing: invoke(
      writeCacheEntry,
      transition(
        "done",
        "written",
        reduce((context: WriteContext, event: DoneEvent<ConversationCacheWriteResult>) => ({
          ...context,
          result: event.data
        }))
      ),
      transition(
        "error",
        "failed",
        reduce((context: WriteContext, event: ErrorEvent) => ({
          ...context,
          result: writeFailed(errorMessage(event.error))
        }))
      )
    ),
    skipped: state(),
    written: state(),
    failed: state()
  },
  (context: WriteContext) => context
);

export function getSemanticCacheConfig(env: NodeJS.ProcessEnv = process.env): SemanticCacheConfig {
  const redisUrl = optionalString(env.REDIS_URL);
  const prefix = optionalString(env.BOOT_SEMANTIC_CACHE_PREFIX) ?? defaultCachePrefix;
  return {
    enabled: envFlag(env.BOOT_SEMANTIC_CACHE_ENABLED, Boolean(redisUrl)),
    l1Enabled: envFlag(env.BOOT_SEMANTIC_CACHE_L1_ENABLED, true),
    l2Enabled: envFlag(env.BOOT_SEMANTIC_CACHE_L2_ENABLED, true),
    redisUrl,
    prefix,
    namespace:
      optionalString(env.BOOT_SEMANTIC_CACHE_NAMESPACE) ??
      stableHash([env.BOOT_CHAT_MODEL ?? "", fixedBootEmbeddingModel, conversationCachePolicyVersion]).slice(0, 16),
    ttlSeconds: positiveInteger(env.BOOT_SEMANTIC_CACHE_TTL_SECONDS, 86_400, 2_592_000),
    similarityThreshold: boundedNumber(env.BOOT_SEMANTIC_CACHE_THRESHOLD, 0.92, 0.5, 0.99),
    maxCandidates: positiveInteger(env.BOOT_SEMANTIC_CACHE_MAX_CANDIDATES, 8, 50),
    indexName: optionalString(env.BOOT_SEMANTIC_CACHE_INDEX) ?? `${sanitizeIndexName(prefix)}:v2:idx`,
    operationTimeoutMs: positiveInteger(env.BOOT_SEMANTIC_CACHE_TIMEOUT_MS, 750, 10_000)
  };
}

export async function lookupConversationCache(input: {
  scope: string;
  contextFingerprint: string;
  content: string;
  embedding?: number[] | undefined;
  config?: SemanticCacheConfig | undefined;
}): Promise<ConversationCacheLookup> {
  const context: LookupContext = {
    config: input.config ?? getSemanticCacheConfig(),
    scope: input.scope,
    contextFingerprint: input.contextFingerprint,
    content: input.content,
    normalizedQuery: normalizeCacheQuery(input.content),
    embedding: input.embedding
  };

  return new Promise<ConversationCacheLookup>((resolve) => {
    interpret(lookupMachine, (service) => {
      const current = String(service.machine.current);
      const serviceContext = service.context as LookupContext;
      if (current === "hit" && serviceContext.hit) {
        resolve(serviceContext.hit);
      }
      if (current === "miss") {
        resolve(cacheMiss("miss", serviceContext.reason));
      }
      if (current === "disabled") {
        resolve(cacheMiss("disabled", serviceContext.reason));
      }
    }, context);
  });
}

export async function writeConversationCache(input: ConversationCacheWriteInput): Promise<ConversationCacheWriteResult> {
  const config = input.config ?? getSemanticCacheConfig();
  return runCacheWriteStateMachine({
    ...input,
    config,
    normalizedQuery: normalizeCacheQuery(input.content)
  });
}

export async function closeSemanticCache() {
  const clientPromise = redisClientPromise;
  redisClientPromise = null;
  redisClientUrl = null;
  redisClientGeneration += 1;
  readyIndexes.clear();
  unavailableIndexes.clear();

  if (!clientPromise) {
    return;
  }

  let client: RedisClientType;
  try {
    client = await clientPromise;
  } catch {
    return;
  }

  if (!client.isOpen) {
    return;
  }

  try {
    await client.quit();
  } catch {
    client.destroy();
  }
}

async function readExactCache(context: LookupContext): Promise<ConversationCacheHit | null> {
  if (!context.config.l1Enabled) {
    return null;
  }

  const client = await getRedisClient(context.config);
  const itemKey = await client.get(
    exactCacheKey(context.config, context.scope, context.contextFingerprint, context.normalizedQuery)
  );
  if (!itemKey) {
    return null;
  }

  const entry = await client.hGetAll(itemKey);
  if (!validEntry(entry, context.config.namespace, context.scope, context.contextFingerprint)) {
    return null;
  }
  const metadata = cacheEntryMetadata({
    memoryCount: entry.memoryCount,
    webSearchResultCount: entry.webSearchResultCount,
    webSearchStatus: entry.webSearchStatus
  });
  if (!metadata) {
    return null;
  }

  return {
    status: "l1_hit",
    reply: entry.reply,
    similarity: 1,
    sourceKey: itemKey,
    ...metadata
  };
}

async function readSemanticCache(context: LookupContext): Promise<ConversationCacheHit | null> {
  if (!context.embedding || context.embedding.length !== requiredEmbeddingDimensions) {
    return null;
  }

  const client = await getRedisClient(context.config);
  await ensureVectorIndex(client, context.config);
  if (unavailableIndexes.has(indexStateKey(context.config))) {
    return null;
  }

  const response = await client.sendCommand([
    "FT.SEARCH",
    context.config.indexName,
    `(@namespace:{${escapeTagValue(context.config.namespace)}} @scope:{${escapeTagValue(context.scope)}} @contextFingerprint:{${escapeTagValue(context.contextFingerprint)}})=>[KNN ${context.config.maxCandidates} @embedding $embedding AS distance]`,
    "PARAMS",
    "2",
    "embedding",
    float32VectorBuffer(context.embedding),
    "SORTBY",
    "distance",
    "RETURN",
    "4",
    "namespace",
    "scope",
    "contextFingerprint",
    "distance",
    "DIALECT",
    "2"
  ]);
  const maxDistance = 1 - context.config.similarityThreshold;

  for (const hit of parseSearchResponse(response)) {
    if (
      hit.namespace !== context.config.namespace ||
      hit.scope !== context.scope ||
      hit.contextFingerprint !== context.contextFingerprint ||
      hit.distance > maxDistance
    ) {
      continue;
    }
    const entry = await client.hGetAll(hit.key);
    if (!validEntry(entry, context.config.namespace, context.scope, context.contextFingerprint)) {
      continue;
    }
    const metadata = cacheEntryMetadata({
      memoryCount: entry.memoryCount,
      webSearchResultCount: entry.webSearchResultCount,
      webSearchStatus: entry.webSearchStatus
    });
    if (!metadata) {
      continue;
    }

    return {
      status: "l2_hit",
      reply: entry.reply,
      similarity: 1 - hit.distance,
      sourceKey: hit.key,
      ...metadata
    };
  }

  return null;
}

async function getRedisClient(config: SemanticCacheConfig) {
  const redisUrl = config.redisUrl;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required for semantic cache");
  }
  if (redisClientPromise && redisClientUrl === redisUrl) {
    return redisClientPromise;
  }

  const generation = redisClientGeneration + 1;
  redisClientGeneration = generation;
  redisClientUrl = redisUrl;
  const client = createClient({
    url: redisUrl,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 1_000,
    socket: {
      connectTimeout: Math.min(config.operationTimeoutMs, 5_000),
      reconnectStrategy: false
    }
  });
  client.on("error", (error) => {
    console.warn("Semantic cache Redis error", errorMessage(error));
  });
  client.on("end", () => {
    resetRedisClient(redisUrl, generation);
  });
  redisClientPromise = client
    .connect()
    .then(() => client as RedisClientType)
    .catch((error) => {
      resetRedisClient(redisUrl, generation);
      throw error;
    });
  return redisClientPromise;
}

function resetRedisClient(redisUrl: string, generation: number) {
  if (redisClientUrl === redisUrl && redisClientGeneration === generation) {
    redisClientPromise = null;
    redisClientUrl = null;
  }
}

function withCacheTimeout<T>(factory: () => Promise<T>, config: SemanticCacheConfig, operation: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`semantic cache ${operation} timed out after ${config.operationTimeoutMs}ms`));
    }, config.operationTimeoutMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
  });

  return Promise.race([factory(), timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function cacheMiss(status: "disabled" | "miss", reason: string | undefined): ConversationCacheLookup {
  return reason ? { status, reason } : { status };
}

function writeSkipped(reason: string): ConversationCacheWriteResult {
  return { status: "write_skipped", reason };
}

function writeFailed(reason: string): ConversationCacheWriteResult {
  return { status: "write_failed", reason };
}

function runCacheWriteStateMachine(context: WriteContext) {
  return new Promise<ConversationCacheWriteResult>((resolve) => {
    interpret(
      writeMachine,
      (service) => {
        const current = String(service.machine.current);
        const result = (service.context as WriteContext).result;
        if ((current === "skipped" || current === "written" || current === "failed") && result) {
          resolve(result);
        }
      },
      context
    );
  });
}

async function writeCacheEntry(context: WriteContext): Promise<ConversationCacheWriteResult> {
  return withCacheTimeout(async () => {
    const client = await getRedisClient(context.config);
    await ensureVectorIndex(client, context.config);

    const itemId = stableHash([
      context.config.namespace,
      context.scope,
      context.contextFingerprint,
      context.normalizedQuery,
      context.model
    ]);
    const itemKey = cacheItemKey(context.config, itemId);
    const exactKey = exactCacheKey(context.config, context.scope, context.contextFingerprint, context.normalizedQuery);
    await client.hSet(itemKey, {
      scope: context.scope,
      contextFingerprint: context.contextFingerprint,
      namespace: context.config.namespace,
      normalizedQuery: context.normalizedQuery,
      query: context.content,
      reply: context.reply,
      model: context.model,
      memoryCount: String(nonNegativeInteger(context.metadata.memoryCount)),
      webSearchResultCount: String(nonNegativeInteger(context.metadata.webSearchResultCount)),
      webSearchStatus: context.metadata.webSearchStatus,
      createdAt: new Date().toISOString(),
      embedding: float32VectorBuffer(context.embedding)
    });
    await Promise.all([
      client.expire(itemKey, context.config.ttlSeconds),
      context.config.l1Enabled ? client.set(exactKey, itemKey, { EX: context.config.ttlSeconds }) : Promise.resolve(null)
    ]);

    return { status: "written" };
  }, context.config, "write");
}

async function ensureVectorIndex(client: RedisClientType, config: SemanticCacheConfig) {
  const stateKey = indexStateKey(config);
  if (readyIndexes.has(stateKey) || unavailableIndexes.has(stateKey)) {
    return;
  }

  try {
    await client.sendCommand([
      "FT.CREATE",
      config.indexName,
      "ON",
      "HASH",
      "PREFIX",
      "1",
      `${config.prefix}:item:`,
      "SCHEMA",
      "namespace",
      "TAG",
      "scope",
      "TAG",
      "contextFingerprint",
      "TAG",
      "normalizedQuery",
      "TEXT",
      "query",
      "TEXT",
      "reply",
      "TEXT",
      "embedding",
      "VECTOR",
      "HNSW",
      "6",
      "TYPE",
      "FLOAT32",
      "DIM",
      String(requiredEmbeddingDimensions),
      "DISTANCE_METRIC",
      "COSINE"
    ]);
    readyIndexes.add(stateKey);
  } catch (error) {
    const message = errorMessage(error);
    if (/index already exists/i.test(message)) {
      readyIndexes.add(stateKey);
      return;
    }
    if (/unknown command|module|redisearch/i.test(message)) {
      unavailableIndexes.add(stateKey);
      return;
    }

    throw error;
  }
}

function indexStateKey(config: SemanticCacheConfig) {
  return `${config.redisUrl ?? ""}:${config.prefix}:${config.indexName}`;
}

function validEntry(
  entry: Record<string, string>,
  namespace: string,
  scope: string,
  contextFingerprint: string
): entry is Record<string, string> & { reply: string } {
  return (
    entry.namespace === namespace &&
    entry.scope === scope &&
    entry.contextFingerprint === contextFingerprint &&
    typeof entry.reply === "string" &&
    entry.reply.length > 0
  );
}

function parseSearchResponse(response: unknown) {
  if (!Array.isArray(response)) {
    return [];
  }

  const hits: Array<{
    key: string;
    namespace: string | undefined;
    scope: string | undefined;
    contextFingerprint: string | undefined;
    distance: number;
  }> = [];
  for (let index = 1; index < response.length; index += 2) {
    const key = redisValueToString(response[index]);
    const fields = response[index + 1];
    if (!key || !Array.isArray(fields)) {
      continue;
    }

    const record: Record<string, string> = {};
    for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 2) {
      const fieldName = redisValueToString(fields[fieldIndex]);
      const fieldValue = redisValueToString(fields[fieldIndex + 1]);
      if (fieldName && fieldValue !== undefined) {
        record[fieldName] = fieldValue;
      }
    }

    hits.push({
      key,
      namespace: record.namespace,
      scope: record.scope,
      contextFingerprint: record.contextFingerprint,
      distance: Number(record.distance ?? Number.POSITIVE_INFINITY)
    });
  }

  return hits.sort((left, right) => left.distance - right.distance);
}

function redisValueToString(value: unknown) {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }

  return undefined;
}

function cacheEntryMetadata(entry: {
  memoryCount?: string | undefined;
  webSearchResultCount?: string | undefined;
  webSearchStatus?: string | undefined;
}): ConversationCacheMetadata | null {
  const memoryCount = parseNonNegativeInteger(entry.memoryCount);
  const webSearchResultCount = parseNonNegativeInteger(entry.webSearchResultCount);
  if (
    memoryCount === null ||
    webSearchResultCount === null ||
    !isConversationCacheWebSearchStatus(entry.webSearchStatus)
  ) {
    return null;
  }

  return {
    memoryCount,
    webSearchResultCount,
    webSearchStatus: entry.webSearchStatus
  };
}

function isConversationCacheWebSearchStatus(value: string | undefined): value is ConversationCacheWebSearchStatus {
  return value === "skipped" || value === "completed" || value === "failed";
}

function parseNonNegativeInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function nonNegativeInteger(value: number) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function escapeTagValue(value: string) {
  return value.replace(/([\\,.<>{}[\]"':;!@#$%^&*()\-=+~\s|])/g, "\\$1");
}

function float32VectorBuffer(values: number[]) {
  const buffer = Buffer.allocUnsafe(values.length * Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < values.length; index += 1) {
    buffer.writeFloatLE(values[index] ?? 0, index * Float32Array.BYTES_PER_ELEMENT);
  }

  return buffer;
}

function exactCacheKey(config: SemanticCacheConfig, scope: string, contextFingerprint: string, normalizedQuery: string) {
  return `${config.prefix}:exact:${stableHash([config.namespace, scope, contextFingerprint, normalizedQuery])}`;
}

function cacheItemKey(config: SemanticCacheConfig, itemId: string) {
  return `${config.prefix}:item:${itemId}`;
}

function sanitizeIndexName(value: string) {
  return value.replace(/[^a-zA-Z0-9:_-]/g, "_");
}

function optionalString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function envFlag(value: string | undefined, fallback: boolean) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  return !["0", "false", "no", "off", "disabled"].includes(normalized);
}

function positiveInteger(value: string | undefined, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
