import { FormEvent, useState } from "react";
import { Save, Trash2 } from "lucide-react";
import type { AdminUserDto, TelegramChatDto, TelegramCommandPermissionDto } from "@raiden/shared";
import { EmptyRow, ResourcePage, statusTone } from "../components/page.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Input, Label } from "../components/ui/input.js";
import { Table, Td, Th } from "../components/ui/table.js";
import { useResourceList } from "../hooks/useResourceList.js";
import { apiClient, readJson } from "../lib/apiClient.js";
import { useI18n } from "../lib/i18n.js";
import { errorMessage } from "../lib/utils.js";

function canModerateTelegram(user: AdminUserDto) {
  return user.role === "super_admin" || user.role === "operator";
}

function normalizeCommandName(value: string) {
  return value.trim().replace(/^\//, "").toLowerCase();
}

function canManageCommand(value: string) {
  const command = normalizeCommandName(value);
  return /^[a-z0-9_]{1,32}$/.test(command) && command !== "model";
}

export function TelegramPage({ user }: { user: AdminUserDto }) {
  const { t, formatStatus, formatPolicy, formatChatType, formatDate } = useI18n();
  const { data, total, loading, error, reload } = useResourceList<TelegramChatDto>("telegram-chats", 50);
  const commandPermissions = useResourceList<TelegramCommandPermissionDto>("telegram-command-permissions", 100);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [commandMutationError, setCommandMutationError] = useState<string | null>(null);
  const [commandChatId, setCommandChatId] = useState("");
  const [commandName, setCommandName] = useState("start");
  const [commandEnabled, setCommandEnabled] = useState(true);
  const canModerate = canModerateTelegram(user);

  async function updateChat(chatId: string, patch: Partial<Pick<TelegramChatDto, "status" | "policy">>) {
    if (!canModerate) {
      return;
    }

    setMutationError(null);
    try {
      const response = await apiClient.api.telegram.chats[":chatId"].$patch({
        param: { chatId },
        json: patch
      });
      await readJson<{ data: TelegramChatDto }>(response);
      await reload();
    } catch (requestError) {
      setMutationError(errorMessage(requestError));
    }
  }

  async function saveCommandPermission(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canModerate) {
      return;
    }
    const command = normalizeCommandName(commandName);
    if (!canManageCommand(commandName)) {
      setCommandMutationError(t("telegram.commandInvalid"));
      return;
    }

    setCommandMutationError(null);
    try {
      const response = await apiClient.api.telegram["command-permissions"].$put({
        json: {
          chatId: commandChatId || null,
          command,
          enabled: commandEnabled
        }
      });
      await readJson<{ data: TelegramCommandPermissionDto }>(response);
      await commandPermissions.reload();
    } catch (requestError) {
      setCommandMutationError(errorMessage(requestError));
    }
  }

  async function deleteCommandPermission(permission: TelegramCommandPermissionDto) {
    if (!canModerate) {
      return;
    }

    setCommandMutationError(null);
    try {
      const response = await apiClient.api.telegram["command-permissions"][":id"].$delete({
        param: { id: permission.id }
      });
      await readJson<{ data: TelegramCommandPermissionDto }>(response);
      await commandPermissions.reload();
    } catch (requestError) {
      setCommandMutationError(errorMessage(requestError));
    }
  }

  const commandSubmittable = canModerate && canManageCommand(commandName);

  return (
    <ResourcePage
      title={t("telegram.title")}
      description={t("telegram.description")}
      error={error ?? mutationError ?? commandPermissions.error ?? commandMutationError}
      loading={loading || commandPermissions.loading}
      onRefresh={async () => {
        await Promise.all([reload(), commandPermissions.reload()]);
      }}
    >
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>{t("telegram.chats")}</CardTitle>
            {!canModerate && <Badge tone="warning">{t("common.readOnly")}</Badge>}
          </div>
          <CardDescription>{t("telegram.chatCount", { count: total })}</CardDescription>
        </CardHeader>
        <div className="overflow-x-auto">
          <Table>
            <thead className="bg-zinc-50">
              <tr>
                <Th>{t("telegram.chat")}</Th>
                <Th>{t("telegram.type")}</Th>
                <Th>{t("common.status")}</Th>
                <Th>{t("telegram.policy")}</Th>
                <Th>{t("common.updated")}</Th>
                <Th className="text-right">{t("common.actions")}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {data.map((chat) => (
                <tr className="hover:bg-zinc-50" key={chat.chatId}>
                  <Td>
                    <div className="font-mono text-xs text-zinc-900">{chat.chatId}</div>
                    <div className="mt-1 text-xs text-zinc-500">{chat.title ?? chat.username ?? "-"}</div>
                  </Td>
                  <Td>{formatChatType(chat.type)}</Td>
                  <Td>
                    <Badge tone={statusTone(chat.status)}>{formatStatus(chat.status)}</Badge>
                  </Td>
                  <Td>
                    <select
                      className="h-8 rounded-md border border-zinc-300 bg-white px-2 text-xs font-semibold text-zinc-800 outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:opacity-70"
                      disabled={!canModerate}
                      value={chat.policy}
                      onChange={(event) =>
                        updateChat(chat.chatId, { policy: event.target.value as TelegramChatDto["policy"] })
                      }
                    >
                      <option value="allow_all_commands">{formatPolicy("allow_all_commands")}</option>
                      <option value="commands_only">{formatPolicy("commands_only")}</option>
                      <option value="read_only">{formatPolicy("read_only")}</option>
                      <option value="disabled">{formatPolicy("disabled")}</option>
                    </select>
                  </Td>
                  <Td>{formatDate(chat.updatedAt)}</Td>
                  <Td>
                    <div className="flex justify-end gap-2">
                      <Button
                        disabled={!canModerate}
                        onClick={() => updateChat(chat.chatId, { status: "approved" })}
                        size="sm"
                        variant="secondary"
                      >
                        {t("telegram.approve")}
                      </Button>
                      <Button disabled={!canModerate} onClick={() => updateChat(chat.chatId, { status: "muted" })} size="sm" variant="outline">
                        {t("telegram.mute")}
                      </Button>
                      <Button
                        disabled={!canModerate}
                        onClick={() => updateChat(chat.chatId, { status: "blocked" })}
                        size="sm"
                        variant="destructive"
                      >
                        {t("telegram.block")}
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
              {data.length === 0 && <EmptyRow colSpan={6}>{t("telegram.empty")}</EmptyRow>}
            </tbody>
          </Table>
        </div>
      </Card>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>{t("telegram.commandPermissions")}</CardTitle>
            {!canModerate && <Badge tone="warning">{t("common.readOnly")}</Badge>}
          </div>
          <CardDescription>{t("telegram.commandPermissionDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <form className="grid gap-3 xl:grid-cols-[1fr_180px_160px_auto]" onSubmit={saveCommandPermission}>
            <Label>
              {t("telegram.scope")}
              <select
                className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100 disabled:cursor-not-allowed disabled:bg-zinc-100"
                disabled={!canModerate}
                value={commandChatId}
                onChange={(event) => setCommandChatId(event.target.value)}
              >
                <option value="">{t("telegram.globalScope")}</option>
                {data.map((chat) => (
                  <option key={chat.chatId} value={chat.chatId}>
                    {chat.title ?? chat.username ?? chat.chatId}
                  </option>
                ))}
              </select>
            </Label>
            <Label>
              {t("telegram.command")}
              <Input disabled={!canModerate} value={commandName} onChange={(event) => setCommandName(event.target.value)} placeholder="start" />
            </Label>
            <label className="grid gap-1.5 text-sm font-medium text-zinc-700">
              {t("telegram.permissionState")}
              <span className="inline-flex h-10 items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 text-sm font-semibold text-zinc-800">
                <input
                  checked={commandEnabled}
                  className="size-4 accent-cyan-600"
                  disabled={!canModerate}
                  type="checkbox"
                  onChange={(event) => setCommandEnabled(event.target.checked)}
                />
                {commandEnabled ? t("telegram.allow") : t("telegram.deny")}
              </span>
            </label>
            <div className="flex items-end">
              <Button className="w-full" disabled={!commandSubmittable} type="submit">
                <Save className="size-4" />
                {t("telegram.saveRule")}
              </Button>
            </div>
          </form>
          <div className="overflow-x-auto">
            <Table>
              <thead className="bg-zinc-50">
                <tr>
                  <Th>{t("telegram.scope")}</Th>
                  <Th>{t("telegram.command")}</Th>
                  <Th>{t("telegram.permissionState")}</Th>
                  <Th>{t("common.updated")}</Th>
                  <Th className="text-right">{t("common.actions")}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {commandPermissions.data.map((permission) => (
                  <tr className="hover:bg-zinc-50" key={permission.id}>
                    <Td>
                      {permission.chatId ? (
                        <span className="font-mono text-xs text-zinc-900">{permission.chatId}</span>
                      ) : (
                        t("telegram.globalScope")
                      )}
                    </Td>
                    <Td>
                      <span className="font-mono text-xs text-zinc-900">/{permission.command}</span>
                    </Td>
                    <Td>
                      <Badge tone={permission.enabled ? "success" : "danger"}>
                        {formatStatus(permission.enabled ? "enabled" : "disabled")}
                      </Badge>
                    </Td>
                    <Td>{formatDate(permission.updatedAt)}</Td>
                    <Td>
                      <div className="flex justify-end">
                        <Button
                          aria-label={t("common.delete")}
                          disabled={!canModerate}
                          onClick={() => deleteCommandPermission(permission)}
                          size="icon"
                          title={t("common.delete")}
                          type="button"
                          variant="ghost"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </Td>
                  </tr>
                ))}
                {commandPermissions.data.length === 0 && <EmptyRow colSpan={5}>{t("telegram.commandPermissionEmpty")}</EmptyRow>}
              </tbody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </ResourcePage>
  );
}
