import { createHash } from "node:crypto";
import { InlineKeyboard, type Context } from "grammy";
import { listConversationChatModels, resolveBootModelScope, switchConversationChatModel } from "@raiden/boot";
import { telegramConversationContext } from "./conversation.js";

const pageSize = 8;

// Bind the model ID to its chat, not a mutable catalog index. Works after restarts,
// rejects forwarded buttons, and stays below Telegram's 64-byte callback limit.
export function modelSelectionToken(scopeKey: string, modelId: string) {
  return createHash("sha256").update(JSON.stringify([scopeKey, modelId])).digest("hex").slice(0, 24);
}

export function buildModelMenu(
  catalog: Awaited<ReturnType<typeof listConversationChatModels>>,
  scopeKey: string,
  group: boolean,
  requestedPage = 0
) {
  const pages = Math.max(1, Math.ceil(catalog.models.length / pageSize));
  const page = Math.max(0, Math.min(Number.isSafeInteger(requestedPage) ? requestedPage : 0, pages - 1));
  const keyboard = new InlineKeyboard();
  for (const model of catalog.models.slice(page * pageSize, (page + 1) * pageSize)) {
    keyboard.text(`${model.id === catalog.currentModel ? "✓ " : ""}${model.id}`, `model:pick:${modelSelectionToken(scopeKey, model.id)}`).row();
  }
  if (page > 0) keyboard.text("上一页", `model:page:${page - 1}`);
  if (page + 1 < pages) keyboard.text("下一页", `model:page:${page + 1}`);
  keyboard.row().text("刷新列表", "model:refresh");
  return {
    text: [
      `${group ? "当前群" : "当前私聊"}模型：${catalog.currentModel}`,
      `支持 ${catalog.models.length} 个语言模型 · 第 ${page + 1}/${pages} 页`,
      group ? "所有群成员均可切换，本群各话题共用；不影响其他群或私聊。" : "切换仅影响此私聊，不影响任何群聊或其他人的私聊。",
      "点击选择，或发送 /model chat <model_id>。切换前会检查可用性。"
    ].join("\n"),
    reply_markup: keyboard
  };
}

async function showModels(ctx: Context, page = 0, refresh = false) {
  const scope = telegramConversationContext(ctx);
  const catalog = await listConversationChatModels(scope, refresh);
  const menu = buildModelMenu(catalog, resolveBootModelScope(scope), ctx.chat?.type !== "private", page);
  // Reply instead of editing: two members may use the same group menu concurrently.
  await ctx.reply(menu.text, { reply_markup: menu.reply_markup });
}

async function selectModel(ctx: Context, modelId: string) {
  const result = await switchConversationChatModel(telegramConversationContext(ctx), modelId);
  const label = ctx.chat?.type === "private" ? "当前私聊" : "当前群";
  await ctx.reply(result.beforeModel === result.afterModel
    ? `${label}已经使用：${result.afterModel}`
    : `${label}模型已切换：${result.beforeModel} → ${result.afterModel}\n之后的新回复使用此模型，其他会话不受影响。`);
}

async function modelOperationFailed(ctx: Context) {
  await ctx.reply("模型操作未完成：请确认模型在支持列表中且服务可用，然后重试 /model。未成功切换时原设置保持不变（MODEL_OPERATION_FAILED）。");
}

export async function handleChatModelCommand(ctx: Context, args: string) {
  if (!ctx.chat || !ctx.from) return;
  const [kind, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  try {
    if (!kind || kind.toLowerCase() === "list") {
      await showModels(ctx, 0, Boolean(kind));
    } else {
      const modelId = kind.toLowerCase() === "chat" ? rest.join(" ") : [kind, ...rest].join(" ");
      if (!modelId) {
        await ctx.reply("用法：/model 查看列表，或 /model chat <model_id> 切换当前会话模型。");
        return;
      }
      await selectModel(ctx, modelId);
    }
  } catch {
    // Provider errors can contain credentials or internal URLs; never echo them to a public chat.
    await modelOperationFailed(ctx);
  }
}

export async function handleChatModelCallback(ctx: Context) {
  await ctx.answerCallbackQuery();
  if (!ctx.chat || !ctx.from) return;
  const data = ctx.callbackQuery?.data ?? "";
  try {
    if (data === "model:refresh") {
      await showModels(ctx, 0, true);
    } else if (/^model:page:\d+$/.test(data)) {
      await showModels(ctx, Number(data.slice("model:page:".length)));
    } else if (/^model:pick:[a-f0-9]{24}$/.test(data)) {
      const scope = telegramConversationContext(ctx);
      const scopeKey = resolveBootModelScope(scope);
      const catalog = await listConversationChatModels(scope);
      const matches = catalog.models.filter((model) => `model:pick:${modelSelectionToken(scopeKey, model.id)}` === data);
      if (matches.length !== 1) {
        await ctx.reply("此模型按钮已失效或不属于当前会话，请发送 /model 重新选择。");
        return;
      }
      await selectModel(ctx, matches[0]!.id);
    } else {
      await ctx.reply("无效的模型按钮，请发送 /model 重新选择。");
    }
  } catch {
    await modelOperationFailed(ctx);
  }
}
