import { Queue, Worker, type Job, type Processor, type QueueOptions, type WorkerOptions } from "bullmq";

export const telegramUpdateQueueName = "raiden-telegram-updates";
export const memoryEnrichmentQueueName = "raiden-memory-enrichment";

export type TelegramUpdateJob = {
  update: Record<string, unknown>;
  updateId: number;
  receivedAt: string;
};

export type MemoryEnrichmentJob = {
  userId: string;
  displayName: string | null;
  content: string;
  reply: string;
  sourceMessageId: string;
};

export type BootQueueConfig = {
  redisUrl: string | null;
  prefix: string;
  telegramConcurrency: number;
  memoryConcurrency: number;
  enqueueTimeoutMs: number;
};

const defaultQueuePrefix = "raiden";
const defaultEnqueueTimeoutMs = 2_000;

export class BootQueueUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BootQueueUnavailableError";
  }
}

function optionalString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function positiveInteger(value: string | undefined, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.min(parsed, max);
}

export function getBootQueueConfig(env: NodeJS.ProcessEnv = process.env): BootQueueConfig {
  return {
    redisUrl: optionalString(env.REDIS_URL),
    prefix: optionalString(env.BOOT_QUEUE_PREFIX) ?? defaultQueuePrefix,
    telegramConcurrency: positiveInteger(env.BOOT_TELEGRAM_WORKER_CONCURRENCY, 1, 64),
    memoryConcurrency: positiveInteger(env.BOOT_MEMORY_WORKER_CONCURRENCY, 2, 16),
    enqueueTimeoutMs: positiveInteger(env.BOOT_QUEUE_ENQUEUE_TIMEOUT_MS, defaultEnqueueTimeoutMs, 30_000)
  };
}

export function isBootQueueConfigured(config: BootQueueConfig = getBootQueueConfig()) {
  return Boolean(config.redisUrl);
}

function workerConnection(config = getBootQueueConfig()): QueueOptions["connection"] {
  if (!config.redisUrl) {
    throw new Error("REDIS_URL is required to use Boot job queues");
  }

  return {
    url: config.redisUrl,
    maxRetriesPerRequest: null
  };
}

function producerConnection(config = getBootQueueConfig()): QueueOptions["connection"] {
  if (!config.redisUrl) {
    throw new BootQueueUnavailableError("REDIS_URL is required before updates can be queued");
  }

  return {
    url: config.redisUrl,
    connectTimeout: Math.min(config.enqueueTimeoutMs, 5_000),
    commandTimeout: config.enqueueTimeoutMs,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null
  };
}

function producerQueueOptions(config = getBootQueueConfig()): QueueOptions {
  return {
    connection: producerConnection(config),
    prefix: config.prefix
  };
}

function updateIdFromRecord(update: Record<string, unknown>) {
  const value = update.update_id;
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error("Telegram update payload is missing numeric update_id");
  }

  return Number(value);
}

export async function enqueueTelegramUpdate(update: unknown, config = getBootQueueConfig()) {
  if (!isBootQueueConfigured(config)) {
    throw new BootQueueUnavailableError("REDIS_URL is required before Telegram webhook updates can be queued");
  }
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    throw new Error("Telegram update payload must be an object");
  }

  const updateRecord = update as Record<string, unknown>;
  const updateId = updateIdFromRecord(updateRecord);
  const data: TelegramUpdateJob = {
    update: updateRecord,
    updateId,
    receivedAt: new Date().toISOString()
  };
  const queue = new Queue<TelegramUpdateJob>(telegramUpdateQueueName, producerQueueOptions(config));
  queue.on("error", () => {
    // The enqueue promise below owns producer failures so webhook callers receive a stable 503.
  });

  try {
    return await withQueueTimeout(
      queue.add("telegram.update", data, {
        jobId: `telegram-${updateId}`,
        attempts: 5,
        backoff: {
          type: "exponential",
          delay: 1_000
        },
        removeOnComplete: {
          age: 86_400,
          count: 5_000
        },
        removeOnFail: {
          age: 604_800,
          count: 10_000
        }
      }),
      config.enqueueTimeoutMs,
      "Telegram update enqueue"
    );
  } catch (error) {
    throw toQueueUnavailableError(error, "Telegram update enqueue failed");
  } finally {
    await closeProducerQueue(queue, config.enqueueTimeoutMs);
  }
}

export function createTelegramUpdateWorker(
  processor: Processor<TelegramUpdateJob, void, string>,
  config = getBootQueueConfig()
) {
  const options: WorkerOptions = {
    connection: workerConnection(config),
    prefix: config.prefix,
    concurrency: config.telegramConcurrency
  };

  return new Worker<TelegramUpdateJob, void>(telegramUpdateQueueName, processor, options);
}

export async function enqueueMemoryEnrichment(input: MemoryEnrichmentJob, config = getBootQueueConfig()) {
  if (!isBootQueueConfigured(config)) {
    return null;
  }

  const queue = new Queue<MemoryEnrichmentJob>(memoryEnrichmentQueueName, producerQueueOptions(config));
  queue.on("error", () => {
    // The caller falls back to inline memory work when the producer cannot reach Redis.
  });

  try {
    return await withQueueTimeout(
      queue.add("memory.enrich", input, {
        jobId: `memory-${input.sourceMessageId}`,
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 2_000
        },
        removeOnComplete: {
          age: 86_400,
          count: 5_000
        },
        removeOnFail: {
          age: 604_800,
          count: 10_000
        }
      }),
      config.enqueueTimeoutMs,
      "Memory enrichment enqueue"
    );
  } catch (error) {
    throw toQueueUnavailableError(error, "Memory enrichment enqueue failed");
  } finally {
    await closeProducerQueue(queue, config.enqueueTimeoutMs);
  }
}

export function createMemoryEnrichmentWorker(
  processor: (job: Job<MemoryEnrichmentJob>) => Promise<void>,
  config = getBootQueueConfig()
) {
  const options: WorkerOptions = {
    connection: workerConnection(config),
    prefix: config.prefix,
    concurrency: config.memoryConcurrency
  };

  return new Worker<MemoryEnrichmentJob, void>(memoryEnrichmentQueueName, processor, options);
}

async function withQueueTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new BootQueueUnavailableError(`${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function closeProducerQueue(queue: Queue, timeoutMs: number) {
  const closeTimeoutMs = Math.min(timeoutMs, 1_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedDisconnect = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      void queue.disconnect().finally(resolve);
    }, closeTimeoutMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
  });

  try {
    await Promise.race([queue.close(), timedDisconnect]);
  } catch {
    await queue.disconnect().catch(() => undefined);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function toQueueUnavailableError(error: unknown, fallback: string) {
  if (error instanceof BootQueueUnavailableError) {
    return error;
  }

  return new BootQueueUnavailableError(error instanceof Error ? error.message : fallback, { cause: error });
}
