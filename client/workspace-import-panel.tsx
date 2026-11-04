import { useRpc, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { formatImportErrorMessage } from "./workspace-import-error.js";
import {
  importIntoWorkspace,
  listWorkspaceImports,
  type WorkspaceImportEntry,
} from "../shared/workspace-import.js";

export function WorkspaceImportPanel(props: PluginWorkspacePanelProps) {
  // A panel can be reused after switching workspaces or hosts. Remount the form
  // so its search, pending state and success link belong to exactly one target.
  return <WorkspaceImportForm key={`${props.host.id}/${props.workspaceId}`} {...props} />;
}

function WorkspaceImportForm({
  workspaceId,
  theme: { colors },
  host,
  layout,
  navigation,
}: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, (value) => ({
    name: value.title || value.name,
    directory: value.directory,
  }));
  const list = useRpc(listWorkspaceImports);
  const importSession = useRpc(importIntoWorkspace);
  const cache = useQueryClient();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(50);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshing = useRef(false);
  const [imported, setImported] = useState<{ agentId: string; title: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setLimit(50);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const sessions = useQuery({
    queryKey: ["trae-workspace-imports", host.id, workspaceId, query, limit],
    queryFn: () => list({ workspaceId, query, limit }),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const importing = useMutation({
    mutationFn: (entry: WorkspaceImportEntry) =>
      importSession({ workspaceId, providerHandleId: entry.providerHandleId }),
    onSuccess: (result, entry) => {
      void cache.invalidateQueries({
        queryKey: ["trae-workspace-imports", host.id, workspaceId],
      });
      if (!mounted.current) return;
      setImported({ agentId: result.agentId, title: entry.title || "TraeX 会话" });
      navigation?.openAgent({ agentId: result.agentId, serverId: host.id });
    },
    onError: () => {
      void cache.invalidateQueries({ queryKey: ["trae-workspace-imports", host.id, workspaceId] });
    },
  });
  const directory = sessions.data?.directory ?? workspace?.directory;
  const searchText = search.trim().toLowerCase();
  const entries = (sessions.data?.entries ?? []).filter(
    (entry) =>
      !searchText ||
      [entry.title, entry.preview].some((value) => value?.toLowerCase().includes(searchText)),
  );
  const isSearching = search.trim() !== query || (sessions.isFetching && !!searchText);
  const isLoading = sessions.isFetching || isSearching;
  const refresh = async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    setIsRefreshing(true);
    try {
      // Reuse a search already in progress. A background fetch must not make
      // the refresh control permanently unavailable or launch duplicate RPCs.
      await sessions.refetch({ cancelRefetch: false });
    } finally {
      refreshing.current = false;
      if (mounted.current) setIsRefreshing(false);
    }
  };
  const text = { color: colors.foreground, fontSize: 14, lineHeight: 21 };
  const muted = { color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 };
  const button = {
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={{ ...text, fontSize: 20, fontWeight: "600" }}>导入 TraeX 会话</Text>
      <View style={{ padding: 16, borderRadius: 10, backgroundColor: colors.surface1, gap: 4 }}>
        <Text style={muted}>导入到当前工作区 · {host.label}</Text>
        <Text style={{ ...text, fontWeight: "600" }}>{workspace?.name ?? "当前工作区"}</Text>
        {directory ? (
          <Text style={muted} selectable>
            {directory}
          </Text>
        ) : null}
        <Text style={muted}>可选择任意原目录的会话，保留历史并在此目录继续。</Text>
      </View>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <TextInput
          testID="trae-session-search"
          accessibilityLabel="搜索 TraeX 历史会话"
          placeholder="搜索会话标题或首条消息"
          placeholderTextColor={colors.foregroundMuted}
          value={search}
          onChangeText={setSearch}
          maxLength={200}
          autoCapitalize="none"
          autoCorrect={false}
          style={{
            ...text,
            flex: 1,
            minWidth: 0,
            minHeight: 44,
            paddingHorizontal: 12,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 8,
          }}
        />
        <Pressable
          testID="trae-session-refresh"
          accessibilityRole="button"
          accessibilityLabel="刷新会话列表"
          accessibilityState={{ disabled: isRefreshing, busy: isRefreshing }}
          disabled={isRefreshing}
          onPress={() => void refresh()}
          style={{ ...button, flexDirection: "row", gap: 6, opacity: isRefreshing ? 0.6 : 1 }}
        >
          {isRefreshing ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : (
            <Icon name="RefreshCw" size={18} color={colors.foreground} />
          )}
          <Text style={text}>{isRefreshing ? "刷新中…" : "刷新"}</Text>
        </Pressable>
      </View>
      <View
        testID="trae-session-list-status"
        accessibilityLiveRegion="polite"
        style={{ flexDirection: "row", alignItems: "center", minHeight: 22, gap: 8 }}
      >
        {isLoading ? <ActivityIndicator size="small" color={colors.accent} /> : null}
        <Text style={muted}>
          {isRefreshing
            ? "正在刷新会话…"
            : isSearching
              ? "正在搜索…"
              : sessions.isFetching
                ? "正在加载会话…"
                : sessions.isError
                  ? "会话列表更新失败"
                  : `显示 ${entries.length} 条会话`}
          {!isLoading && sessions.dataUpdatedAt > 0
            ? ` · 更新于 ${new Date(sessions.dataUpdatedAt).toLocaleTimeString()}`
            : ""}
        </Text>
      </View>
      {imported ? (
        <View style={{ gap: 8 }}>
          <Text style={text}>已将「{imported.title}」导入当前工作区。</Text>
          {navigation ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => navigation.openAgent({ agentId: imported.agentId, serverId: host.id })}
              style={button}
            >
              <Text style={{ ...text, color: colors.accent }}>打开已导入的会话</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {[sessions.error?.message, importing.error?.message, ...(sessions.data?.errors ?? [])]
        .filter(Boolean)
        .map((message, index) => (
          <Text
            key={index}
            accessibilityRole="alert"
            style={{ ...text, color: colors.statusDanger }}
          >
            {message ? formatImportErrorMessage(message) : null}
          </Text>
        ))}
      {!isLoading && !sessions.isError && entries.length === 0 ? (
        <Text style={muted}>
          {query
            ? "没有找到匹配的会话。"
            : "暂无可导入的会话，已在 Paseo 任意工作区打开的会话不会重复显示。"}
        </Text>
      ) : null}
      {entries.map((entry) => {
        const busy =
          importing.isPending && importing.variables?.providerHandleId === entry.providerHandleId;
        return (
          <View
            key={entry.providerHandleId}
            style={{
              gap: 8,
              padding: 16,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 10,
              backgroundColor: colors.surface1,
            }}
          >
            <Text style={{ ...text, fontWeight: "600" }} numberOfLines={2}>
              {entry.title || "未命名 TraeX 会话"}
            </Text>
            {entry.preview ? (
              <Text style={muted} numberOfLines={4}>
                {entry.preview}
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`将${entry.title || "此会话"}导入当前工作区`}
              accessibilityState={{ disabled: importing.isPending, busy }}
              disabled={importing.isPending}
              onPress={() => {
                setImported(null);
                importing.mutate(entry);
              }}
              style={{ ...button, alignSelf: "flex-start", opacity: importing.isPending ? 0.6 : 1 }}
            >
              <Text style={{ ...text, color: colors.accent }}>
                {busy ? "正在导入…" : "导入到此工作区"}
              </Text>
            </Pressable>
          </View>
        );
      })}
      {entries.length >= limit && limit < 200 ? (
        <Pressable
          accessibilityRole="button"
          disabled={sessions.isFetching}
          onPress={() => setLimit((value) => Math.min(value + 50, 200))}
          style={button}
        >
          <Text style={text}>{sessions.isFetching ? "正在加载…" : "显示更多会话"}</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
