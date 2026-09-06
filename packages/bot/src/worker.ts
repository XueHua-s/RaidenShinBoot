import { config } from "dotenv";
import { InputFile } from "grammy";
import type { Update } from "grammy/types";
import {
  createImageGenerationWorker,
  createMemoryEnrichmentWorker,
  createReminderWorker,
  createTelegramUpdateWorker,
  getEffectiveBootConfig,
  getImageGenerationTask,
  processMemoryEnrichmentJob,
  type ImageGenerationJob,
  type ImageGenerationResult
} from "@raiden/boot";
import { generateMakotoImage, generateMakotoImagePrompt } from "@raiden/shared/boot";
import { createRaidenBot, setRaidenBotCommands } from "./bot.js";
import { assertBotRuntimeMode, getBotEnv } from "./env.js";
import { decodeTelegramPhoto } from "./image-output.js";

config({ path: new URL("../../../.env", import.meta.url) });
config();

const env = getBotEnv();
assertBotRuntimeMode(env, "worker");
const bot = createRaidenBot(env.BOT_TOKEN);

await bot.init();
await setRaidenBotCommands(bot);

const telegramWorker = createTelegramUpdateWorker(async (job) => {
  await bot.handleUpdate(job.data.update as unknown as Update);
});
const memoryWorker = createMemoryEnrichmentWorker(async (job) => {
  await processMemoryEnrichmentJob(job.data);
});
const imageWorker = createImageGenerationWorker(async (job) => processImageGeneration(job));
const reminderWorker = createReminderWorker(async (job) => {
  await bot.api.sendMessage(job.data.chatId, `⏰ 提醒\n${job.data.text}`, {
    ...(job.data.threadId === null ? {} : { message_thread_id: job.data.threadId }),
    reply_parameters: {
      message_id: job.data.sourceMessageId,
      allow_sending_without_reply: true
    }
  });
});

bindWorkerLogs("telegram", telegramWorker);
bindWorkerLogs("memory", memoryWorker);
bindWorkerLogs("image", imageWorker);
bindWorkerLogs("reminder", reminderWorker);

async function processImageGeneration(job: {
  data: ImageGenerationJob;
  attemptsMade: number;
  opts: { attempts?: number };
}): Promise<ImageGenerationResult> {
  const { data } = job;
  await editImageTaskStatus(data, `图片任务正在生成\n任务：${data.taskId}`);

  if (await imageCancellationRequested(data)) {
    return finishCancelledImageTask(data);
  }

  try {
    const bootConfig = await getEffectiveBootConfig();
    let prompt = data.prompt;
    try {
      prompt = await generateMakotoImagePrompt({
        userPrompt: data.prompt,
        userName: data.userName,
        config: bootConfig
      });
    } catch (error) {
      console.warn(`Image prompt rewrite failed for ${data.taskId}; using the original prompt.`, errorMessage(error));
    }

    if (await imageCancellationRequested(data)) {
      return finishCancelledImageTask(data);
    }

    const result = await generateMakotoImage({
      prompt,
      size: "1024x1024",
      n: 1,
      config: bootConfig
    });

    if (await imageCancellationRequested(data)) {
      return finishCancelledImageTask(data);
    }
    if (result.images.length === 0) {
      throw new Error("Image provider returned no images");
    }

    for (const [index, image] of result.images.entries()) {
      const { bytes, extension } = decodeTelegramPhoto(image);
      await bot.api.sendPhoto(
        data.chatId,
        new InputFile(bytes, `raiden-${data.taskId}-${index + 1}.${extension}`),
        {
          ...(data.threadId === null ? {} : { message_thread_id: data.threadId }),
          ...(index === 0
            ? {
                caption: `画好了。愿这点温柔的雷光，正好落在你想看的地方。\n任务：${data.taskId}`,
                reply_parameters: {
                  message_id: data.sourceMessageId,
                  allow_sending_without_reply: true
                }
              }
            : {})
        }
      );
    }

    await editImageTaskStatus(data, `图片任务已完成\n任务：${data.taskId}\n图片：${result.images.length} 张`, true);
    return {
      imageCount: result.images.length,
      mediaTypes: result.images.map((image) => image.mediaType),
      completedAt: new Date().toISOString()
    };
  } catch (error) {
    const maxAttempts = job.opts.attempts ?? 1;
    const finalAttempt = job.attemptsMade + 1 >= maxAttempts;
    await editImageTaskStatus(
      data,
      finalAttempt
        ? `图片任务生成失败，请稍后重新提交\n任务：${data.taskId}`
        : `图片任务暂时失败，队列稍后会重试\n任务：${data.taskId}`,
      finalAttempt
    );
    throw error;
  }
}

async function imageCancellationRequested(data: ImageGenerationJob) {
  if (data.cancelRequestedAt) {
    return true;
  }
  try {
    const task = await getImageGenerationTask(data.taskId, data.userId);
    return Boolean(task?.cancelRequestedAt);
  } catch (error) {
    console.warn(`Could not inspect cancellation state for image task ${data.taskId}.`, errorMessage(error));
    return false;
  }
}

async function finishCancelledImageTask(data: ImageGenerationJob): Promise<ImageGenerationResult> {
  await editImageTaskStatus(data, `图片任务已取消\n任务：${data.taskId}`, true);
  return {
    imageCount: 0,
    mediaTypes: [],
    completedAt: new Date().toISOString(),
    cancelled: true
  };
}

async function editImageTaskStatus(data: ImageGenerationJob, text: string, clearKeyboard = false) {
  try {
    await bot.api.editMessageText(
      data.chatId,
      data.statusMessageId,
      text,
      clearKeyboard ? { reply_markup: { inline_keyboard: [] } } : {}
    );
  } catch (error) {
    console.warn(`Could not update image task message ${data.taskId}.`, errorMessage(error));
  }
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, "[REDACTED_TELEGRAM_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]");
}

async function shutdown() {
  await Promise.allSettled([
    telegramWorker.close(),
    memoryWorker.close(),
    imageWorker.close(),
    reminderWorker.close()
  ]);
  await bot.stop();
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

console.log(`RaidenShinBoot telegram, memory, image, and reminder workers started as @${bot.botInfo.username}`);

function bindWorkerLogs(
  name: string,
  worker:
    | ReturnType<typeof createTelegramUpdateWorker>
    | ReturnType<typeof createMemoryEnrichmentWorker>
    | ReturnType<typeof createImageGenerationWorker>
    | ReturnType<typeof createReminderWorker>
) {
  worker.on("completed", (job) => {
    console.log(`${name} job completed`, job?.id ?? "unknown");
  });
  worker.on("failed", (job, error) => {
    console.error(`${name} job failed`, job?.id ?? "unknown", errorMessage(error));
  });
  worker.on("error", (error) => {
    console.error(`${name} worker error`, errorMessage(error));
  });
}
