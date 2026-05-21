import type { AuditLogDto } from "@raiden/shared";
import { EmptyRow, ResourcePage } from "../components/page.js";
import { Badge } from "../components/ui/badge.js";
import { Card, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Table, Td, Th } from "../components/ui/table.js";
import { useResourceList } from "../hooks/useResourceList.js";
import { useI18n } from "../lib/i18n.js";

export function AuditPage() {
  const { t, formatDate } = useI18n();
  const { data, total, loading, error, reload } = useResourceList<AuditLogDto>("audit-logs", 50);

  return (
    <ResourcePage title={t("audit.title")} description={t("audit.description")} error={error} loading={loading} onRefresh={reload}>
      <Card>
        <CardHeader>
          <CardTitle>{t("audit.log")}</CardTitle>
          <CardDescription>{t("audit.count", { count: total })}</CardDescription>
        </CardHeader>
        <div className="overflow-x-auto">
          <Table>
            <thead className="bg-zinc-50">
              <tr>
                <Th>{t("audit.action")}</Th>
                <Th>{t("audit.actor")}</Th>
                <Th>{t("audit.target")}</Th>
                <Th>{t("audit.ip")}</Th>
                <Th>{t("common.created")}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {data.map((item) => (
                <tr className="hover:bg-zinc-50" key={item.id}>
                  <Td>
                    <Badge tone="info">{item.action}</Badge>
                  </Td>
                  <Td>{item.actorUsername ?? t("common.system")}</Td>
                  <Td>
                    {item.targetType}
                    {item.targetId ? <span className="font-mono text-xs text-zinc-500">:{item.targetId}</span> : null}
                  </Td>
                  <Td>{item.ipAddress ?? "-"}</Td>
                  <Td>{formatDate(item.createdAt)}</Td>
                </tr>
              ))}
              {data.length === 0 && <EmptyRow colSpan={5}>{t("audit.empty")}</EmptyRow>}
            </tbody>
          </Table>
        </div>
      </Card>
    </ResourcePage>
  );
}
