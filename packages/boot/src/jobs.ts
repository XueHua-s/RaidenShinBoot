import { Queue, Worker, type Job, type Processor, type QueueOptions, type WorkerOptions } from "bullmq";

export const telegramUpdateQueueName = "raiden-telegram-updates";
export const memoryEnrichmentQueueName = "raiden-memory-enrichment";
export const imageGenerationQueueName = "raiden-image-generation";
export const reminderQueueName = "raiden-reminders";

export type TelegramUpdateJob = {
  update: Record<string, unknown>;
  updateId: number;
  receivedAt: string;
};

export type MemoryEnrichmentJob = {
  memoryModel?: string;
  userId: string;
  sourceChatId: string | null;
  sourceThreadId: string | null;
  sharedConversation: boolean;
  displayName: string | null;
  content: string;
  reply: string;
  sourceMessageId: string;
};

export type ImageGenerationJob = {
  taskId: string;
  chatId: string;
  threadId: number | null;
  statusMessageId: number;
  sourceMessageId: number;
  userId: string;
  userName: string | null;
  prompt: string;
  createdAt: string;
  cancelRequestedAt?: string | null;
};

export type ImageGenerationResult = {
  imageCount: number;
  mediaTypes: string[];
  completedAt: string;
  cancelled?: boolean;
};

export type ReminderJob = {
  taskId: string;
  chatId: string;
  threadId: number | null;
  sourceMessageId: number;
  userId: string;
  text: string;
  dueAt: string;
  createdAt: string;
};

export type EnqueuedTask<T> = {
  id: string;
  data: T;
  replayed: boolean;
};

export type BootQueueConfig = {
  redisUrl: string | null;
  prefix: string;
  telegramConcurrency: number;
  memoryConcurrency: number;
  imageConcurrency: number;
  reminderConcurrency: number;
  enqueueTimeoutMs: number;
};

const defaultQueuePrefix = "raiden";
const defaultEnqueueTimeoutMs = 2_000;
const reminderListPageSize = 100;
const maxReminderListResults = 100;

export class BootQueueUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BootQueueUnavailableError";
  }
}

