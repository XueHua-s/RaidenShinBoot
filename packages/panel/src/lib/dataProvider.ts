import type {
  BaseRecord,
  CreateParams,
  CreateResponse,
  DataProvider,
  GetListParams,
  GetListResponse
} from "@refinedev/core";
import type { MemoryDto, MessageDto, TelegramUserDto } from "@raiden/shared";
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
