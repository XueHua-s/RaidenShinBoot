import { Bot, InlineKeyboard, type Context } from "grammy";
import { sequentialize } from "@grammyjs/runner";
import {
  cancelImageGenerationTask,
  cancelReminder,
  enqueueImageGeneration,
  enqueueReminder,
  getEffectiveBootConfig,
  getImageGenerationTask,
  ImageGenerationQuotaError,
  isBootQueueConfigured,
  listEffectiveChatModels,
  listEffectiveImageModels,
  listReminders,
  switchEffectiveChatModel,
  switchEffectiveImageModel
} from "@raiden/boot";
import { updateTelegramChat } from "@raiden/database";
import { shouldUseExplicitMakotoImageForMessage } from "@raiden/shared/boot";
import { enforceTelegramAccess, getTelegramAccess } from "./access.js";
import {
  clearCurrentConversation,
  forgetAllMemories,
  getMemoryList,
  getPrivacyMode,
  rememberTelegramUser,
  replyAsMakoto,
  setPrivacyMode,
  summarizeCurrentConversation
} from "./conversation.js";
import {
  containsTelegramReplyKeyword,
  parseTelegramReplyKeywords,
  TelegramInteractionPolicy
} from "./interaction-policy.js";
import { telegramTaskId } from "./task-id.js";
import { telegramRequestScope, telegramUpdateConstraint } from "./update-constraint.js";

const publicBotCommands = [
  { command: "start", description: "开始与真对话" },
  { command: "menu", description: "打开功能菜单" },
  { command: "help", description: "查看使用说明" },
  { command: "draw", description: "创建图片任务" },
  { command: "memory", description: "查看我的记忆" },
  { command: "privacy", description: "管理记忆隐私" },
  { command: "clear", description: "清空当前会话" },
  { command: "remind", description: "创建定时提醒" },
  { command: "timers", description: "查看我的提醒" },
  { command: "cancel", description: "取消任务或提醒" },
  { command: "stop", description: "停止当前回复" },
  { command: "resume", description: "恢复新回复" }
];

const groupBotCommands = [
  { command: "start", description: "开始与真对话" },
  { command: "menu", description: "打开功能菜单" },
  { command: "help", description: "查看使用说明" },
  { command: "draw", description: "创建图片任务" },
  { command: "remind", description: "创建定时提醒" },
  { command: "timers", description: "查看我的提醒" },
  { command: "cancel", description: "取消任务或提醒" },
  { command: "stop", description: "停止当前回复" },
  { command: "summary", description: "总结当前群聊" }
];

const groupAdminCommands = [
  ...groupBotCommands,
  { command: "clear", description: "清空当前群聊上下文" },
  { command: "quiet", description: "切换到安静模式" },
  { command: "replymode", description: "设置群回复模式" },
  { command: "imgcfg", description: "查看群图片配置" },
  { command: "pause", description: "暂停群内回复" },
  { command: "resume", description: "恢复群内回复" }
];

const botAdminCommands = [
  ...publicBotCommands,
  { command: "model", description: "管理全局模型" },
  { command: "provider", description: "查看模型目录" },
  { command: "status", description: "查看安全运行状态" }
];

const handledCommandNames = new Set(
  [...groupAdminCommands, ...botAdminCommands].map((command) => command.command)
);
const telegramMessageBudget = 3500;
const maxPausedScopes = 10_000;
const reactionChoices = ["❤", "👍", "🔥", "🥰"] as const;

type ActiveRequest = { controller: AbortController; userId: string };

