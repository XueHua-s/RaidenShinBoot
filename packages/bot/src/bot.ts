import { Bot, InputFile, type Context } from "grammy";
import { sequentialize } from "@grammyjs/runner";
import { executeEffectiveBootTool, getEffectiveBootConfig, listEffectiveChatModels, switchEffectiveChatModel } from "@raiden/boot";
import { generateMakotoImagePrompt } from "@raiden/shared/boot";
import { formatBootToolError, type BootToolPermissionContext } from "@raiden/shared/tools";
import { enforceTelegramAccess } from "./access.js";
import { rememberTelegramUser, replyAsMakoto } from "./conversation.js";

const publicBotCommands = [
  { command: "start", description: "显示欢迎信息" },
  { command: "help", description: "查看可用指令" },
  { command: "draw", description: "直接生成图片" }
];
const hiddenCommandNames = new Set(["model"]);
const handledCommandNames = new Set([...publicBotCommands.map((command) => command.command), ...hiddenCommandNames]);
const telegramMessageBudget = 3500;

function configuredTelegramAdminIds(env: NodeJS.ProcessEnv = process.env) {
  return new Set(
    (env.BOT_ADMIN_TELEGRAM_IDS ?? "")
      .split(/[,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

export function isTelegramBotAdminId(telegramId: string | number | null | undefined, env: NodeJS.ProcessEnv = process.env) {
  return telegramId !== null && telegramId !== undefined && configuredTelegramAdminIds(env).has(String(telegramId));
}

function canSwitchTelegramModel(ctx: Context) {
  return isTelegramBotAdminId(ctx.from?.id);
}

function updateConstraint(ctx: Context) {
  if (ctx.chat?.id !== undefined) {
    return `chat:${ctx.chat.id}`;
  }
  if (ctx.from?.id !== undefined) {
    return `user:${ctx.from.id}`;
  }

  return undefined;
}

function telegramToolPermission(ctx: Context): BootToolPermissionContext {
  return {
    actorId: ctx.from?.id === undefined ? null : String(ctx.from.id),
    chatId: ctx.chat?.id === undefined ? null : String(ctx.chat.id)
  };
}

function telegramActorUsername(ctx: Context) {
  if (ctx.from?.username) {
    return `@${ctx.from.username}`;
  }

  return [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || null;
}

function trimTelegramCaption(value: string) {
  return value.length > 1000 ? `${value.slice(0, 997)}...` : value;
}

function splitTelegramText(text: string) {
  const chunks: string[] = [];
  let current = "";

  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= telegramMessageBudget) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    for (let index = 0; index < line.length; index += telegramMessageBudget) {
      const part = line.slice(index, index + telegramMessageBudget);
      if (part.length === telegramMessageBudget) {
        chunks.push(part);
      } else {
        current = part;
      }
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [text];
}

async function replyTextChunks(ctx: Context, text: string) {
  for (const chunk of splitTelegramText(text)) {
    await ctx.reply(chunk);
  }
}

async function replyGeneratedImages(ctx: Context, images: Array<{ base64: string; mediaType: string }>, caption: string) {
  if (images.length === 0) {
    await replyTextChunks(ctx, caption);
    return;
  }

  const first = images[0];
  if (!first) {
    await replyTextChunks(ctx, caption);
    return;
  }

  await ctx.replyWithPhoto(new InputFile(Buffer.from(first.base64, "base64"), "raiden-makoto.png"), {
    caption: trimTelegramCaption(caption)
  });

  for (const image of images.slice(1)) {
    await ctx.replyWithPhoto(new InputFile(Buffer.from(image.base64, "base64"), "raiden-makoto.png"));
  }
}

function formatModelListChunks(input: Awaited<ReturnType<typeof listEffectiveChatModels>>) {
  const visible = input.models.slice(0, 80);
  const lines = [
    `当前对话模型：${input.currentModel}`,
    `可用模型：${input.models.length} 个`,
    "",
    ...visible.map((model) => `- ${model.id}`)
  ];

  if (input.models.length > visible.length) {
    lines.push("", `还有 ${input.models.length - visible.length} 个模型未显示。请在后台 System 页查看完整列表。`);
  }

  lines.push("", "切换：/model <model_id>");
  return splitTelegramText(lines.join("\n"));
}

function unknownSlashCommand(text: string) {
  const command = text.match(/^\/([^\s@]+)(?:@\S+)?(?:\s|$)/)?.[1]?.toLowerCase();
  return command && !handledCommandNames.has(command) ? command : null;
}

export function createRaidenBot(token: string) {
  const bot = new Bot(token);

  bot.use(sequentialize(updateConstraint));
  bot.use(enforceTelegramAccess);

  bot.command("start", async (ctx) => {
    await rememberTelegramUser(ctx);
    await ctx.reply(
      "你好，旅行者。我是真。直接发消息就可以与我交谈；需要画面时可以说出来，也可以使用 /draw。"
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "可以直接发消息与我交谈。",
        "我会按语义自主决定是否联网搜索或生成图片。",
        "/draw 描述 直接生成图片。"
      ].join("\n")
    );
  });

  bot.command("model", async (ctx) => {
    await rememberTelegramUser(ctx);
    const modelArg = ctx.match.trim();
    await ctx.replyWithChatAction("typing");

    try {
      if (!modelArg) {
        const models = await listEffectiveChatModels();
        await replyTextChunks(ctx, [`当前对话模型：${models.currentModel}`, "查看列表：/model list", "管理员切换：/model <model_id>"].join("\n"));
        return;
      }

      if (modelArg.toLowerCase() === "list") {
        for (const chunk of formatModelListChunks(await listEffectiveChatModels())) {
          await ctx.reply(chunk);
        }
        return;
      }

      if (!canSwitchTelegramModel(ctx)) {
        await ctx.reply("只有配置在 BOT_ADMIN_TELEGRAM_IDS 的 Telegram 管理员可以切换全局对话模型。");
        return;
      }

      const result = await switchEffectiveChatModel({
        modelId: modelArg,
        actorTelegramId: ctx.from?.id === undefined ? null : String(ctx.from.id),
        actorUsername: telegramActorUsername(ctx),
        chatId: ctx.chat?.id === undefined ? null : String(ctx.chat.id)
      });
      const changed = result.beforeModel !== result.afterModel;
      await ctx.reply(changed ? `对话模型已切换：${result.beforeModel} -> ${result.afterModel}` : `当前已经是：${result.afterModel}`);
    } catch (error) {
      await ctx.reply(`模型操作失败：${error instanceof Error ? error.message : "unknown error"}`);
    }
  });

  bot.command("draw", async (ctx) => {
    const prompt = ctx.match.trim();
    if (!prompt) {
      await ctx.reply("请在 /draw 后写下想生成的画面。");
      return;
    }

    await ctx.replyWithChatAction("upload_photo");
    try {
      const bootConfig = await getEffectiveBootConfig();
      let imagePrompt = prompt;
      try {
        imagePrompt = await generateMakotoImagePrompt({
          userPrompt: prompt,
          userName: telegramActorUsername(ctx),
          config: bootConfig
        });
      } catch {
        imagePrompt = prompt;
      }
      const result = await executeEffectiveBootTool(
        "makoto_image",
        {
          prompt: imagePrompt,
          size: "1024x1024",
          n: 1
        },
        {
          permission: telegramToolPermission(ctx)
        }
      );
      const image = result.images[0];
      if (!image) {
        await ctx.reply("这一次没有生成出图片。我们换一种描述再试。");
        return;
      }

      await replyGeneratedImages(ctx, result.images, "给你，一点温柔的雷光。");
    } catch (error) {
      await ctx.reply(`图片生成暂不可用：${formatBootToolError(error)}`);
    }
  });

  bot.on("message:text", async (ctx) => {
    if (!ctx.from) {
      await ctx.reply("当前消息缺少 Telegram 用户身份，无法进入个人对话。");
      return;
    }

    const text = ctx.message.text.trim();
    if (!text) {
      return;
    }
    const unknownCommand = unknownSlashCommand(text);
    if (unknownCommand) {
      await ctx.reply(`/${unknownCommand} 没有开放。发送 /help 查看当前可用指令。`);
      return;
    }

    await ctx.replyWithChatAction("typing");
    const result = await replyAsMakoto(ctx, text);
    if (result.images.length > 0) {
      await replyGeneratedImages(ctx, result.images, result.reply);
      return;
    }

    await replyTextChunks(ctx, result.reply);
  });

  bot.catch((error) => {
    console.error("Bot error", error);
  });

  return bot;
}

export async function setRaidenBotCommands(bot: Bot) {
  await bot.api.setMyCommands(publicBotCommands);
}
