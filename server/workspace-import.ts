import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { createLocalImportClient, type ImportClient } from "./local-import-client.js";
import {
  canonicalSessionCwd,
  nativeSessionIdFromHandle,
  workspaceSessionPersistence,
} from "./session-persistence.js";

const persistenceSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  data: z.object({ sessionId: z.string().min(1), workspaceCwd: z.string().optional() }),
});

export class WorkspaceImports {
  private readonly clients = new Set<ImportClient>();
  private readonly importing = new Set<string>();
  private disposed = false;

  constructor(private readonly createClient = createLocalImportClient) {}

  private async openNativeSessions(paseo: PaseoApi): Promise<Set<string>> {
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      // Include background workspaces and every page. An unarchived card still
      // owns this conversation even if its runtime has gone idle or disconnected.
      // oxlint-disable-next-line no-await-in-loop
      const page = await paseo.agents.list({
        includeBackground: true,
        filter: { includeArchived: false, includeBackground: true },
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      for (const { agent } of page.entries) {
        if (agent.archivedAt || !["traecli-queue", "traecli", "trae"].includes(agent.provider))
          continue;
        const id =
          nativeSessionIdFromHandle(agent.persistence?.sessionId) ??
          nativeSessionIdFromHandle(agent.runtimeInfo?.sessionId);
        if (id) ids.add(id);
      }
      if (!page.pageInfo.hasMore) break;
      const next = page.pageInfo.nextCursor;
      if (!next || cursors.has(next)) throw new Error("无法完整读取已打开的会话，请刷新后重试。");
      cursors.add(next);
      cursor = next;
    } while (cursor);
    return ids;
  }

  private async destination(paseo: PaseoApi, workspaceId: string) {
    const workspace = paseo.workspaces.ref(workspaceId);
    const snapshot = await workspace.refresh();
    if (!snapshot || !workspace.directory)
      throw new Error("目标工作区已关闭或不存在，请从工作区重新打开导入面板。");
    return { workspaceId: workspace.id, cwd: workspace.directory };
  }

  private async run<T>(paseo: PaseoApi, action: (client: ImportClient) => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error("导入服务已关闭，请重新打开面板。");
    const { client, serverId } = await this.createClient(paseo);
    this.clients.add(client);
    try {
      if (this.disposed) throw new Error("导入服务已关闭，请重新打开面板。");
      await client.connect();
      const hosts = await client.listHosts();
      if (hosts.self.serverId !== serverId)
        throw new Error("导入服务连接的 Paseo 主机已变化，请刷新后重试。");
      return await action(client);
    } finally {
      this.clients.delete(client);
      await client.close();
    }
  }

  async list(paseo: PaseoApi, input: { workspaceId: string; query: string; limit: number }) {
    const destination = await this.destination(paseo, input.workspaceId);
    return this.run(paseo, async (client) => {
      const result = await client.fetchRecentProviderSessions({
        providers: ["traecli-queue"],
        // Only the plugin panel imports across directories. Query the unscoped
        // source catalog; the explicit workspace ID remains the destination.
        query: input.query,
        // The daemon API accepts at most 200 candidates. Filter native IDs before
        // slicing the panel's page so an open card in A cannot crowd out imports.
        limit: 200,
      });
      const opened = await this.openNativeSessions(paseo);
      const entries = result.entries.filter((entry) => {
        const id = nativeSessionIdFromHandle(entry.providerHandleId);
        return !id || (!opened.has(id) && !this.importing.has(id));
      });
      const destinationCwd = await canonicalSessionCwd(destination.cwd);
      const summaries = await Promise.all(
        entries.slice(0, input.limit).map(async (entry) => ({
          providerHandleId: entry.providerHandleId,
          title: entry.title,
          preview:
            [
              entry.firstPromptPreview ?? entry.lastPromptPreview,
              (await canonicalSessionCwd(entry.cwd)) !== destinationCwd
                ? `原目录：${entry.cwd}`
                : null,
            ]
              .filter(Boolean)
              .join("\n") || null,
          lastActivityAt: entry.lastActivityAt,
        })),
      );
      return {
        workspaceId: destination.workspaceId,
        directory: destination.cwd,
        entries: summaries,
        filteredAlreadyImportedCount:
          (result.filteredAlreadyImportedCount ?? 0) + result.entries.length - entries.length,
        errors: result.providerErrors?.map((error) => error.message) ?? [],
      };
    });
  }

  async import(paseo: PaseoApi, input: { workspaceId: string; providerHandleId: string }) {
    if (!input.providerHandleId.startsWith("plugin:")) throw new Error("无效的 TraeX 会话。");
    let value: unknown;
    try {
      value = JSON.parse(input.providerHandleId.slice("plugin:".length));
    } catch {
      throw new Error("无效的 TraeX 会话恢复标识，请刷新列表。");
    }
    const persistence = persistenceSchema.safeParse(value);
    if (!persistence.success) throw new Error("无效的 TraeX 会话恢复标识，请刷新列表。");
    const nativeId = persistence.data.data.sessionId;
    if (this.importing.has(nativeId)) throw new Error("该会话正在导入，请等待完成后打开现有会话。");
    this.importing.add(nativeId);
    try {
      const destination = await this.destination(paseo, input.workspaceId);
      if ((await this.openNativeSessions(paseo)).has(nativeId))
        throw new Error("该会话已在 Paseo 中打开，请使用现有会话，或先关闭原会话后再导入。");
      // The panel owns the destination. Discard any source directory embedded in
      // handles from an unscoped list or an older plugin, then bind all three core
      // inputs to this workspace. Never fall back to the entry's original cwd.
      const handle = workspaceSessionPersistence(
        persistence.data,
        await canonicalSessionCwd(destination.cwd),
      );
      return await this.run(paseo, async (client) => {
        const agent = await client.importAgent({
          providerId: "traecli-queue",
          providerHandleId: `plugin:${JSON.stringify(handle)}`,
          cwd: destination.cwd,
          workspaceId: destination.workspaceId,
        });
        if (
          agent.workspaceId !== destination.workspaceId ||
          (await canonicalSessionCwd(agent.cwd)) !== (await canonicalSessionCwd(destination.cwd))
        )
          throw new Error("Paseo 未将会话放入目标工作区，请刷新后重试。");
        return { agentId: agent.id, workspaceId: destination.workspaceId, cwd: destination.cwd };
      });
    } finally {
      this.importing.delete(nativeId);
    }
  }

  async dispose() {
    this.disposed = true;
    await Promise.allSettled([...this.clients].map((client) => client.close()));
  }
}
