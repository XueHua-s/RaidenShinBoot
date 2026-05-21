import { FormEvent, useState } from "react";
import { Navigate } from "react-router-dom";
import type { AdminSessionDto, AdminUserDto } from "@raiden/shared";
import { ResourcePage, statusTone } from "../components/page.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Input, Label } from "../components/ui/input.js";
import { Table, Td, Th } from "../components/ui/table.js";
import { useResourceList } from "../hooks/useResourceList.js";
import { apiClient, readJson } from "../lib/apiClient.js";
import { useI18n } from "../lib/i18n.js";
import { errorMessage } from "../lib/utils.js";

export function SecurityPage({ user }: { user: AdminUserDto }) {
  const { t, formatRole, formatStatus, formatDate } = useI18n();
  const admins = useResourceList<AdminUserDto>("admin-users", 50);
  const sessions = useResourceList<AdminSessionDto>("admin-sessions", 20);
  const [form, setForm] = useState({ username: "", displayName: "", password: "", role: "operator" as AdminUserDto["role"] });
  const [mutationError, setMutationError] = useState<string | null>(null);

  if (user.role !== "super_admin") {
    return <Navigate to="/" replace />;
  }

  async function createAdmin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMutationError(null);
    try {
      const response = await apiClient.api["admin-users"].$post({
        json: {
          username: form.username,
          displayName: form.displayName || undefined,
          password: form.password,
          role: form.role
        }
      });
      await readJson<{ data: AdminUserDto }>(response);
      setForm({ username: "", displayName: "", password: "", role: "operator" });
      await admins.reload();
    } catch (requestError) {
      setMutationError(errorMessage(requestError));
    }
  }

  async function setAdminStatus(id: string, status: AdminUserDto["status"]) {
    setMutationError(null);
    try {
      const response = await apiClient.api["admin-users"][":id"].$patch({
        param: { id },
        json: { status }
      });
      await readJson<{ data: AdminUserDto }>(response);
      await admins.reload();
    } catch (requestError) {
      setMutationError(errorMessage(requestError));
    }
  }

  return (
    <ResourcePage
      title={t("security.title")}
      description={t("security.description")}
      error={admins.error ?? sessions.error ?? mutationError}
      loading={admins.loading || sessions.loading}
      onRefresh={() => {
        admins.reload();
        sessions.reload();
      }}
    >
      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader>
            <CardTitle>{t("security.adminAccounts")}</CardTitle>
            <CardDescription>{t("security.accountCount", { count: admins.total })}</CardDescription>
          </CardHeader>
          <div className="overflow-x-auto">
            <Table>
              <thead className="bg-zinc-50">
                <tr>
                  <Th>{t("security.admin")}</Th>
                  <Th>{t("common.role")}</Th>
                  <Th>{t("common.status")}</Th>
                  <Th>{t("security.lastLogin")}</Th>
                  <Th className="text-right">{t("common.actions")}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {admins.data.map((admin) => (
                  <tr className="hover:bg-zinc-50" key={admin.id}>
                    <Td>
                      <div className="font-semibold text-zinc-950">{admin.displayName ?? admin.username}</div>
                      <div className="text-xs text-zinc-500">{admin.username}</div>
                    </Td>
                    <Td>
                      <Badge tone={admin.role === "super_admin" ? "ink" : "neutral"}>{formatRole(admin.role)}</Badge>
                    </Td>
                    <Td>
                      <Badge tone={statusTone(admin.status)}>{formatStatus(admin.status)}</Badge>
                    </Td>
                    <Td>{formatDate(admin.lastLoginAt)}</Td>
                    <Td>
                      <div className="flex justify-end gap-2">
                        <Button
                          disabled={admin.id === user.id}
                          onClick={() => setAdminStatus(admin.id, admin.status === "active" ? "disabled" : "active")}
                          size="sm"
                          variant={admin.status === "active" ? "destructive" : "secondary"}
                        >
                          {admin.status === "active" ? t("security.disable") : t("security.enable")}
                        </Button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("security.createAdmin")}</CardTitle>
            <CardDescription>{t("security.createDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-3" onSubmit={createAdmin}>
              <Label>
                {t("security.username")}
                <Input value={form.username} onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))} />
              </Label>
              <Label>
                {t("security.displayName")}
                <Input
                  value={form.displayName}
                  onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))}
                />
              </Label>
              <Label>
                {t("security.password")}
                <Input
                  type="password"
                  value={form.password}
                  onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
                />
              </Label>
              <Label>
                {t("common.role")}
                <select
                  className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                  value={form.role}
                  onChange={(event) => setForm((current) => ({ ...current, role: event.target.value as AdminUserDto["role"] }))}
                >
                  <option value="operator">{formatRole("operator")}</option>
                  <option value="auditor">{formatRole("auditor")}</option>
                  <option value="super_admin">{formatRole("super_admin")}</option>
                </select>
              </Label>
              <Button disabled={!form.username.trim() || form.password.length < 12} type="submit">
                {t("common.create")}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t("security.recentSessions")}</CardTitle>
          <CardDescription>{t("security.sessionCount", { count: sessions.total })}</CardDescription>
        </CardHeader>
        <div className="overflow-x-auto">
          <Table>
            <thead className="bg-zinc-50">
              <tr>
                <Th>{t("common.user")}</Th>
                <Th>{t("common.role")}</Th>
                <Th>{t("common.created")}</Th>
                <Th>{t("security.expires")}</Th>
                <Th>{t("common.status")}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {sessions.data.map((session) => (
                <tr key={session.id}>
                  <Td>{session.username}</Td>
                  <Td>{formatRole(session.role)}</Td>
                  <Td>{formatDate(session.createdAt)}</Td>
                  <Td>{formatDate(session.expiresAt)}</Td>
                  <Td>
                    <Badge tone={session.revokedAt ? "danger" : "success"}>{formatStatus(session.revokedAt ? "revoked" : "active")}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </Card>
    </ResourcePage>
  );
}
