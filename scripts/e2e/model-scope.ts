import assert from "node:assert/strict";
import {
  clearBootConversation, getEffectiveBootConfig, listConversationChatModels,
  processMemoryEnrichmentJob, resolveBootModelScope, runBootConversation,
  summarizeBootConversation, switchConversationChatModel
} from "@raiden/boot";
import { getChatModelPreference, getSqlClient, resolveTelegramChatAccess, updateTelegramChat } from "@raiden/database";
import { createRaidenBot, setRaidenBotCommands } from "../../packages/bot/src/bot.js";
import { buildModelMenu, modelSelectionToken } from "../../packages/bot/src/model-menu.js";
import type { MockRelayState } from "./mock-relay.js";

export async function verifyConversationModels(relay: MockRelayState) {
  const sql = getSqlClient();
  const userA = Date.now();
  const userB = userA + 1;
  const groupA = -userA;
  const groupB = -userB;
  const privateA = { protocol: "telegram", userId: String(userA), sourceChatId: String(userA), sourceChatType: "private" as const };
  const privateB = { ...privateA, userId: String(userB), sourceChatId: String(userB) };
  const scopeA = { ...privateA, sourceChatId: String(groupA), sourceChatType: "supergroup" as const };
  const scopeB = { ...scopeA, sourceChatId: String(groupB) };
  const scopes = [privateA, privateB, scopeA, scopeB];
  const keys = scopes.map(resolveBootModelScope);
  const sent: Array<{ text?: string; reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> } }> = [];
  const commandMenus: Array<{ commands: Array<{ command: string }> }> = [];
  let updateId = 0;
  let callbackAnswers = 0;
  function newBot() {
    const bot = createRaidenBot("123456789:local-test-token");
    bot.botInfo = { id: 123456789, is_bot: true, first_name: "Test", username: "scope_test_bot",
      can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false, can_connect_to_business: false,
      has_main_web_app: false, can_manage_bots: false, has_topics_enabled: false, allows_users_to_create_topics: false };
    bot.api.config.use(async (_prev, method, payload) => {
      if (method === "sendMessage") {
        sent.push(payload as typeof sent[number]);
        return { ok: true, result: { message_id: 1000 + sent.length, date: 1, chat: { id: (payload as { chat_id: number }).chat_id, type: "supergroup" }, text: (payload as { text: string }).text } } as never;
      }
      if (method === "answerCallbackQuery") {
        callbackAnswers++;
        return { ok: true, result: true } as never;
      }
      if (method === "setMyCommands") {
        commandMenus.push(payload as typeof commandMenus[number]);
        return { ok: true, result: true } as never;
      }
      throw new Error(`Unexpected Telegram API call: ${method}`);
    });
    return bot;
  }
  let bot = newBot();
  async function command(chatId: number, fromId: number, text: string, thread = 1) {
    const name = text.split(" ")[0]!;
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: 1,
      from: { id: fromId, is_bot: false, first_name: "Ordinary member" },
      chat: chatId < 0 ? { id: chatId, type: "supergroup", title: "Model scope test" } : { id: chatId, type: "private", first_name: "Test" },
      message_thread_id: thread, text, entities: [{ type: "bot_command", offset: 0, length: name.length }] } });
  }
  async function click(chatId: number, fromId: number, data: string) {
    await bot.handleUpdate({ update_id: ++updateId, callback_query: { id: String(updateId), chat_instance: "test",
      from: { id: fromId, is_bot: false, first_name: "Other member" }, data,
      message: { message_id: 1001, date: 1, chat: chatId < 0 ? { id: chatId, type: "supergroup", title: "Model scope test" } : { id: chatId, type: "private", first_name: "Test" } } } });
  }
  try {
    for (const chatId of [groupA, groupB]) {
      await resolveTelegramChatAccess({ chatId: String(chatId), type: "supergroup" });
      await updateTelegramChat(String(chatId), { status: "approved", policy: "commands_only" });
    }
    await setRaidenBotCommands(bot);
    assert(commandMenus.length >= 3 && commandMenus.every(menu => menu.commands.some(c => c.command === "model")), "Every command scope exposes /model");
    await command(groupA, userA, "/model@scope_test_bot");
    assert(sent.at(-1)?.text?.includes("当前群模型：mock-chat"));
    const button = sent.at(-1)?.reply_markup?.inline_keyboard.flat().find(b => b.text.includes("mock-responses-only"));
    assert(button?.callback_data, "Ordinary members get selectable models");
    assert(Buffer.byteLength(button.callback_data) <= 64);
    await click(groupA, userB, button.callback_data);
    assert(sent.at(-1)?.text?.includes("模型已切换"), "A different ordinary member can use group buttons");
    assert(callbackAnswers > 0);
    await command(groupA, userA, "/model list chat", 99);
    assert(sent.at(-1)?.text?.includes("当前群模型：mock-responses-only"), "Group topics share a model");
    for (const scope of [scopeB, privateA, privateB]) assert.equal((await getEffectiveBootConfig(scope)).BOOT_CHAT_MODEL, "mock-chat");
    assert.equal((await getEffectiveBootConfig()).BOOT_CHAT_MODEL, "mock-chat", "Global default is unchanged");
    const scopedConfig = await getEffectiveBootConfig({ ...scopeA, userId: String(userB) });
    for (const model of [scopedConfig.BOOT_CHAT_MODEL, scopedConfig.BOOT_TOOL_MODEL, scopedConfig.BOOT_SUMMARY_MODEL, scopedConfig.BOOT_MEMORY_MODEL]) assert.equal(model, "mock-responses-only");
    await click(groupB, userA, button.callback_data);
    assert(sent.at(-1)?.text?.includes("按钮已失效"), "Forwarded/cross-chat buttons cannot select models");
    assert.equal(await getChatModelPreference(resolveBootModelScope(scopeB)), null);

    bot = newBot();
    await command(groupA, userB, "/model");
    assert(sent.at(-1)?.text?.includes("当前群模型：mock-responses-only"), "Recreating bot retains selection");
    await click(groupA, userA, button.callback_data);
    assert(sent.at(-1)?.text?.includes("已经使用"), "Old buttons retain their exact model after bot restart");
    for (const invalid of ["mock-unavailable", "not-in-catalog", "mock-embedding", "gpt-image-2-codex", ""]) {
      await assert.rejects(switchConversationChatModel(scopeA, invalid));
      assert.equal(await getChatModelPreference(resolveBootModelScope(scopeA)), "mock-responses-only");
    }
    await command(groupA, userA, "/model image gpt-image-2-codex");
    assert(sent.at(-1)?.text?.includes("仅限 Bot 管理员"), "Public language command does not expose global image writes");
    await command(userA, userA, "/model chat mock-responses-only");
    assert(sent.at(-1)?.text?.includes("当前私聊模型已切换"));
    assert.equal((await getEffectiveBootConfig({ protocol: "telegram", userId: String(userA) })).BOOT_CHAT_MODEL, "mock-responses-only");
    assert.equal((await getEffectiveBootConfig(privateB)).BOOT_CHAT_MODEL, "mock-chat");
    assert.equal((await getEffectiveBootConfig(scopeB)).BOOT_CHAT_MODEL, "mock-chat");

    const callStart = relay.languageCalls.length;
    const reply = await runBootConversation({ ...scopeA, sourceThreadId: "7", content: "E2E_SCOPE_REPLY 请记住，我喜欢散步。" });
    await runBootConversation({ ...scopeA, sourceThreadId: "7", content: "E2E_SCOPE_TOOLS 你觉得这个头像如何？" });
    await summarizeBootConversation({ ...scopeA, sourceThreadId: "7" });
    await processMemoryEnrichmentJob({ userId: String(userA), sourceChatId: String(groupA), sourceThreadId: "7", sharedConversation: true,
      displayName: "Test", content: "E2E_SCOPE_MEMORY 请记住，我喜欢散步。", reply: reply.reply, sourceMessageId: reply.userMessageId, memoryModel: scopedConfig.BOOT_MEMORY_MODEL });
    const calls = relay.languageCalls.slice(callStart);
    assert(calls.length >= 4 && calls.every(call => call.model === "mock-responses-only"), "Actual reply, summary and synchronous/worker memories use the selected model");
    const privateCallStart = relay.languageCalls.length;
    await runBootConversation({ ...privateB, content: "E2E_OTHER_PRIVATE 今天过得如何？" });
    assert(relay.languageCalls.slice(privateCallStart).every(call => call.model === "mock-chat"));
    await clearBootConversation({ ...scopeA, sourceThreadId: "7" });
    assert.equal(await getChatModelPreference(resolveBootModelScope(scopeA)), "mock-responses-only", "Clearing history preserves preference");

    // Concurrent writes from different group topics must form an atomic before/after chain.
    const transitions = await Promise.all([
      switchConversationChatModel(scopeB, "mock-responses-only"),
      switchConversationChatModel({ ...scopeB, userId: String(userB) }, "mock-chat")
    ]);
    const finalModel = await getChatModelPreference(resolveBootModelScope(scopeB));
    assert.equal(transitions.find(change => change.afterModel !== finalModel)?.afterModel,
      transitions.find(change => change.afterModel === finalModel)?.beforeModel);
    await sql`delete from chat_model_preferences where scope_key = ${resolveBootModelScope(scopeB)}`;

    await updateTelegramChat(String(groupB), { status: "blocked" });
    await command(groupB, userA, "/model chat mock-responses-only");
    await click(groupB, userA, `model:pick:${modelSelectionToken(resolveBootModelScope(scopeB), "mock-responses-only")}`);
    assert.equal(await getChatModelPreference(resolveBootModelScope(scopeB)), null, "Blocked chats cannot change models by command or callback");
    const catalog = await listConversationChatModels(scopeA);
    const longId = "a-very-long-model-id-".repeat(8);
    const largeCatalog = { ...catalog, models: Array.from({ length: 19 }, (_, i) => ({ id: `${longId}${i}` })) };
    const page = buildModelMenu(largeCatalog, keys[2]!, true, 1);
    assert(page.text.includes("第 2/3 页"));
    assert(page.reply_markup.inline_keyboard.flat().every(b => "callback_data" in b && Buffer.byteLength(b.callback_data) <= 64));
    assert.notEqual(modelSelectionToken(keys[2]!, longId), modelSelectionToken(keys[3]!, longId));
    const audits = await sql`select * from audit_logs where target_id in ${sql(keys)} and action = 'conversation.model_update'`;
    assert(audits.length >= 2, "Changes are audited");
    console.log("Conversation model isolation smoke passed (ordinary members, callbacks, routing, persistence, failure safety).");
  } finally {
    await sql`delete from chat_model_preferences where scope_key in ${sql(keys)}`;
    await sql`delete from audit_logs where target_type = 'chat_model_preference' and target_id in ${sql(keys)}`;
    await sql`delete from conversations where chat_id in ${sql([String(groupA), String(groupB), String(userA), String(userB)])}`;
    await sql`delete from telegram_users where telegram_id in ${sql([String(userA), String(userB)])}`;
    await sql`delete from telegram_chats where chat_id in ${sql([String(groupA), String(groupB), String(userA), String(userB)])}`;
  }
}
