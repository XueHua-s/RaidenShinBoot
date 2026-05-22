import { FormEvent, useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { RefreshCw, Save, Search, Settings2 } from "lucide-react";
import type { AdminUserDto, ChatModelListResponse, RuntimeSettings, SystemStatus } from "@raiden/shared";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Input, Label } from "../components/ui/input.js";
import { ResourcePage } from "../components/page.js";
import { apiClient, readJson } from "../lib/apiClient.js";
import { useI18n, type I18nContextValue, type TranslationKey } from "../lib/i18n.js";
import { cn, errorMessage } from "../lib/utils.js";

type RuntimeSettingsForm = Pick<
  RuntimeSettings,
  | "gatewayPreset"
  | "bootBaseUrl"
  | "bootChatBaseUrl"
  | "bootEmbeddingBaseUrl"
  | "bootImageBaseUrl"
  | "bootSearchBaseUrl"
  | "bootWikipediaApiUrl"
  | "bootMoegirlApiUrl"
  | "bootChatModel"
  | "bootEmbeddingModel"
  | "bootImageModel"
  | "bootSearchProvider"
  | "bootSearchMaxResults"
  | "bootSearchDepth"
>;

type RuntimeSecretKey = keyof RuntimeSettings["secrets"];

const runtimeSecretLabels: Array<[RuntimeSecretKey, TranslationKey]> = [
  ["bootApiKey", "system.defaultApiKey"],
  ["bootChatApiKey", "system.chatApiKey"],
  ["bootEmbeddingApiKey", "system.embeddingApiKey"],
  ["bootImageApiKey", "system.imageApiKey"],
  ["bootSearchApiKey", "system.searchApiKey"]
];

const emptyRuntimeSecrets = runtimeSecretLabels.reduce(
  (accumulator, [key]) => ({
    ...accumulator,
    [key]: ""
  }),
  {} as Record<RuntimeSecretKey, string>
);

const emptyRuntimeSecretClears = runtimeSecretLabels.reduce(
  (accumulator, [key]) => ({
    ...accumulator,
    [key]: false
  }),
  {} as Record<RuntimeSecretKey, boolean>
);

function settingsToForm(settings: RuntimeSettings): RuntimeSettingsForm {
  return {
    gatewayPreset: settings.gatewayPreset,
    bootBaseUrl: settings.bootBaseUrl,
    bootChatBaseUrl: settings.bootChatBaseUrl,
    bootEmbeddingBaseUrl: settings.bootEmbeddingBaseUrl,
    bootImageBaseUrl: settings.bootImageBaseUrl,
    bootSearchBaseUrl: settings.bootSearchBaseUrl,
    bootWikipediaApiUrl: settings.bootWikipediaApiUrl,
    bootMoegirlApiUrl: settings.bootMoegirlApiUrl,
    bootChatModel: settings.bootChatModel,
    bootEmbeddingModel: settings.bootEmbeddingModel,
    bootImageModel: settings.bootImageModel,
    bootSearchProvider: settings.bootSearchProvider,
    bootSearchMaxResults: settings.bootSearchMaxResults,
    bootSearchDepth: settings.bootSearchDepth
  };
}

type RuntimeSettingsDraft = {
  form: RuntimeSettingsForm | null;
  secretValues: Record<RuntimeSecretKey, string>;
  secretClears: Record<RuntimeSecretKey, boolean>;
};

type RuntimeSettingsDraftAction =
  | { type: "reset"; settings: RuntimeSettings }
  | { type: "updateForm"; patch: Partial<RuntimeSettingsForm> }
  | { type: "setSecretValue"; key: RuntimeSecretKey; value: string }
  | { type: "setSecretClear"; key: RuntimeSecretKey; value: boolean };

const initialRuntimeSettingsDraft: RuntimeSettingsDraft = {
  form: null,
  secretValues: emptyRuntimeSecrets,
  secretClears: emptyRuntimeSecretClears
};

function runtimeSettingsDraftReducer(state: RuntimeSettingsDraft, action: RuntimeSettingsDraftAction): RuntimeSettingsDraft {
  if (action.type === "reset") {
    return {
      form: settingsToForm(action.settings),
      secretValues: emptyRuntimeSecrets,
      secretClears: emptyRuntimeSecretClears
    };
  }

  if (action.type === "updateForm") {
    return state.form ? { ...state, form: { ...state.form, ...action.patch } } : state;
  }

  if (action.type === "setSecretValue") {
    return { ...state, secretValues: { ...state.secretValues, [action.key]: action.value } };
  }

  return { ...state, secretClears: { ...state.secretClears, [action.key]: action.value } };
}