export class ImageGenerationQuotaError extends Error {
  constructor(public readonly activeTaskId: string) {
    super("You already have an active image task");
    this.name = "ImageGenerationQuotaError";
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
    // Control updates use a separate grammY sequentialization key so /stop and
    // /pause can interrupt a long conversation. The BullMQ worker must also
    // admit more than one update at a time for that separation to take effect.
    telegramConcurrency: positiveInteger(env.BOOT_TELEGRAM_WORKER_CONCURRENCY, 8, 64),
    memoryConcurrency: positiveInteger(env.BOOT_MEMORY_WORKER_CONCURRENCY, 2, 16),
    imageConcurrency: positiveInteger(env.BOOT_IMAGE_WORKER_CONCURRENCY, 1, 8),
    reminderConcurrency: positiveInteger(env.BOOT_REMINDER_WORKER_CONCURRENCY, 4, 32),
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

export async function enqueueImageGeneration(input: ImageGenerationJob, config = getBootQueueConfig()) {
  if (!isBootQueueConfigured(config)) {
    throw new BootQueueUnavailableError("REDIS_URL is required before image tasks can be queued");
  }

  const queue = new Queue<ImageGenerationJob>(imageGenerationQueueName, producerQueueOptions(config));
  queue.on("error", () => undefined);

  try {
    const candidate = await withQueueTimeout(
      queue.add("image.generate", input, {
        jobId: input.taskId,
        // FIXED: Admission and quota ownership are atomic in BullMQ's add-job script.
        // Simple deduplication persists through retries and releases on removal/finalization.
        deduplication: { id: input.userId },
        attempts: 2,
        backoff: { type: "exponential", delay: 3_000 },
        removeOnComplete: { age: 86_400, count: 2_000 },
        removeOnFail: { age: 604_800, count: 5_000 }
      }),
      config.enqueueTimeoutMs,
      "Image task enqueue"
    );

    if (!candidate.id) {
      throw new Error("Image queue returned a job without an id");
    }

    if (candidate.id !== input.taskId) {
      throw new ImageGenerationQuotaError(candidate.id);
    }

    const persisted = await withQueueTimeout(
      queue.getJob(candidate.id),
      config.enqueueTimeoutMs,
      "Image task verification"
    );

    if (!persisted) {
      throw new Error("Image queue could not reload the queued job");
    }

    return {
      id: candidate.id,
      data: persisted.data,
      replayed:
        persisted.data.createdAt !== input.createdAt || persisted.data.statusMessageId !== input.statusMessageId
    } satisfies EnqueuedTask<ImageGenerationJob>;
  } catch (error) {
    if (error instanceof ImageGenerationQuotaError) {
      throw error;
    }
    throw toQueueUnavailableError(error, "Image task enqueue failed");
  } finally {
    await closeProducerQueue(queue, config.enqueueTimeoutMs);
  }
}

export function createImageGenerationWorker(
  processor: Processor<ImageGenerationJob, ImageGenerationResult, string>,
  config = getBootQueueConfig()
) {
  return new Worker<ImageGenerationJob, ImageGenerationResult, string>(imageGenerationQueueName, processor, {
    connection: workerConnection(config),
    prefix: config.prefix,
    concurrency: config.imageConcurrency
  });
}

export async function getImageGenerationTask(taskId: string, userId: string, config = getBootQueueConfig()) {
  if (!isBootQueueConfigured(config)) {
    throw new BootQueueUnavailableError("REDIS_URL is required to inspect image tasks");
  }
  const queue = new Queue<ImageGenerationJob, ImageGenerationResult>(imageGenerationQueueName, producerQueueOptions(config));
  queue.on("error", () => undefined);
  try {
    const job = await withQueueTimeout(queue.getJob(taskId), config.enqueueTimeoutMs, "Image task lookup");
    if (!job || job.data.userId !== userId) {
      return null;
    }
    return {
      taskId: job.data.taskId,
      state: await job.getState(),
      prompt: job.data.prompt,
      createdAt: job.data.createdAt,
      cancelRequestedAt: job.data.cancelRequestedAt ?? null,
      attemptsMade: job.attemptsMade,
      result: job.returnvalue ?? null
    };
  } finally {
    await closeProducerQueue(queue, config.enqueueTimeoutMs);
  }
}

export async function cancelImageGenerationTask(taskId: string, userId: string, config = getBootQueueConfig()) {
  if (!isBootQueueConfigured(config)) {
    throw new BootQueueUnavailableError("REDIS_URL is required to cancel image tasks");
  }

  const queue = new Queue<ImageGenerationJob>(imageGenerationQueueName, producerQueueOptions(config));
  queue.on("error", () => undefined);

  try {
    const job = await withQueueTimeout(queue.getJob(taskId), config.enqueueTimeoutMs, "Image task lookup");
    if (!job || job.data.userId !== userId) {
      return "not_found" as const;
    }
    const state = await job.getState();
    if (state === "active") {
      if (!job.data.cancelRequestedAt) {
        await job.updateData({
          ...job.data,
          cancelRequestedAt: new Date().toISOString()
        });
      }
      return "cancellation_requested" as const;
    }
    if (["completed", "failed"].includes(state)) {
      return state;
    }
    await job.remove();

    return "cancelled" as const;
  } finally {
    await closeProducerQueue(queue, config.enqueueTimeoutMs);
  }
}

export async function enqueueReminder(input: ReminderJob, config = getBootQueueConfig()) {
  if (!isBootQueueConfigured(config)) {
    throw new BootQueueUnavailableError("REDIS_URL is required before reminders can be queued");
  }
  const queue = new Queue<ReminderJob>(reminderQueueName, producerQueueOptions(config));
  queue.on("error", () => undefined);
  try {
    const delay = Math.max(0, new Date(input.dueAt).getTime() - Date.now());
    const candidate = await withQueueTimeout(
      queue.add("reminder.send", input, {
        jobId: input.taskId,
        delay,
        attempts: 3,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: { age: 86_400, count: 5_000 },
        removeOnFail: { age: 604_800, count: 5_000 }
      }),
      config.enqueueTimeoutMs,
      "Reminder enqueue"
    );
    if (!candidate.id) {
      throw new Error("Reminder queue returned a job without an id");
    }
    const persisted = await withQueueTimeout(
      queue.getJob(candidate.id),
      config.enqueueTimeoutMs,
      "Reminder verification"
    );
    if (!persisted) {
      throw new Error("Reminder queue could not reload the queued job");
    }
    return {
      id: candidate.id,
      data: persisted.data,
      replayed: persisted.data.createdAt !== input.createdAt || persisted.data.dueAt !== input.dueAt
    } satisfies EnqueuedTask<ReminderJob>;
  } catch (error) {
    throw toQueueUnavailableError(error, "Reminder enqueue failed");
  } finally {
    await closeProducerQueue(queue, config.enqueueTimeoutMs);
  }
}

export function createReminderWorker(processor: Processor<ReminderJob, void, string>, config = getBootQueueConfig()) {
  return new Worker<ReminderJob, void, string>(reminderQueueName, processor, {
    connection: workerConnection(config),
    prefix: config.prefix,
    concurrency: config.reminderConcurrency
  });
}

export async function listReminders(userId: string, chatId: string, config = getBootQueueConfig()) {
  if (!isBootQueueConfigured(config)) {
    throw new BootQueueUnavailableError("REDIS_URL is required to list reminders");
  }
  const queue = new Queue<ReminderJob>(reminderQueueName, producerQueueOptions(config));
  queue.on("error", () => undefined);
  try {
    const reminders: Array<{ taskId: string; text: string; dueAt: string }> = [];
    let hasMore = false;

    for (const state of ["wait", "delayed"] as const) {
      let start = 0;
      while (!hasMore) {
        const jobs = await withQueueTimeout(
          queue.getJobs(state, start, start + reminderListPageSize - 1, true),
          config.enqueueTimeoutMs,
          "Reminder list"
        );
        for (const job of jobs) {
          if (job.data.userId !== userId || job.data.chatId !== chatId) {
            continue;
          }
          reminders.push({ taskId: job.data.taskId, text: job.data.text, dueAt: job.data.dueAt });
          if (reminders.length > maxReminderListResults) {
            hasMore = true;
            break;
          }
        }
        if (jobs.length < reminderListPageSize) {
          break;
        }
        start += reminderListPageSize;
      }
      if (hasMore) {
        break;
      }
    }

    return {
      reminders: reminders
        .sort((left, right) => left.dueAt.localeCompare(right.dueAt))
        .slice(0, maxReminderListResults),
      hasMore
    };
  } finally {
    await closeProducerQueue(queue, config.enqueueTimeoutMs);
  }
}

export async function cancelReminder(taskId: string, userId: string, config = getBootQueueConfig()) {
  if (!isBootQueueConfigured(config)) {
    throw new BootQueueUnavailableError("REDIS_URL is required to cancel reminders");
  }
  const queue = new Queue<ReminderJob>(reminderQueueName, producerQueueOptions(config));
  queue.on("error", () => undefined);
  try {
    const job = await withQueueTimeout(queue.getJob(taskId), config.enqueueTimeoutMs, "Reminder lookup");
    if (!job || job.data.userId !== userId) {
      return false;
    }
    const state = await job.getState();
    if (!["waiting", "delayed", "prioritized", "paused"].includes(state)) {
      return false;
    }
    await job.remove();
    return true;
  } finally {
    await closeProducerQueue(queue, config.enqueueTimeoutMs);
  }
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
      void queue.disconnect().then(resolve, resolve);
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
