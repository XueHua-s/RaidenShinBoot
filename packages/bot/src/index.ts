import { config } from "dotenv";
import { run } from "@grammyjs/runner";
import { createRaidenBot, setRaidenBotCommands } from "./bot.js";
import { getBotEnv } from "./env.js";

config({ path: new URL("../../../.env", import.meta.url) });
config();

const env = getBotEnv();
const bot = createRaidenBot(env.BOT_TOKEN);

await setRaidenBotCommands(bot);
const info = await bot.api.getMe();
const runner = run(bot, {
  sink: {
    concurrency: env.BOT_POLLING_CONCURRENCY,
    timeout: {
      milliseconds: env.BOT_UPDATE_TIMEOUT_MS,
      handler: (update) => {
        console.warn(`Telegram update ${update.update_id} exceeded ${env.BOT_UPDATE_TIMEOUT_MS}ms in polling mode.`);
      }
    }
  }
});

process.once("SIGINT", () => {
  void runner.stop();
});
process.once("SIGTERM", () => {
  void runner.stop();
});

console.log(`RaidenShinBoot bot polling started as @${info.username}`);