function configuredBotAdmins() {
  return new Set(
    (process.env.BOT_ADMIN_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function isBotAdmin(ctx: Context) {
  return ctx.from?.id !== undefined && configuredBotAdmins().has(String(ctx.from.id));
}

async function requireBotAdmin(ctx: Context) {
  if (isBotAdmin(ctx)) {
    return true;
  }
  await ctx.reply("此操作仅限 Bot 管理员。请在 BOT_ADMIN_IDS 中配置 Telegram 用户 ID。");
  return false;
}

async function isGroupAdmin(ctx: Context) {
  if (isBotAdmin(ctx)) {
    return true;
  }
  if (!ctx.chat || ctx.chat.type === "private" || !ctx.from) {
    return false;
  }
  try {
    const member = await ctx.getChatMember(ctx.from.id);
    return member.status === "creator" || member.status === "administrator";
  } catch {
    return false;
  }
}

async function requireGroupAdmin(ctx: Context) {
  if (await isGroupAdmin(ctx)) {
    return true;
  }
  await ctx.reply("此操作仅限当前群的管理员。");
  return false;
}

function telegramActorName(ctx: Context) {
  if (ctx.from?.username) {
    return `@${ctx.from.username}`;
  }
  return [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || null;
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

function unknownSlashCommand(text: string) {
  const command = text.match(/^\/([^\s@]+)(?:@\S+)?(?:\s|$)/)?.[1]?.toLowerCase();
  return command && !handledCommandNames.has(command) ? command : null;
}

async function mainMenu(ctx: Context) {
  const keyboard = new InlineKeyboard().text("💬 与真聊天", "menu:chat").text("🎨 画一幅画", "menu:draw").row();
  if (ctx.chat?.type === "private") {
    keyboard
      .text("🧠 我的记忆", "menu:memory")
      .text("🔒 隐私设置", "menu:privacy")
      .row()
      .text("⏰ 定时提醒", "menu:timers")
      .text("❔ 帮助", "menu:help");
  } else {
    keyboard.text("⏰ 定时提醒", "menu:timers").text("📝 群聊总结", "menu:summary").row().text("❔ 帮助", "menu:help");
    if (await isGroupAdmin(ctx)) {
      keyboard.text("⚙️ 群设置", "menu:group");
    }
  }
  await ctx.reply("想做什么？我在这里。", { reply_markup: keyboard });
}

function privacyKeyboard() {
  return new InlineKeyboard()
    .text("普通", "privacy:normal")
    .text("隔离", "privacy:isolated")
    .text("关闭记忆", "privacy:off")
    .row()
    .text("忘记我的全部记忆", "privacy:forget:confirm");
}

function taskKeyboard(taskId: string) {
  return new InlineKeyboard()
    .text("查看详情", `image:detail:${taskId}`)
    .text("取消", `image:cancel:${taskId}`);
}

function isPrivateChat(ctx: Context) {
  return ctx.chat?.type === "private";
}

async function requirePrivateChat(ctx: Context) {
  if (isPrivateChat(ctx)) {
    return true;
  }
  await ctx.reply("记忆详情和隐私设置只在私聊中显示，请私聊我后再使用这个功能。");
  return false;
}

function formatMemoryList(memories: Awaited<ReturnType<typeof getMemoryList>>) {
  if (memories.length === 0) {
    return "目前没有可见的长期记忆。";
  }
  return [
    `我目前保存了 ${memories.length} 条与你有关的记忆：`,
    "",
    ...memories.map(
      (memory, index) =>
        `${index + 1}. ${memory.summary}\n   ${memory.kind} · ${memory.scope} · 置信度 ${memory.confidence}%`
    )
  ].join("\n");
}

function formatModelCatalog(catalog: Awaited<ReturnType<typeof listEffectiveChatModels>>, title: string) {
  return [
    `${title}：${catalog.currentModel}`,
    `目录共 ${catalog.models.length} 个 · ${catalog.cacheStatus}`,
    `更新时间：${new Date(catalog.fetchedAt).toLocaleString("zh-CN")}`,
    `来源：${catalog.source}`,
    "",
    ...catalog.models.map((model) => `• ${model.id}`)
  ].join("\n");
}

async function queueImageTask(ctx: Context, prompt: string) {
  if (!ctx.chat || !ctx.from || !ctx.message) {
    return;
  }
  const taskId = telegramTaskId({
    kind: "image",
    chatId: String(ctx.chat.id),
    messageId: ctx.message.message_id,
    userId: String(ctx.from.id)
  });
  const status = await ctx.reply(`图片任务正在入队\n任务：${taskId}`, { reply_markup: taskKeyboard(taskId) });
  try {
    const job = await enqueueImageGeneration({
      taskId,
      chatId: String(ctx.chat.id),
      threadId: ctx.msg?.message_thread_id ?? null,
      statusMessageId: status.message_id,
      sourceMessageId: ctx.message.message_id,
      userId: String(ctx.from.id),
      userName: telegramActorName(ctx),
      prompt,
      createdAt: new Date().toISOString()
    });
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, `${job.replayed ? "同一图片任务已经存在" : "图片任务已排队"}\n任务：${taskId}`, {
      reply_markup: taskKeyboard(taskId)
    });
  } catch (error) {
    if (error instanceof ImageGenerationQuotaError) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        `你已有图片任务正在等待或生成\n任务：${error.activeTaskId}`,
        { reply_markup: taskKeyboard(error.activeTaskId) }
      );
      return;
    }
    console.error("Image task enqueue failed", safeErrorMessage(error));
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, "图片队列暂不可用（IMAGE_QUEUE_UNAVAILABLE）。", {
      reply_markup: { inline_keyboard: [] }
    });
  }
}

function parseReminder(value: string) {
  const match = value.trim().match(/^(\d+)(m|h|d)\s+([\s\S]{1,1000})$/i);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  const delay = amount * multiplier;
  if (!Number.isSafeInteger(delay) || delay < 60_000 || delay > 30 * 86_400_000) {
    return null;
  }
  return { delay, text: match[3]?.trim() ?? "" };
}

async function showTimers(ctx: Context) {
  if (!ctx.chat || !ctx.from) {
    return;
  }
  try {
    const result = await listReminders(String(ctx.from.id), String(ctx.chat.id));
    if (result.reminders.length === 0) {
      await ctx.reply("当前会话中没有你的待触发提醒。使用 /remind 10m 提醒内容 创建。");
      return;
    }
    await replyTextChunks(
      ctx,
      [
        result.hasMore
          ? `待触发提醒很多，显示最早的 ${result.reminders.length} 个：`
          : `待触发提醒 ${result.reminders.length} 个：`,
        ...result.reminders.map(
          (timer) => `• ${timer.taskId}\n  ${new Date(timer.dueAt).toLocaleString("zh-CN")} · ${timer.text}`
        )
      ].join("\n")
    );
  } catch (error) {
    console.error("Reminder list failed", safeErrorMessage(error));
    await ctx.reply("提醒队列暂不可用（REMINDER_QUEUE_UNAVAILABLE）。");
  }
}

function directMention(ctx: Context, text: string) {
  const username = ctx.me.username;
  return Boolean(username && text.toLowerCase().includes(`@${username.toLowerCase()}`));
}

function replyToBot(ctx: Context) {
  return ctx.message?.reply_to_message?.from?.id === ctx.me.id;
}

function stripBotMention(ctx: Context, text: string) {
  const username = ctx.me.username;
  return username ? text.replace(new RegExp(`@${username}\\b`, "gi"), "").trim() : text;
}

function pauseScope(scopes: Set<string>, scope: string) {
  scopes.delete(scope);
  scopes.add(scope);
  if (scopes.size <= maxPausedScopes) {
    return;
  }
  const oldestScope = scopes.values().next().value;
  if (oldestScope !== undefined) {
    scopes.delete(oldestScope);
  }
}

export function createRaidenBot(token: string) {
  const bot = new Bot(token);
  const activeRequests = new Map<string, ActiveRequest>();
  const pausedScopes = new Set<string>();
  const interactionPolicy = new TelegramInteractionPolicy();
  const replyKeywords = parseTelegramReplyKeywords(process.env.BOT_REPLY_KEYWORDS);

  bot.use(sequentialize(telegramUpdateConstraint));
  bot.use(enforceTelegramAccess);

  bot.command("start", async (ctx) => {
    await rememberTelegramUser(ctx);
    await ctx.reply("你好，旅行者。我是真。对话、记忆、画图与提醒都可以从 /menu 开始。");
    await mainMenu(ctx);
  });

  bot.command("menu", mainMenu);

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "直接私聊我即可对话；群聊中请回复我、@我，或用“雷电真/真姐姐/真大人/阿真”唤醒。",
        "/draw 描述 — 创建异步图片任务",
        "/memory — 查看长期记忆（仅私聊）",
        "/privacy normal|isolated|off|forget — 管理记忆",
        "/clear — 清空当前聊天或话题的近期上下文",
        "/remind 10m 内容 — 创建提醒，支持 m/h/d，最长 30 天",
        "/stop — 停止当前正在生成的回复",
        "/pause 与 /resume — 暂停并恢复新回复（群聊仅管理员）",
        "群管理员可用 /replymode mention_only|social|quiet。"
      ].join("\n")
    );
  });

  bot.command("memory", async (ctx) => {
    if (!(await requirePrivateChat(ctx))) {
      return;
    }
    const [mode, memories] = await Promise.all([getPrivacyMode(ctx), getMemoryList(ctx)]);
    await replyTextChunks(ctx, `当前隐私模式：${mode}\n\n${formatMemoryList(memories)}`);
  });

  bot.command("privacy", async (ctx) => {
    if (!(await requirePrivateChat(ctx))) {
      return;
    }
    const action = ctx.match.trim().toLowerCase();
    if (!action) {
      await ctx.reply(`当前隐私模式：${await getPrivacyMode(ctx)}`, { reply_markup: privacyKeyboard() });
      return;
    }
    if (action === "forget") {
      await ctx.reply("确认删除全部长期记忆？", {
        reply_markup: new InlineKeyboard().text("确认删除", "privacy:forget:execute").text("取消", "privacy:forget:cancel")
      });
      return;
    }
    if (!(["normal", "isolated", "off"] as const).includes(action as "normal" | "isolated" | "off")) {
      await ctx.reply("用法：/privacy normal|isolated|off|forget");
      return;
    }
    const mode = action as "normal" | "isolated" | "off";
    await setPrivacyMode(ctx, mode);
    await ctx.reply(`隐私模式已设为 ${mode}。off 会停止长期记忆的召回与写入。`);
  });

  bot.command("clear", async (ctx) => {
    if (ctx.chat.type !== "private" && !(await requireGroupAdmin(ctx))) {
      return;
    }
    const deleted = await clearCurrentConversation(ctx);
    await ctx.reply(`当前会话上下文已清空，共删除 ${deleted} 条近期消息；长期记忆不受影响。`);
  });

  bot.command("summary", async (ctx) => {
    if (ctx.chat.type === "private") {
      await ctx.reply("这个命令用于群聊或群话题。");
      return;
    }
    await ctx.replyWithChatAction("typing");
    try {
      await replyTextChunks(ctx, await summarizeCurrentConversation(ctx));
    } catch (error) {
      console.error("Conversation summary failed", safeErrorMessage(error));
      await ctx.reply("暂时无法生成群聊摘要（SUMMARY_UNAVAILABLE）。");
    }
  });

  bot.command("replymode", async (ctx) => {
    if (ctx.chat.type === "private" || !(await requireGroupAdmin(ctx))) {
      return;
    }
    const mode = ctx.match.trim().toLowerCase();
    if (!(["mention_only", "social", "quiet"] as const).includes(mode as "mention_only" | "social" | "quiet")) {
      await ctx.reply("用法：/replymode mention_only|social|quiet");
      return;
    }
    await updateTelegramChat(String(ctx.chat.id), { replyMode: mode as "mention_only" | "social" | "quiet" });
    await ctx.reply(`群回复模式已设为 ${mode}。`);
  });

  bot.command("quiet", async (ctx) => {
    if (ctx.chat.type === "private" || !(await requireGroupAdmin(ctx))) {
      return;
    }
    await updateTelegramChat(String(ctx.chat.id), { replyMode: "quiet" });
    await ctx.reply("已切换到安静模式；仍会处理命令、直接回复和明确 @。");
  });

  bot.command("pause", async (ctx) => {
    if (ctx.chat.type !== "private" && !(await requireGroupAdmin(ctx))) {
      return;
    }
    const scope = telegramRequestScope(ctx);
    pauseScope(pausedScopes, scope);
    activeRequests.get(scope)?.controller.abort();
    await ctx.reply("当前会话已暂停，新消息会等待 /resume。");
  });

  bot.command("stop", async (ctx) => {
    const scope = telegramRequestScope(ctx);
    const active = activeRequests.get(scope);
    if (ctx.chat.type !== "private" && active?.userId !== String(ctx.from?.id) && !(await isGroupAdmin(ctx))) {
      await ctx.reply("只有当前请求发起者或群管理员可以停止它。");
      return;
    }
    active?.controller.abort();
    await ctx.reply(active ? "已停止当前回复；可以继续发送新消息。" : "当前没有正在生成的回复。");
  });

  bot.command("resume", async (ctx) => {
    if (ctx.chat.type !== "private" && !(await requireGroupAdmin(ctx))) {
      return;
    }
    pausedScopes.delete(telegramRequestScope(ctx));
    await ctx.reply("已恢复，新消息可以继续处理。");
  });

  bot.command("draw", async (ctx) => {
    const prompt = ctx.match.trim();
    if (!prompt) {
      await ctx.reply("请在 /draw 后写下想生成的画面。");
      return;
    }
    await queueImageTask(ctx, prompt);
  });

  bot.command("remind", async (ctx) => {
    if (!ctx.chat || !ctx.from || !ctx.message) {
      return;
    }
    const parsed = parseReminder(ctx.match);
    if (!parsed) {
      await ctx.reply("用法：/remind 10m 提醒内容。支持 m、h、d，范围 1 分钟到 30 天。");
      return;
    }
    const taskId = telegramTaskId({
      kind: "reminder",
      chatId: String(ctx.chat.id),
      messageId: ctx.message.message_id,
      userId: String(ctx.from.id)
    });
    const createdAt = new Date().toISOString();
    const dueAt = new Date(Date.now() + parsed.delay).toISOString();
    try {
      const job = await enqueueReminder({
        taskId,
        chatId: String(ctx.chat.id),
        threadId: ctx.msg?.message_thread_id ?? null,
        sourceMessageId: ctx.message.message_id,
        userId: String(ctx.from.id),
        text: parsed.text,
        dueAt,
        createdAt
      });
      await ctx.reply(
        `${job.replayed ? "同一提醒已经存在" : "提醒已创建"}：${new Date(job.data.dueAt).toLocaleString("zh-CN")}\n任务：${taskId}`
      );
    } catch (error) {
      console.error("Reminder enqueue failed", safeErrorMessage(error));
      await ctx.reply("提醒队列暂不可用（REMINDER_QUEUE_UNAVAILABLE）。");
    }
  });

  bot.command("timers", showTimers);

  bot.command("cancel", async (ctx) => {
    if (!ctx.from) {
      return;
    }
    const taskId = ctx.match.trim();
    if (!taskId) {
      await ctx.reply("请提供任务 ID：/cancel <task_id>");
      return;
    }
    try {
      const imageState = await cancelImageGenerationTask(taskId, String(ctx.from.id));
      if (imageState !== "not_found") {
        const message =
          imageState === "cancelled"
            ? "图片任务已取消。"
            : imageState === "cancellation_requested"
              ? "已请求取消；当前生成阶段结束后不会发送图片。"
              : imageState === "completed"
                ? "图片任务已经完成，无法取消。"
                : "图片任务已经失败，无需取消。";
        await ctx.reply(message);
        return;
      }
      const reminderCancelled = await cancelReminder(taskId, String(ctx.from.id));
      await ctx.reply(reminderCancelled ? "提醒已取消。" : "没有找到属于你的可取消任务。");
    } catch (error) {
      console.error("Task cancellation failed", safeErrorMessage(error));
      await ctx.reply("任务队列暂不可用（TASK_QUEUE_UNAVAILABLE）。");
    }
  });

  bot.command("model", async (ctx) => {
    if (!(await requireBotAdmin(ctx))) {
      return;
    }
    const [kindRaw, ...rest] = ctx.match.trim().split(/\s+/).filter(Boolean);
    const kind = kindRaw?.toLowerCase();
    try {
      if (!kind) {
        const [chat, image] = await Promise.all([listEffectiveChatModels(), listEffectiveImageModels()]);
        await ctx.reply(`对话：${chat.currentModel}\n图片：${image.currentModel}\n/model list chat|image\n/model chat|image <model_id>`);
        return;
      }
      if (kind === "list") {
        const capability = rest[0]?.toLowerCase() === "image" ? "image" : "chat";
        const catalog = capability === "image" ? await listEffectiveImageModels(true) : await listEffectiveChatModels(true);
        await replyTextChunks(ctx, formatModelCatalog(catalog, capability === "image" ? "当前图片模型" : "当前对话模型"));
        return;
      }
      const imageSelection = kind === "image";
      const modelId = imageSelection || kind === "chat" ? rest.join(" ") : [kindRaw, ...rest].join(" ");
      if (!modelId) {
        await ctx.reply("用法：/model chat|image <model_id>");
        return;
      }
      const actor = {
        modelId,
        actorTelegramId: ctx.from?.id === undefined ? null : String(ctx.from.id),
        actorUsername: telegramActorName(ctx),
        chatId: ctx.chat?.id === undefined ? null : String(ctx.chat.id)
      };
      const result = imageSelection ? await switchEffectiveImageModel(actor) : await switchEffectiveChatModel(actor);
      await ctx.reply(
        result.beforeModel === result.afterModel
          ? `当前已经是：${result.afterModel}`
          : `模型已切换：${result.beforeModel} → ${result.afterModel}`
      );
    } catch (error) {
      console.error("Admin model operation failed", safeErrorMessage(error));
      await ctx.reply("模型操作失败。请在后台 System 页查看目录或服务日志（MODEL_OPERATION_FAILED）。");
    }
  });

  bot.command("provider", async (ctx) => {
    if (!(await requireBotAdmin(ctx))) {
      return;
    }
    try {
      const [chat, image] = await Promise.all([listEffectiveChatModels(true), listEffectiveImageModels(true)]);
      await ctx.reply(
        `目录来源：${chat.source}\n语言模型：${chat.models.length}\n图片模型：${image.models.length}\n目录状态：${chat.cacheStatus}\n更新时间：${new Date(chat.fetchedAt).toLocaleString("zh-CN")}`
      );
    } catch (error) {
      console.error("Provider status failed", safeErrorMessage(error));
      await ctx.reply("无法读取模型目录（MODEL_CATALOG_UNAVAILABLE）。");
    }
  });

  bot.command("status", async (ctx) => {
    if (!(await requireBotAdmin(ctx))) {
      return;
    }
    const config = await getEffectiveBootConfig();
    await ctx.reply(
      [
        "RaidenShinBoot 正在运行",
        `对话模型：${config.BOOT_CHAT_MODEL}`,
        `总结/记忆/工具：${config.BOOT_SUMMARY_MODEL} / ${config.BOOT_MEMORY_MODEL} / ${config.BOOT_TOOL_MODEL}`,
        `图片模型：${config.BOOT_IMAGE_MODEL}`,
        `本地嵌入：${config.BOOT_EMBEDDING_MODEL} (${config.BOOT_EMBEDDING_DIMENSIONS} 维)`,
        `人格：${config.PERSONA_ID} v${config.PERSONA_VERSION} #${config.PERSONA_HASH.slice(0, 12)}`,
        `异步队列：${isBootQueueConfigured() ? "已配置" : "未配置"}`
      ].join("\n")
    );
  });

  bot.command("imgcfg", async (ctx) => {
    if (ctx.chat.type !== "private" && !(await requireGroupAdmin(ctx))) {
      return;
    }
    const models = await listEffectiveImageModels();
    await ctx.reply(`当前图片模型：${models.currentModel}\n可选图片模型：${models.models.length} 个\n图片任务使用独立队列。`);
  });

  bot.callbackQuery(/^menu:(chat|draw|memory|privacy|timers|summary|help|group)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const action = ctx.match[1];
    if (action === "chat") {
      await ctx.reply("直接说吧。我会记住当前聊天或话题的上下文。");
    } else if (action === "draw") {
      await ctx.reply("发送 /draw 加画面描述，我会把它放进独立图片队列。");
    } else if (action === "memory") {
      if (await requirePrivateChat(ctx)) {
        await replyTextChunks(ctx, formatMemoryList(await getMemoryList(ctx)));
      }
    } else if (action === "privacy") {
      if (await requirePrivateChat(ctx)) {
        await ctx.reply(`当前隐私模式：${await getPrivacyMode(ctx)}`, { reply_markup: privacyKeyboard() });
      }
    } else if (action === "timers") {
      await showTimers(ctx);
    } else if (action === "summary") {
      await ctx.reply("在群聊中发送 /summary，我会总结当前群或话题的近期对话。");
    } else if (action === "group") {
      if (await requireGroupAdmin(ctx)) {
        await ctx.reply("群回复模式：/replymode mention_only|social|quiet\n暂停与恢复：/pause、/resume\n图片配置：/imgcfg");
      }
    } else {
      await ctx.reply("发送 /help 查看完整说明。");
    }
  });

  bot.callbackQuery(/^privacy:(normal|isolated|off)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await requirePrivateChat(ctx))) {
      return;
    }
    await setPrivacyMode(ctx, ctx.match[1] as "normal" | "isolated" | "off");
    await ctx.reply(`隐私模式已设为 ${ctx.match[1]}。`);
  });

  bot.callbackQuery("privacy:forget:confirm", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await requirePrivateChat(ctx))) {
      return;
    }
    await ctx.reply("确认删除全部长期记忆？", {
      reply_markup: new InlineKeyboard().text("确认删除", "privacy:forget:execute").text("取消", "privacy:forget:cancel")
    });
  });

  bot.callbackQuery("privacy:forget:execute", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (await requirePrivateChat(ctx)) {
      const deleted = await forgetAllMemories(ctx);
      await ctx.editMessageText(`已删除 ${deleted} 条属于你的长期记忆。`, {
        reply_markup: { inline_keyboard: [] }
      });
    }
  });

  bot.callbackQuery("privacy:forget:cancel", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "已取消" });
    await ctx.editMessageText("已取消删除长期记忆。", { reply_markup: { inline_keyboard: [] } });
  });

  bot.callbackQuery(/^image:detail:([0-9a-f-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) {
      return;
    }
    const taskId = ctx.match[1];
    if (!taskId) {
      return;
    }
    try {
      const task = await getImageGenerationTask(taskId, String(ctx.from.id));
      await ctx.reply(
        task
          ? `图片任务：${task.taskId}\n状态：${task.cancelRequestedAt ? "正在取消" : task.state}\n尝试次数：${task.attemptsMade}\n创建：${new Date(task.createdAt).toLocaleString("zh-CN")}\n描述：${task.prompt.slice(0, 500)}`
          : "没有找到属于你的图片任务。"
      );
    } catch (error) {
      console.error("Image task lookup failed", safeErrorMessage(error));
      await ctx.reply("暂时无法读取任务详情（TASK_LOOKUP_UNAVAILABLE）。");
    }
  });

  bot.callbackQuery(/^image:cancel:([0-9a-f-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) {
      return;
    }
    const taskId = ctx.match[1];
    if (!taskId) {
      return;
    }
    try {
      const state = await cancelImageGenerationTask(taskId, String(ctx.from.id));
      if (state === "cancelled") {
        await ctx.editMessageText(`图片任务已取消\n任务：${taskId}`, {
          reply_markup: { inline_keyboard: [] }
        });
        return;
      }
      if (state === "cancellation_requested") {
        await ctx.editMessageReplyMarkup({
          reply_markup: new InlineKeyboard().text("查看详情", `image:detail:${taskId}`)
        });
        await ctx.reply("已请求取消；当前生成阶段结束后不会发送图片。");
        return;
      }
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      await ctx.reply(
        state === "completed"
          ? "图片任务已经完成，无法取消。"
          : state === "failed"
            ? "图片任务已经失败，无需取消。"
            : "没有找到属于你的图片任务。"
      );
    } catch (error) {
      console.error("Image task cancellation failed", safeErrorMessage(error));
      await ctx.reply("暂时无法取消任务（TASK_CANCEL_UNAVAILABLE）。");
    }
  });

  bot.on("message:text", async (ctx) => {
    if (!ctx.from || ctx.from.is_bot) {
      return;
    }
    const rawText = ctx.message.text.trim();
    if (!rawText) {
      return;
    }
    const unknownCommand = unknownSlashCommand(rawText);
    if (unknownCommand) {
      await ctx.reply(`/${unknownCommand} 没有开放。发送 /help 查看当前可用指令。`);
      return;
    }

    if (ctx.chat.type !== "private") {
      const mentioned = directMention(ctx, rawText);
      const replied = replyToBot(ctx);
      const wakeWord = containsTelegramReplyKeyword(rawText, replyKeywords);
      const decision = interactionPolicy.decide({
        chatId: String(ctx.chat.id),
        userId: String(ctx.from.id),
        messageId: ctx.message.message_id,
        text: rawText,
        replyMode: getTelegramAccess(ctx)?.chat.replyMode ?? "mention_only",
        directlyMentioned: mentioned,
        replyingToBot: replied,
        wakeWord
      });
      if (decision === "ignore") {
        return;
      }
      if (!mentioned && !replied && !wakeWord && (await getPrivacyMode(ctx)) === "off") {
        return;
      }
      if (decision === "react") {
        const reaction = reactionChoices[ctx.message.message_id % reactionChoices.length] ?? "❤";
        await ctx.react(reaction).catch(() => undefined);
        return;
      }
    }

    const scope = telegramRequestScope(ctx);
    if (pausedScopes.has(scope)) {
      await ctx.reply("当前会话已暂停；发送 /resume 后再继续。");
      return;
    }
    const text = stripBotMention(ctx, rawText) || "在吗？";
    if (shouldUseExplicitMakotoImageForMessage(text)) {
      await queueImageTask(ctx, text);
      return;
    }

    const controller = new AbortController();
    activeRequests.set(scope, { controller, userId: String(ctx.from.id) });
    await ctx.replyWithChatAction("typing");
    try {
      const result = await replyAsMakoto(ctx, text, controller.signal);
      await replyTextChunks(ctx, result.reply);
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      } else {
        console.error("Conversation failed", safeErrorMessage(error));
        await ctx.reply("暂时无法生成回复，请稍后再试（CHAT_UNAVAILABLE）。");
      }
    } finally {
      if (activeRequests.get(scope)?.controller === controller) {
        activeRequests.delete(scope);
      }
    }
  });

  bot.catch((error) => {
    console.error("Bot update failed", safeErrorMessage(error.error));
  });

  return bot;
}

function safeErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, "[REDACTED_TELEGRAM_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]");
}

export async function setRaidenBotCommands(bot: Bot) {
  await Promise.all([
    bot.api.setMyCommands(publicBotCommands),
    bot.api.setMyCommands(groupBotCommands, { scope: { type: "all_group_chats" } }),
    bot.api.setMyCommands(groupAdminCommands, { scope: { type: "all_chat_administrators" } })
  ]);

  for (const adminId of configuredBotAdmins()) {
    const chatId = Number(adminId);
    if (Number.isSafeInteger(chatId)) {
      try {
        await bot.api.setMyCommands(botAdminCommands, { scope: { type: "chat", chat_id: chatId } });
      } catch (error) {
        console.warn(
          `Could not register private admin commands for Telegram chat ${chatId}: ${safeErrorMessage(error)}`
        );
      }
    }
  }
}