export function SystemPage({ user }: { user: AdminUserDto }) {
  const { t, formatStatus, formatSearchProvider, formatDepth } = useI18n();
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [chatModels, setChatModels] = useState<ChatModelListResponse | null>(null);
  const [chatModelsLoading, setChatModelsLoading] = useState(false);
  const [chatModelsError, setChatModelsError] = useState<string | null>(null);
  const [draft, dispatchDraft] = useReducer(runtimeSettingsDraftReducer, initialRuntimeSettingsDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { form, secretValues, secretClears } = draft;
  const canWriteSystem = user.role === "super_admin";

  const updateForm = useCallback((patch: Partial<RuntimeSettingsForm>) => {
    dispatchDraft({ type: "updateForm", patch });
  }, []);

  const loadChatModels = useCallback(async () => {
    setChatModelsLoading(true);
    setChatModelsError(null);
    try {
      const response = await apiClient.api.system.models.chat.$get();
      setChatModels(await readJson<ChatModelListResponse>(response));
    } catch (requestError) {
      setChatModels(null);
      setChatModelsError(errorMessage(requestError));
    } finally {
      setChatModelsLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setError(null);
    setNotice(null);
    try {
      const [statusResponse, settingsResponse] = await Promise.all([
        apiClient.api.system.status.$get(),
        apiClient.api.system.settings.$get()
      ]);
      const [statusPayload, settingsPayload] = await Promise.all([
        readJson<SystemStatus>(statusResponse),
        readJson<{ data: RuntimeSettings }>(settingsResponse)
      ]);
      setSystem(statusPayload);
      setSettings(settingsPayload.data);
      dispatchDraft({ type: "reset", settings: settingsPayload.data });
    } catch (requestError) {
      setError(errorMessage(requestError));
    }
  }, []);

  useEffect(() => {
    load();
    loadChatModels();
  }, [load, loadChatModels]);

  const rows = useMemo(
    () => [
      [t("runtime.api"), formatStatus(system?.ok ? "online" : "pending")],
      [t("runtime.database"), formatStatus(system?.databaseConfigured ? "configured" : "missing")],
      [t("runtime.auth"), formatStatus(system?.authEnabled ? "enabled" : "disabled")],
      [t("runtime.botToken"), formatStatus(system?.botTokenConfigured ? "configured" : "missing")],
      [t("runtime.runtimeDb"), formatStatus(system?.runtimeSettingsConfigured ? "configured" : "missing")],
      [t("runtime.secretStorage"), formatStatus(system?.runtimeSettingsSecretStorageReady ? "configured" : "missing")],
      [t("runtime.chatModel"), system?.bootChatModel ?? "-"],
      [t("runtime.embeddingModel"), system?.bootEmbeddingModel ?? "-"],
      [t("runtime.imageModel"), system?.bootImageModel ?? "-"],
      [t("runtime.searchProvider"), formatSearchProvider(system?.bootSearchProvider ?? "disabled")]
    ],
    [formatSearchProvider, formatStatus, system, t]
  );
  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form || !canWriteSystem) {
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const secretPatch = runtimeSecretLabels.reduce<Record<string, string | null>>((accumulator, [key]) => {
        if (secretClears[key]) {
          accumulator[key] = null;
        } else if (secretValues[key].trim()) {
          accumulator[key] = secretValues[key].trim();
        }
        return accumulator;
      }, {});
      const response = await apiClient.api.system.settings.$patch({
        json: {
          gatewayPreset: form.gatewayPreset,
          bootBaseUrl: form.bootBaseUrl,
          bootChatBaseUrl: form.bootChatBaseUrl || null,
          bootEmbeddingBaseUrl: form.bootEmbeddingBaseUrl || null,
          bootImageBaseUrl: form.bootImageBaseUrl || null,
          bootSearchBaseUrl: form.bootSearchBaseUrl || null,
          bootWikipediaApiUrl: form.bootWikipediaApiUrl,
          bootMoegirlApiUrl: form.bootMoegirlApiUrl,
          bootChatModel: form.bootChatModel,
          bootSearchProvider: form.bootSearchProvider,
          bootSearchMaxResults: form.bootSearchMaxResults,
          bootSearchDepth: form.bootSearchDepth,
          ...secretPatch
        }
      });
      const payload = await readJson<{ data: RuntimeSettings }>(response);
      setSettings(payload.data);
      dispatchDraft({ type: "reset", settings: payload.data });
      await load();
      await loadChatModels();
      setNotice(t("system.settingsSaved"));
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ResourcePage
      title={t("system.title")}
      description={t("system.description")}
      error={error}
      loading={!system && !error}
      onRefresh={async () => {
        await Promise.all([load(), loadChatModels()]);
      }}
    >
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
          {notice}
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t("system.runtimeMatrix")}</CardTitle>
          <CardDescription>{system?.service ?? "raiden-shin-server"}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {rows.map(([label, value]) => (
            <div className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 px-3 py-2" key={label}>
              <span className="text-sm font-medium text-zinc-600">{label}</span>
              <span className="max-w-64 truncate text-sm font-semibold text-zinc-950">{value}</span>
            </div>
          ))}
        </CardContent>
      </Card>
      {form && settings && (
        <Card>
          <CardHeader>
            <CardTitle>{t("system.gatewayTitle")}</CardTitle>
            <CardDescription>{t("system.gatewayDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-5" onSubmit={saveSettings}>
              <GatewayPresetSection canWriteSystem={canWriteSystem} form={form} t={t} updateForm={updateForm} />
              <EndpointAndModelSections
                canWriteSystem={canWriteSystem}
                chatModels={chatModels}
                chatModelsError={chatModelsError}
                chatModelsLoading={chatModelsLoading}
                form={form}
                settings={settings}
                t={t}
                updateForm={updateForm}
                onRefreshChatModels={loadChatModels}
              />
              <SearchAndSecretSections
                canWriteSystem={canWriteSystem}
                form={form}
                formatDepth={formatDepth}
                formatSearchProvider={formatSearchProvider}
                formatStatus={formatStatus}
                secretClears={secretClears}
                secretValues={secretValues}
                settings={settings}
                t={t}
                updateForm={updateForm}
                dispatchDraft={dispatchDraft}
              />
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 pt-4">
                <p className="text-xs leading-5 text-zinc-500">{t("system.auditHint")}</p>
                <div className="flex flex-wrap items-center gap-2">
                  {!canWriteSystem && <Badge tone="warning">{t("common.readOnly")}</Badge>}
                  <Button disabled={!canWriteSystem || saving || !form.bootBaseUrl.trim()} type="submit">
                    <Save className="size-4" />
                    {saving ? t("common.saving") : t("common.save")}
                  </Button>
                </div>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </ResourcePage>
  );
}

function GatewayPresetSection({
  canWriteSystem,
  form,
  t,
  updateForm
}: {
  canWriteSystem: boolean;
  form: RuntimeSettingsForm;
  t: I18nContextValue["t"];
  updateForm: (patch: Partial<RuntimeSettingsForm>) => void;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-[240px_1fr]">
      <div>
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950">
          <Settings2 className="size-4 text-cyan-700" />
          {t("system.gatewayPreset")}
        </div>
        <p className="mt-1 text-xs leading-5 text-zinc-500">{t("system.gatewayHelp")}</p>
      </div>
      <div className="grid grid-cols-2 gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-1">
        {[
          ["openai_compatible", t("gateway.openaiCompatible")],
          ["new_api", t("gateway.newApi")]
        ].map(([value, label]) => (
          <button
            className={cn(
              "h-10 rounded-md text-sm font-semibold transition",
              form.gatewayPreset === value ? "bg-zinc-950 text-white shadow-sm" : "text-zinc-600 hover:bg-white",
              !canWriteSystem && "cursor-not-allowed opacity-60"
            )}
            disabled={!canWriteSystem}
            key={value}
            type="button"
            onClick={() => updateForm({ gatewayPreset: value as RuntimeSettings["gatewayPreset"] })}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function EndpointAndModelSections({
  canWriteSystem,
  chatModels,
  chatModelsError,
  chatModelsLoading,
  form,
  settings,
  t,
  updateForm,
  onRefreshChatModels
}: {
  canWriteSystem: boolean;
  chatModels: ChatModelListResponse | null;
  chatModelsError: string | null;
  chatModelsLoading: boolean;
  form: RuntimeSettingsForm;
  settings: RuntimeSettings;
  t: I18nContextValue["t"];
  updateForm: (patch: Partial<RuntimeSettingsForm>) => void;
  onRefreshChatModels: () => void | Promise<void>;
}) {
  const chatModelIds = chatModels?.models.map((model) => model.id) ?? [];
  const invalidCurrentModel = chatModelIds.length > 0 && !chatModelIds.includes(form.bootChatModel);

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="grid gap-3 rounded-lg border border-zinc-200 p-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-950">{t("system.relayEndpoints")}</h3>
          <p className="mt-1 text-xs leading-5 text-zinc-500">{t("system.relayHelp")}</p>
        </div>
        <Label>
          {t("system.defaultBaseUrl")}
          <Input
            disabled={!canWriteSystem}
            value={form.bootBaseUrl}
            onChange={(event) => updateForm({ bootBaseUrl: event.target.value })}
            placeholder="https://new-api.example.com/v1"
          />
        </Label>
        <Label>
          {t("system.chatBaseUrl")}
          <Input
            disabled={!canWriteSystem}
            value={form.bootChatBaseUrl ?? ""}
            onChange={(event) => updateForm({ bootChatBaseUrl: event.target.value || null })}
            placeholder={t("system.fallbackDefault")}
          />
        </Label>
        <Label>
          {t("system.embeddingBaseUrl")}
          <Input
            disabled={!canWriteSystem}
            value={form.bootEmbeddingBaseUrl ?? ""}
            onChange={(event) => updateForm({ bootEmbeddingBaseUrl: event.target.value || null })}
            placeholder={t("system.fallbackDefault")}
          />
        </Label>
        <Label>
          {t("system.imageBaseUrl")}
          <Input
            disabled={!canWriteSystem}
            value={form.bootImageBaseUrl ?? ""}
            onChange={(event) => updateForm({ bootImageBaseUrl: event.target.value || null })}
            placeholder={t("system.fallbackDefault")}
          />
        </Label>
      </div>

      <div className="grid gap-3 rounded-lg border border-zinc-200 p-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-950">{t("system.modelMapping")}</h3>
          <p className="mt-1 text-xs leading-5 text-zinc-500">{t("system.modelHelp")}</p>
        </div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-zinc-700">{t("system.chatModel")}</span>
            <Button disabled={chatModelsLoading} size="sm" type="button" variant="outline" onClick={onRefreshChatModels}>
              <RefreshCw className={cn("size-3.5", chatModelsLoading && "animate-spin")} />
              {t("common.refresh")}
            </Button>
          </div>
          {chatModelIds.length > 0 ? (
            <select
              className="h-10 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              disabled={!canWriteSystem}
              value={form.bootChatModel}
              onChange={(event) => updateForm({ bootChatModel: event.target.value })}
            >
              {invalidCurrentModel && (
                <option disabled value={form.bootChatModel}>
                  {t("system.currentModelUnavailable", { model: form.bootChatModel })}
                </option>
              )}
              {chatModelIds.map((modelId) => (
                <option key={modelId} value={modelId}>
                  {modelId}
                </option>
              ))}
            </select>
          ) : (
            <Input
              disabled={!canWriteSystem}
              value={form.bootChatModel}
              onChange={(event) => updateForm({ bootChatModel: event.target.value })}
            />
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <Badge tone={chatModelsError ? "warning" : chatModelsLoading ? "info" : "success"}>
              {chatModelsError
                ? t("system.modelListUnavailable")
                : chatModelsLoading
                  ? t("common.checking")
                  : t("system.modelListLoaded", { count: chatModels?.models.length ?? 0 })}
            </Badge>
            {invalidCurrentModel && <Badge tone="danger">{t("system.currentModelMustChange")}</Badge>}
            {chatModelsError && <span className="min-w-0 truncate">{chatModelsError}</span>}
            {chatModels?.source && <span className="min-w-0 truncate" title={chatModels.source}>{chatModels.source}</span>}
          </div>
        </div>
        <Label>
          {t("system.embeddingModel")}
          <Input disabled={!canWriteSystem} readOnly value={form.bootEmbeddingModel} />
          <span className="text-xs font-normal text-zinc-500">{t("system.fixedModel")}</span>
        </Label>
        <Label>
          {t("system.imageModel")}
          <Input disabled={!canWriteSystem} readOnly value={form.bootImageModel} />
          <span className="text-xs font-normal text-zinc-500">{t("system.fixedModel")}</span>
        </Label>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
            <span className="text-zinc-500">{t("system.memoryVector")}</span>
            <div className="mt-1 font-semibold text-zinc-950">{t("system.dimensions", { count: settings.embeddingDimensions })}</div>
          </div>
          <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
            <span className="text-zinc-500">new-api</span>
            <div className="mt-1 font-semibold text-zinc-950">
              {settings.newApiCompatible ? t("system.compatible") : t("system.manual")}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SearchAndSecretSections({
  canWriteSystem,
  form,
  formatDepth,
  formatSearchProvider,
  formatStatus,
  secretClears,
  secretValues,
  settings,
  t,
  updateForm,
  dispatchDraft
}: {
  canWriteSystem: boolean;
  form: RuntimeSettingsForm;
  formatDepth: I18nContextValue["formatDepth"];
  formatSearchProvider: I18nContextValue["formatSearchProvider"];
  formatStatus: I18nContextValue["formatStatus"];
  secretClears: Record<RuntimeSecretKey, boolean>;
  secretValues: Record<RuntimeSecretKey, string>;
  settings: RuntimeSettings;
  t: I18nContextValue["t"];
  updateForm: (patch: Partial<RuntimeSettingsForm>) => void;
  dispatchDraft: (action: RuntimeSettingsDraftAction) => void;
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
      <div className="grid gap-3 rounded-lg border border-zinc-200 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-950">{t("system.searchChannel")}</h3>
            <p className="mt-1 text-xs leading-5 text-zinc-500">{t("system.searchHelp")}</p>
          </div>
          <Search className="size-4 text-cyan-700" />
        </div>
        <Label>
          {t("system.provider")}
          <select
            className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
            disabled={!canWriteSystem}
            value={form.bootSearchProvider}
            onChange={(event) => updateForm({ bootSearchProvider: event.target.value as RuntimeSettings["bootSearchProvider"] })}
          >
            <option value="disabled">{formatSearchProvider("disabled")}</option>
            <option value="tavily">tavily</option>
            <option value="brave">brave</option>
            <option value="serper">serper</option>
          </select>
        </Label>
        <Label>
          {t("system.searchBaseUrl")}
          <Input
            disabled={!canWriteSystem}
            value={form.bootSearchBaseUrl ?? ""}
            onChange={(event) => updateForm({ bootSearchBaseUrl: event.target.value || null })}
            placeholder={t("system.providerDefault")}
          />
        </Label>
        <Label>
          {t("system.wikipediaApiUrl")}
          <Input
            disabled={!canWriteSystem}
            value={form.bootWikipediaApiUrl}
            onChange={(event) => updateForm({ bootWikipediaApiUrl: event.target.value })}
            placeholder="https://zh.wikipedia.org/w/api.php"
          />
        </Label>
        <Label>
          {t("system.moegirlApiUrl")}
          <Input
            disabled={!canWriteSystem}
            value={form.bootMoegirlApiUrl}
            onChange={(event) => updateForm({ bootMoegirlApiUrl: event.target.value })}
            placeholder="https://zh.moegirl.org.cn/api.php"
          />
        </Label>
        <div className="grid grid-cols-2 gap-3">
          <Label>
            {t("system.maxResults")}
            <Input
              disabled={!canWriteSystem}
              max={10}
              min={1}
              type="number"
              value={form.bootSearchMaxResults}
              onChange={(event) => updateForm({ bootSearchMaxResults: Number(event.target.value) })}
            />
          </Label>
          <Label>
            {t("system.depth")}
            <select
              className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              disabled={!canWriteSystem}
              value={form.bootSearchDepth}
              onChange={(event) => updateForm({ bootSearchDepth: event.target.value as RuntimeSettings["bootSearchDepth"] })}
            >
              <option value="basic">{formatDepth("basic")}</option>
              <option value="advanced">{formatDepth("advanced")}</option>
            </select>
          </Label>
        </div>
      </div>

      <div className="grid gap-3 rounded-lg border border-zinc-200 p-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-950">{t("system.secretKeys")}</h3>
          <p className="mt-1 text-xs leading-5 text-zinc-500">{t("system.secretHelp")}</p>
        </div>
        {!settings.secretStorageReady && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
            {t("system.secretStorageWarning")}
          </div>
        )}
        <div className="grid gap-3">
          {runtimeSecretLabels.map(([key, label]) => (
            <div className="grid gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-3" key={key}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-zinc-800">{t(label)}</span>
                <Badge tone={settings.secrets[key] ? "success" : "warning"}>
                  {formatStatus(settings.secrets[key] ? "configured" : "missing")}
                </Badge>
              </div>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <Input
                  autoComplete="off"
                  disabled={!canWriteSystem || secretClears[key]}
                  placeholder={settings.secrets[key] ? t("common.keepSecret") : t("common.pasteSecret")}
                  type="password"
                  value={secretValues[key]}
                  onChange={(event) => dispatchDraft({ type: "setSecretValue", key, value: event.target.value })}
                />
                <label className="inline-flex h-10 items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 text-xs font-semibold text-zinc-700">
                  <input
                    checked={secretClears[key]}
                    className="size-4 accent-cyan-600"
                    disabled={!canWriteSystem}
                    type="checkbox"
                    onChange={(event) => dispatchDraft({ type: "setSecretClear", key, value: event.target.checked })}
                  />
                  {t("common.clear")}
                </label>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
