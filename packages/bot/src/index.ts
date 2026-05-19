import { config } from "dotenv";
import { Bot } from "grammy";
import { getBotEnv } from "./env.js";
import { getMemoryList, recallMemories, rememberTelegramUser, replyAsMakoto } from "./conversation.js";

config({ path: new URL("../../../.env", import.meta.url) });
config();

const env = getBotEnv();
const bot = new Bot(env.BOT_TOKEN);

bot.api.setMyCommands([
  { command: "start", description: "开始与雷电真对话" },
  { command: "help", description: "查看可用指令" },
  { command: "memory", description: "查看最近的长期记忆" },
  { command: "recall", description: "按内容检索长期记忆" }
]);

bot.command("start", async (ctx) => {
  await rememberTelegramUser(ctx);
  await ctx.reply(
    "你好，旅行者。我是真。若你愿意，我会记住那些值得留在须臾里的事，也会在下一次雷光亮起时轻轻拾起它们。"
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    [
      "可以直接发消息与我交谈。",
      "/memory 查看最近保存的长期记忆。",
      "/recall 关键词 按语义检索与你有关的记忆。"
    ].join("\n")
  );
});

bot.command("memory", async (ctx) => {
  const memories = await getMemoryList(ctx);
  if (memories.length === 0) {
    await ctx.reply("暂时还没有值得封存的记忆。慢慢来，重要的事总会自己发光。");
    return;
  }

  await ctx.reply(memories.map((memory, index) => `${index + 1}. ${memory.summary}`).join("\n"));
});

bot.command("recall", async (ctx) => {
  const query = ctx.match.trim();
  if (!query) {
    await ctx.reply("请在 /recall 后写下想寻找的内容。");
    return;
  }

  const memories = await recallMemories(ctx, query);
  if (memories.length === 0) {
    await ctx.reply("我没有找到相近的记忆。也许它还没有被我们认真说出口。");
    return;
  }

  await ctx.reply(
    memories
      .map((memory, index) => `${index + 1}. ${memory.summary}（相关度 ${memory.score.toFixed(2)}）`)
      .join("\n")
  );
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text) {
    return;
  }

  await ctx.replyWithChatAction("typing");
  const result = await replyAsMakoto(ctx, text);
  await ctx.reply(result.reply);
});

bot.catch((error) => {
  console.error("Bot error", error);
});

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());

await bot.start({
  onStart: (info) => {
    console.log(`RaidenShinBoot bot started as @${info.username}`);
  }
});
