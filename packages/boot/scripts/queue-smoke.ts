import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import {
  cancelImageGenerationTask,
  createImageGenerationWorker,
  enqueueImageGeneration,
  enqueueReminder,
  getImageGenerationTask,
  imageGenerationQueueName,
  ImageGenerationQuotaError,
  listReminders,
  reminderQueueName,
  type BootQueueConfig,
  type ImageGenerationJob,
  type ReminderJob
} from "../src/jobs.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function imageInput(taskId: string, userId: string): ImageGenerationJob {
  return {
    taskId,
    chatId: "queue-smoke-chat",
    threadId: null,
    statusMessageId: 1,
    sourceMessageId: 1,
    userId,
    userName: "Queue Smoke",
    prompt: "queue smoke image",
    createdAt: new Date().toISOString()
  };
}

function reminderInput(taskId: string, userId: string, dueAt: string): ReminderJob {
  return {
    taskId,
    chatId: "queue-smoke-chat",
    threadId: null,
    sourceMessageId: 1,
    userId,
    text: `queue smoke reminder ${taskId}`,
    dueAt,
    createdAt: new Date().toISOString()
  };
}

async function waitForImageState(
  taskId: string,
  userId: string,
  expectedState: "completed" | "failed" | "delayed",
  config: BootQueueConfig
) {
  const deadline = Date.now() + 12_000;
  let lastState = "missing";
  while (Date.now() < deadline) {
    const task = await getImageGenerationTask(taskId, userId, config);
    lastState = task?.state ?? "missing";
    if (lastState === expectedState) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Image job ${taskId} did not reach ${expectedState}; last state was ${lastState}`);
}

async function main() {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    console.log("Queue runtime smoke skipped because REDIS_URL is not configured.");
    return;
  }

  const config: BootQueueConfig = {
    redisUrl,
    prefix: `raiden-queue-smoke-${process.pid}-${Date.now()}`,
    telegramConcurrency: 1,
    memoryConcurrency: 1,
    imageConcurrency: 1,
    reminderConcurrency: 1,
    enqueueTimeoutMs: 5_000
  };
  const queueOptions = { connection: { url: redisUrl }, prefix: config.prefix };
  const imageQueue = new Queue<ImageGenerationJob>(imageGenerationQueueName, queueOptions);
  const reminderQueue = new Queue<ReminderJob>(reminderQueueName, queueOptions);
  let worker: ReturnType<typeof createImageGenerationWorker> | null = null;

  try {
    await Promise.all([imageQueue.waitUntilReady(), reminderQueue.waitUntilReady()]);

    const quotaUserId = "queue-smoke-quota-user";
    const concurrentInputs = Array.from({ length: 8 }, () => imageInput(randomUUID(), quotaUserId));
    const concurrentResults = await Promise.allSettled(
      concurrentInputs.map((input) => enqueueImageGeneration(input, config))
    );
    const accepted = concurrentResults.filter((result) => result.status === "fulfilled");
    const rejected = concurrentResults.filter((result) => result.status === "rejected");
    assert(accepted.length === 1, "Concurrent image quota must atomically accept exactly one job");
    assert(rejected.length === concurrentInputs.length - 1, "Concurrent image quota must reject every competing job");
    const acceptedTaskId = accepted[0]?.value.id;
    const quotaError = rejected[0]?.reason;
    assert(typeof acceptedTaskId === "string", "Accepted image job must have an id");
    assert(quotaError instanceof ImageGenerationQuotaError, "Rejected image job must report the quota error");
    assert(quotaError.activeTaskId === acceptedTaskId, "Quota error must point to the active image task");
    assert(
      (await cancelImageGenerationTask(acceptedTaskId, quotaUserId, config)) === "cancelled",
      "Cancelling a waiting image job must succeed"
    );

    const afterCancellation = imageInput(randomUUID(), quotaUserId);
    await enqueueImageGeneration(afterCancellation, config);
    assert(
      (await cancelImageGenerationTask(afterCancellation.taskId, quotaUserId, config)) === "cancelled",
      "Removing an image job must release its per-user quota"
    );

    const idempotentInput = imageInput(randomUUID(), "queue-smoke-idempotent-user");
    const firstIdempotentJob = await enqueueImageGeneration(idempotentInput, config);
    const replayedIdempotentJob = await enqueueImageGeneration(
      {
        ...idempotentInput,
        statusMessageId: idempotentInput.statusMessageId + 1,
        prompt: "a replay must not replace the original image payload",
        createdAt: new Date(Date.now() + 1_000).toISOString()
      },
      config
    );
    assert(
      replayedIdempotentJob.id === firstIdempotentJob.id,
      "Re-enqueuing the same image task id must remain idempotent"
    );
    assert(
      replayedIdempotentJob.data.statusMessageId === idempotentInput.statusMessageId,
      "An image replay must return the original payload after its producer queue closes"
    );
    assert(replayedIdempotentJob.replayed, "An existing image job must be reported as a replay");
    await cancelImageGenerationTask(idempotentInput.taskId, idempotentInput.userId, config);

    const completedInput = imageInput(randomUUID(), "queue-smoke-completed-user");
    await enqueueImageGeneration(completedInput, config);
    worker = createImageGenerationWorker(
      async () => ({ imageCount: 1, mediaTypes: ["image/png"], completedAt: new Date().toISOString() }),
      config
    );
    await worker.waitUntilReady();
    await waitForImageState(completedInput.taskId, completedInput.userId, "completed", config);
    await worker.close();
    worker = null;
    const afterCompletion = imageInput(randomUUID(), completedInput.userId);
    await enqueueImageGeneration(afterCompletion, config);
    await cancelImageGenerationTask(afterCompletion.taskId, afterCompletion.userId, config);

    const failedInput = imageInput(randomUUID(), "queue-smoke-failed-user");
    await enqueueImageGeneration(failedInput, config);
    worker = createImageGenerationWorker(async () => {
      throw new Error("expected queue smoke failure");
    }, config);
    await worker.waitUntilReady();
    await waitForImageState(failedInput.taskId, failedInput.userId, "delayed", config);
    const retryAdmission = await Promise.allSettled([enqueueImageGeneration(imageInput(randomUUID(), failedInput.userId), config)]);
    assert(retryAdmission[0]?.status === "rejected" && retryAdmission[0].reason instanceof ImageGenerationQuotaError,
      "An image task awaiting retry must retain its per-user quota");
    await waitForImageState(failedInput.taskId, failedInput.userId, "failed", config);
    await worker.close();
    worker = null;
    const afterFailure = imageInput(randomUUID(), failedInput.userId);
    await enqueueImageGeneration(afterFailure, config);
    await cancelImageGenerationTask(afterFailure.taskId, afterFailure.userId, config);

    const now = Date.now();
    const idempotentReminder = reminderInput(
      randomUUID(),
      "queue-smoke-idempotent-reminder-user",
      new Date(now + 2 * 60 * 60_000).toISOString()
    );
    const firstReminderJob = await enqueueReminder(idempotentReminder, config);
    const replayedReminderJob = await enqueueReminder(
      {
        ...idempotentReminder,
        text: "a replay must not replace the original reminder payload",
        dueAt: new Date(now + 5 * 60 * 60_000).toISOString(),
        createdAt: new Date(Date.now() + 1_000).toISOString()
      },
      config
    );
    assert(replayedReminderJob.id === firstReminderJob.id, "Re-enqueuing the same reminder task id must remain idempotent");
    assert(
      replayedReminderJob.data.createdAt === idempotentReminder.createdAt &&
        replayedReminderJob.data.dueAt === idempotentReminder.dueAt,
      "A reminder replay must return the original payload after its producer queue closes"
    );
    assert(replayedReminderJob.replayed, "An existing reminder job must be reported as a replay");

    const sparseUserId = "queue-smoke-sparse-reminder-user";
    const sparseReminder = reminderInput(randomUUID(), sparseUserId, new Date(now + 3 * 60 * 60_000).toISOString());
    await enqueueReminder(sparseReminder, config);
    const decoyJobs = [
      ...Array.from({ length: 120 }, (_, index) => {
        const dueAt = new Date(now + 60 * 60_000 + index * 30_000).toISOString();
        const data = reminderInput(randomUUID(), `queue-smoke-decoy-early-${index}`, dueAt);
        return {
          name: "reminder.send",
          data,
          opts: { jobId: data.taskId, delay: new Date(dueAt).getTime() - Date.now() }
        };
      }),
      ...Array.from({ length: 120 }, (_, index) => {
        const dueAt = new Date(now + 4 * 60 * 60_000 + index * 30_000).toISOString();
        const data = reminderInput(randomUUID(), `queue-smoke-decoy-late-${index}`, dueAt);
        return {
          name: "reminder.send",
          data,
          opts: { jobId: data.taskId, delay: new Date(dueAt).getTime() - Date.now() }
        };
      })
    ];
    await reminderQueue.addBulk(decoyJobs);
    const [firstAscendingPage, firstDescendingPage] = await Promise.all([
      reminderQueue.getJobs("delayed", 0, 99, true),
      reminderQueue.getJobs("delayed", 0, 99, false)
    ]);
    assert(
      !firstAscendingPage.some((job) => job.id === sparseReminder.taskId) &&
        !firstDescendingPage.some((job) => job.id === sparseReminder.taskId),
      "Reminder pagination fixture must place the target outside either first page"
    );
    const sparseResult = await listReminders(sparseUserId, sparseReminder.chatId, config);
    assert(
      sparseResult.reminders.some((reminder) => reminder.taskId === sparseReminder.taskId),
      "Reminder listing must find a user's job beyond the first queue page"
    );

    const cappedUserId = "queue-smoke-capped-reminder-user";
    const cappedJobs = Array.from({ length: 101 }, (_, index) => {
      const dueAt = new Date(now + 6 * 60 * 60_000 + index * 60_000).toISOString();
      const data = reminderInput(randomUUID(), cappedUserId, dueAt);
      return {
        name: "reminder.send",
        data,
        opts: { jobId: data.taskId, delay: new Date(dueAt).getTime() - Date.now() }
      };
    });
    await reminderQueue.addBulk(cappedJobs);
    const cappedResult = await listReminders(cappedUserId, "queue-smoke-chat", config);
    assert(cappedResult.reminders.length === 100, "Reminder listing must cap its response at 100 jobs");
    assert(cappedResult.hasMore, "Reminder listing must report when more matching jobs exist");

    console.log("Queue runtime smoke passed.");
  } finally {
    if (worker) {
      await worker.close(true).catch(() => undefined);
    }
    await Promise.allSettled([
      imageQueue.obliterate({ force: true }),
      reminderQueue.obliterate({ force: true })
    ]);
    await Promise.allSettled([imageQueue.close(), reminderQueue.close()]);
  }
}

await main();
