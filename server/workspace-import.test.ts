import type { PaseoApi } from "@getpaseo/client";
import { describe, expect, it, vi } from "vitest";
import type { ImportClient } from "./local-import-client.js";
import { canonicalSessionCwd } from "./session-persistence.js";
import { WorkspaceImports } from "./workspace-import.js";

const B = process.cwd();
const NATIVE_ID = "01a186d8-0c8d-7272-9f2f-e42a96544199";
const handle = (version = 2, workspaceCwd = "/old/workspace/A") =>
  `plugin:${JSON.stringify({ version, data: { sessionId: NATIVE_ID, workspaceCwd } })}`;

const openAgent = (sessionId = handle(1), extra = {}) => ({
  agent: {
    provider: "traecli-queue",
    status: "idle",
    workspaceId: "workspace-A",
    persistence: { sessionId },
    archivedAt: null,
    ...extra,
  },
});
const candidate = (sessionId = handle()) => ({
  providerId: "traecli-queue",
  providerLabel: "TraeX",
  providerHandleId: sessionId,
  cwd: B,
  title: "A saved session",
  firstPromptPreview: "Preview",
  lastPromptPreview: null,
  lastActivityAt: "2026-10-29T00:00:00Z",
});

function setup() {
  const refresh = vi.fn().mockResolvedValue({ id: "workspace-B" });
  const ref = vi.fn().mockReturnValue({ id: "workspace-B", directory: B, refresh });
  const agents = vi.fn().mockResolvedValue({
    entries: [],
    pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
  });
  const paseo = { workspaces: { ref }, agents: { list: agents } } as unknown as PaseoApi;
  const client = {
    connect: vi.fn<ImportClient["connect"]>().mockResolvedValue(),
    close: vi.fn<ImportClient["close"]>().mockResolvedValue(),
    listHosts: vi.fn<ImportClient["listHosts"]>().mockResolvedValue({
      self: { serverId: "this-host", label: "This host" },
      hosts: [],
    }),
    fetchRecentProviderSessions: vi.fn<ImportClient["fetchRecentProviderSessions"]>(),
    importAgent: vi.fn<ImportClient["importAgent"]>(),
  };
  client.importAgent.mockResolvedValue({
    id: "agent-in-B",
    cwd: B,
    workspaceId: "workspace-B",
  } as Awaited<ReturnType<ImportClient["importAgent"]>>);
  const createClient = vi.fn().mockResolvedValue({ client, serverId: "this-host" });
  return {
    service: new WorkspaceImports(createClient),
    createClient,
    client,
    paseo,
    refresh,
    ref,
    agents,
  };
}

