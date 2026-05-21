import { useCallback } from "react";
import { useList, type BaseRecord } from "@refinedev/core";
import { errorMessage } from "../lib/utils.js";

export function useResourceList<T extends BaseRecord>(resource: string, pageSize: number) {
  const result = useList<T>({
    resource,
    pagination: { current: 1, pageSize, mode: "server" },
    queryOptions: { retry: false }
  });
  const { refetch } = result;

  const reload = useCallback(async () => {
    await refetch();
  }, [refetch]);

  return {
    data: result.data?.data ?? [],
    total: result.data?.total ?? 0,
    loading: result.isFetching,
    error: result.error ? errorMessage(result.error) : null,
    reload
  };
}
