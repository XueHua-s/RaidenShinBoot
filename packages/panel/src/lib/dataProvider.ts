import type {
  BaseRecord,
  CreateParams,
  CreateResponse,
  DataProvider,
  GetListParams,
  GetListResponse
} from "@refinedev/core";
import type {
  AdminSessionDto,
  AdminUserDto,
  AuditLogDto,
  MemoryDto,
  MessageDto,
  TelegramChatDto,
  TelegramCommandPermissionDto,
  TelegramUserDto
} from "@raiden/shared";
import { apiClient, apiBaseUrl, readJson } from "./apiClient.js";

type ListResponse<T> = {
  data: T[];
  total: number;
};

function queryFromPagination(params: Parameters<NonNullable<DataProvider["getList"]>>[0]) {
  const current = params.pagination?.current ?? 1;
  const pageSize = params.pagination?.pageSize ?? 20;

  return {
    limit: String(pageSize),
    offset: String((current - 1) * pageSize)
  };
}

export const dataProvider: DataProvider = {
  getApiUrl: () => apiBaseUrl,
  getList: async <TData extends BaseRecord = BaseRecord>(
    params: GetListParams
  ): Promise<GetListResponse<TData>> => {
    const query = queryFromPagination(params);

    if (params.resource === "users") {
      const response = await apiClient.api.users.$get({ query });
      const payload = await readJson<ListResponse<TelegramUserDto>>(response);
      return payload as unknown as GetListResponse<TData>;
    }

    if (params.resource === "messages") {
      const response = await apiClient.api.messages.$get({ query });
      const payload = await readJson<ListResponse<MessageDto>>(response);
      return payload as unknown as GetListResponse<TData>;
    }

    if (params.resource === "memories") {
      const response = await apiClient.api.memories.$get({ query });
      const payload = await readJson<ListResponse<MemoryDto>>(response);
      return payload as unknown as GetListResponse<TData>;
    }

    if (params.resource === "telegram-chats") {
      const response = await apiClient.api.telegram.chats.$get({ query });
      const payload = await readJson<ListResponse<TelegramChatDto>>(response);
      return payload as unknown as GetListResponse<TData>;
    }

    if (params.resource === "telegram-command-permissions") {
      const response = await apiClient.api.telegram["command-permissions"].$get({ query });
      const payload = await readJson<ListResponse<TelegramCommandPermissionDto>>(response);
      return payload as unknown as GetListResponse<TData>;
    }

    if (params.resource === "admin-users") {
      const response = await apiClient.api["admin-users"].$get({ query });
      const payload = await readJson<ListResponse<AdminUserDto>>(response);
      return payload as unknown as GetListResponse<TData>;
    }

    if (params.resource === "admin-sessions") {
      const response = await apiClient.api["admin-sessions"].$get({ query });
      const payload = await readJson<ListResponse<AdminSessionDto>>(response);
      return payload as unknown as GetListResponse<TData>;
    }

    if (params.resource === "audit-logs") {
      const response = await apiClient.api["audit-logs"].$get({ query });
      const payload = await readJson<ListResponse<AuditLogDto>>(response);
      return payload as unknown as GetListResponse<TData>;
    }

    throw new Error(`Unknown resource: ${params.resource}`);
  },
  getOne: async () => {
    throw new Error("getOne is not implemented for this panel");
  },
  create: async <TData extends BaseRecord = BaseRecord, TVariables = {}>({
    resource,
    variables
  }: CreateParams<TVariables>): Promise<CreateResponse<TData>> => {
    if (resource === "memories") {
      const response = await apiClient.api.memories.$post({
        json: variables as {
          telegramUserId: string;
          summary: string;
          importance: number;
        }
      });
      const payload = await readJson<{ data: MemoryDto }>(response);
      return payload as unknown as CreateResponse<TData>;
    }

    throw new Error(`Create is not implemented for ${resource}`);
  },
  update: async () => {
    throw new Error("update is not implemented for this panel");
  },
  deleteOne: async () => {
    throw new Error("deleteOne is not implemented for this panel");
  }
};
