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
};

const defaultQueuePrefix = "raiden";

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
    memoryConcurrency: positiveInteger(env.BOOT_MEMORY_WORKER_CONCURRENCY, 2, 16)
  };
}

export function isBootQueueConfigured(config: BootQueueConfig = getBootQueueConfig()) {
  return Boolean(config.redisUrl);
}

function connection(config = getBootQueueConfig()) {
  if (!config.redisUrl) {
    throw new Error("REDIS_URL is required to use Boot job queues");
  }

  return {
    url: config.redisUrl,
    maxRetriesPerRequest: null
  };
}

function queueOptions(config = getBootQueueConfig()): QueueOptions {
  return {
    connection: connection(config),
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
    throw new Error("REDIS_URL is required before Telegram webhook updates can be queued");
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
  const queue = new Queue<TelegramUpdateJob>(telegramUpdateQueueName, queueOptions(config));

  try {
    return await queue.add("telegram.update", data, {
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
    });
  } finally {
    await queue.close();
  }
}

export function createTelegramUpdateWorker(
  processor: Processor<TelegramUpdateJob, void, string>,
  config = getBootQueueConfig()
) {
  const options: WorkerOptions = {
    connection: connection(config),
    prefix: config.prefix,
    concurrency: config.telegramConcurrency
  };

  return new Worker<TelegramUpdateJob, void>(telegramUpdateQueueName, processor, options);
}

export async function enqueueMemoryEnrichment(input: MemoryEnrichmentJob, config = getBootQueueConfig()) {
  if (!isBootQueueConfigured(config)) {
    return null;
  }

  const queue = new Queue<MemoryEnrichmentJob>(memoryEnrichmentQueueName, queueOptions(config));

  try {
    return await queue.add("memory.enrich", input, {
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
    });
  } finally {
    await queue.close();
  }
}

export function createMemoryEnrichmentWorker(
  processor: (job: Job<MemoryEnrichmentJob>) => Promise<void>,
  config = getBootQueueConfig()
) {
  const options: WorkerOptions = {
    connection: connection(config),
    prefix: config.prefix,
    concurrency: config.memoryConcurrency
  };

  return new Worker<MemoryEnrichmentJob, void>(memoryEnrichmentQueueName, processor, options);
}