describe("workspace-bound imports", () => {
  it("lists all source directories using the panel's explicit destination", async () => {
    const { service, paseo, client, ref, refresh } = setup();
    client.fetchRecentProviderSessions.mockResolvedValue({
      requestId: "list",
      entries: [
        {
          providerId: "traecli-queue",
          providerLabel: "TraeX",
          providerHandleId: handle(),
          cwd: "/old/workspace/A",
          title: "Saved conversation",
          firstPromptPreview: "First prompt",
          lastPromptPreview: null,
          lastActivityAt: "2026-10-29T00:00:00Z",
        },
      ],
      filteredAlreadyImportedCount: 2,
      providerErrors: [{ provider: "traecli-queue", message: "Partial listing" }],
    });
    const result = await service.list(paseo, {
      workspaceId: "workspace-B",
      query: "Saved",
      limit: 100,
    });
    expect(ref).toHaveBeenCalledWith("workspace-B");
    expect(refresh).toHaveBeenCalledOnce();
    expect(client.fetchRecentProviderSessions).toHaveBeenCalledWith({
      providers: ["traecli-queue"],
      query: "Saved",
      limit: 200,
    });
    expect(result).toMatchObject({
      workspaceId: "workspace-B",
      directory: B,
      filteredAlreadyImportedCount: 2,
      errors: ["Partial listing"],
      entries: [{ title: "Saved conversation", preview: "First prompt\n原目录：/old/workspace/A" }],
    });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it.each([1, 2])("rebinds a v%i handle from A to B even when the list lost B", async (version) => {
    const { service, paseo, client } = setup();
    expect(
      await service.import(paseo, {
        workspaceId: "workspace-B",
        providerHandleId: handle(version),
      }),
    ).toEqual({ agentId: "agent-in-B", workspaceId: "workspace-B", cwd: B });
    expect(client.importAgent).toHaveBeenCalledWith({
      providerId: "traecli-queue",
      providerHandleId: handle(2, await canonicalSessionCwd(B)),
      cwd: B,
      workspaceId: "workspace-B",
    });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("does not label an equivalent source path as a different directory", async () => {
    const { service, paseo, client } = setup();
    client.fetchRecentProviderSessions.mockResolvedValue({
      requestId: "list",
      entries: [{ ...candidate(), cwd: `${B}/.` }],
    });
    const result = await service.list(paseo, { workspaceId: "workspace-B", query: "", limit: 50 });
    expect(result.entries[0]).toMatchObject({ preview: "Preview", providerHandleId: handle() });
  });

  it("does not claim success if the daemon returns an agent in the old workspace", async () => {
    const { service, paseo, client } = setup();
    client.importAgent.mockResolvedValue({
      id: "old-agent",
      workspaceId: "workspace-A",
      cwd: "/old/workspace/A",
    } as Awaited<ReturnType<ImportClient["importAgent"]>>);
    await expect(
      service.import(paseo, { workspaceId: "workspace-B", providerHandleId: handle() }),
    ).rejects.toThrow("未将会话放入目标工作区");
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("fails without falling back when the requested workspace no longer exists", async () => {
    const { service, paseo, client, refresh, createClient } = setup();
    refresh.mockResolvedValue(null);
    await expect(
      service.import(paseo, { workspaceId: "workspace-B", providerHandleId: handle() }),
    ).rejects.toThrow("目标工作区已关闭或不存在");
    expect(createClient).not.toHaveBeenCalled();
    expect(client.importAgent).not.toHaveBeenCalled();
  });

  it("rejects a different daemon before listing or importing", async () => {
    const { service, paseo, client } = setup();
    client.listHosts.mockResolvedValue({
      self: { serverId: "another-host", label: "Another" },
      hosts: [],
    });
    await expect(
      service.import(paseo, { workspaceId: "workspace-B", providerHandleId: handle() }),
    ).rejects.toThrow("主机已变化");
    expect(client.importAgent).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("closes the compatibility connection after import or connection failure", async () => {
    const { service, paseo, client } = setup();
    client.importAgent.mockRejectedValue(new Error("Session locked"));
    await expect(
      service.import(paseo, { workspaceId: "workspace-B", providerHandleId: handle() }),
    ).rejects.toThrow("Session locked");
    expect(client.close).toHaveBeenCalledOnce();
    client.connect.mockRejectedValue(new Error("Offline"));
    await expect(
      service.import(paseo, { workspaceId: "workspace-B", providerHandleId: handle() }),
    ).rejects.toThrow("Offline");
    expect(client.close).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid persistence and stops accepting work after disposal", async () => {
    const { service, paseo, client, createClient } = setup();
    await expect(
      service.import(paseo, { workspaceId: "workspace-B", providerHandleId: "not-a-session" }),
    ).rejects.toThrow("无效的 TraeX 会话");
    await service.dispose();
    await expect(
      service.import(paseo, { workspaceId: "workspace-B", providerHandleId: handle() }),
    ).rejects.toThrow("导入服务已关闭");
    expect(createClient).not.toHaveBeenCalled();
    expect(client.importAgent).not.toHaveBeenCalled();
  });

  it("hides native duplicates from another workspace before applying the display limit", async () => {
    const { service, paseo, client, agents } = setup();
    agents.mockResolvedValue({ entries: [openAgent()], pageInfo: { hasMore: false } });
    const available = candidate('plugin:{"version":1,"data":{"sessionId":"available"}}');
    client.fetchRecentProviderSessions.mockResolvedValue({
      requestId: "list",
      entries: [candidate(), available],
      filteredAlreadyImportedCount: 2,
    });
    const result = await service.list(paseo, { workspaceId: "workspace-B", query: "", limit: 1 });
    expect(result.entries.map((entry) => entry.providerHandleId)).toEqual([
      available.providerHandleId,
    ]);
    expect(result.filteredAlreadyImportedCount).toBe(3);
    expect(agents).toHaveBeenCalledWith({
      includeBackground: true,
      filter: { includeArchived: false, includeBackground: true },
      page: { limit: 200 },
    });
  });

  it.each([1, 2])(
    "blocks stale v%i handles when the native session is already open in A",
    async (version) => {
      const { service, paseo, client, agents, createClient } = setup();
      agents.mockResolvedValue({
        entries: [openAgent(handle(2, "/other/A"))],
        pageInfo: { hasMore: false },
      });
      await expect(
        service.import(paseo, { workspaceId: "workspace-B", providerHandleId: handle(version) }),
      ).rejects.toThrow("该会话已在 Paseo 中打开");
      expect(createClient).not.toHaveBeenCalled();
      expect(client.importAgent).not.toHaveBeenCalled();
    },
  );

  it("checks later agent pages and runtime/native handles without hiding unrelated providers", async () => {
    const { service, paseo, client, agents } = setup();
    agents
      .mockResolvedValueOnce({ entries: [], pageInfo: { hasMore: true, nextCursor: "page-2" } })
      .mockResolvedValueOnce({
        entries: [
          openAgent("ignored", {
            persistence: null,
            runtimeInfo: { sessionId: NATIVE_ID },
            status: "running",
          }),
        ],
        pageInfo: { hasMore: false },
      });
    await expect(
      service.import(paseo, { workspaceId: "workspace-B", providerHandleId: handle() }),
    ).rejects.toThrow("已在 Paseo 中打开");
    expect(agents.mock.calls[1][0].page.cursor).toBe("page-2");
    agents.mockResolvedValue({
      entries: [
        openAgent(handle(), { provider: "codex" }),
        openAgent(handle(), { archivedAt: "2026-10-29T00:00:00Z" }),
      ],
      pageInfo: { hasMore: false },
    });
    await expect(
      service.import(paseo, { workspaceId: "workspace-B", providerHandleId: handle() }),
    ).resolves.toMatchObject({ agentId: "agent-in-B" });
    expect(client.importAgent).toHaveBeenCalledOnce();
  });

  it("rejects incomplete agent pagination rather than risking a duplicate import", async () => {
    const { service, paseo, client, agents } = setup();
    agents.mockResolvedValue({ entries: [], pageInfo: { hasMore: true, nextCursor: "repeated" } });
    await expect(
      service.import(paseo, { workspaceId: "workspace-B", providerHandleId: handle() }),
    ).rejects.toThrow("无法完整读取已打开的会话");
    expect(client.importAgent).not.toHaveBeenCalled();
  });

  it("serializes concurrent imports of the same native session across workspaces and releases failures", async () => {
    const { service, paseo, client } = setup();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    client.importAgent.mockImplementationOnce(async () => {
      started();
      await hold;
      throw new Error("Original CLI still owns the session");
    });
    const first = service.import(paseo, {
      workspaceId: "workspace-B",
      providerHandleId: handle(1),
    });
    const failed = expect(first).rejects.toThrow("Original CLI still owns the session");
    await entered;
    await expect(
      service.import(paseo, { workspaceId: "workspace-C", providerHandleId: handle(2, "/C") }),
    ).rejects.toThrow("该会话正在导入");
    client.fetchRecentProviderSessions.mockResolvedValue({
      requestId: "list",
      entries: [candidate()],
    });
    expect(
      (await service.list(paseo, { workspaceId: "workspace-B", query: "", limit: 50 })).entries,
    ).toEqual([]);
    finish();
    await failed;
    await expect(
      service.import(paseo, { workspaceId: "workspace-B", providerHandleId: handle() }),
    ).resolves.toMatchObject({ agentId: "agent-in-B" });
    expect(client.importAgent).toHaveBeenCalledTimes(2);
  });
});
