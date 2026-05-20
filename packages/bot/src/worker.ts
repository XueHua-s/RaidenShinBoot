import { config } from "dotenv";
import type { Update } from "grammy/types";
import {
  createMemoryEnrichmentWorker,
  createTelegramUpdateWorker,
  processMemoryEnrichmentJob
} from "@raiden/boot";
import { createRaidenBot, setRaidenBotCommands } from "./bot.js";
import { getBotEnv } from "./env.js";

config({ path: new URL("../../../.env", import.meta.url) });
config();

const env = getBotEnv();
const bot = createRaidenBot(env.BOT_TOKEN);

await setRaidenBotCommands(bot);
await bot.init();

const telegramWorker = createTelegramUpdateWorker(async (job) => {
  await bot.handleUpdate(job.data.update as unknown as Update);
});
const memoryWorker = createMemoryEnrichmentWorker(async (job) => {
  await processMemoryEnrichmentJob(job.data);
});

bindWorkerLogs("telegram", telegramWorker);
bindWorkerLogs("memory", memoryWorker);

async function shutdown() {
  await Promise.allSettled([telegramWorker.close(), memoryWorker.close()]);
  bot.stop();
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

console.log(`RaidenShinBoot workers started as @${bot.botInfo.username}`);

function bindWorkerLogs(
  name: string,
  worker: ReturnType<typeof createTelegramUpdateWorker> | ReturnType<typeof createMemoryEnrichmentWorker>
) {
  worker.on("completed", (job) => {
    console.log(`${name} job completed`, job?.id ?? "unknown");
  });
  worker.on("failed", (job, error) => {
    console.error(`${name} job failed`, job?.id ?? "unknown", error.message);
  });
  worker.on("error", (error) => {
    console.error(`${name} worker error`, error.message);
  });
}
