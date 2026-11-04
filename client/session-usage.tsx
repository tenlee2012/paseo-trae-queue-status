import type { PaseoAgent, PaseoAgentListResult } from "@getpaseo/client";
import type {
  PluginButtonContentProps,
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { useAgent, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import {
  emptySessionUsage,
  getSessionUsage,
  type SessionUsageSnapshot,
} from "../shared/session-usage.js";
import { formatCost, formatTokenCost, formatTokens } from "./model-usage.js";

const unavailable: SessionUsageSnapshot = {
  ...emptySessionUsage,
  refreshError: "会话用量暂未提供，请稍后重试。",
};
const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

interface SessionUsageTarget {
  agentId: string;
  sessionKey: string | null;
  publish(snapshot: SessionUsageSnapshot): void;
}

function useSessionUsage({ agentId, sessionKey, publish }: SessionUsageTarget) {
  const queryUsage = useRpc(getSessionUsage);
  const status = useAgent(agentId, (agent) => agent?.status ?? null);
  const previousStatus = useRef(status);
  const query = useQuery({
    queryKey: ["trae-session-usage", agentId, sessionKey],
    queryFn: () => queryUsage({ agentId }),
    refetchInterval: 5_000,
    staleTime: 1_000,
    gcTime: 0,
    retry: false,
  });
  const { data, isError, refetch } = query;
  useEffect(() => {
    if (isError) publish(unavailable);
    else if (data) publish(data);
  }, [data, isError, publish]);
  useEffect(() => {
    if (previousStatus.current === status) return;
    previousStatus.current = status;
    void refetch();
  }, [status, refetch]);
  return query;
}

export function SessionUsageIcon({
  size,
  color,
  ...target
}: SessionUsageTarget & Pick<PluginButtonIconProps, "size" | "color">) {
  useSessionUsage(target);
  return <Icon name="Database" size={size} color={color} />;
}

export function SessionUsagePopover({
  theme,
  layout,
  ...target
}: SessionUsageTarget & Pick<PluginButtonContentProps, "theme" | "layout">) {
  const { data, isError, isPending, refetch } = useSessionUsage(target);
  const snapshot = isError ? unavailable : (data ?? emptySessionUsage);
  const rows = [
    { label: "输入 Token", value: snapshot.inputTokens, total: snapshot.tokens },
    {
      label: "缓存读取 Token",
      value: snapshot.cachedInputTokens,
      total: snapshot.inputTokens,
      indent: true,
    },
    {
      label: "缓存创建 Token",
      value: snapshot.cacheCreationInputTokens,
      total: snapshot.inputTokens,
      indent: true,
    },
    { label: "输出 Token", value: snapshot.outputTokens, total: snapshot.tokens },
    { label: "推理 Token", value: snapshot.reasoningOutputTokens, total: snapshot.tokens },
  ];
  return (
    <View style={{ width: layout.compact ? "100%" : 320, maxWidth: "100%", gap: 8 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginBottom: 4 }}>
        {isPending ? "会话用量统计中…" : "本次会话"}
      </Text>
      {rows.map(({ label, value, total, indent }) => (
        <View key={label} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 14,
              flex: 1,
              paddingLeft: indent ? 14 : 0,
            }}
          >
            {label}
          </Text>
          <Text
            selectable
            accessibilityLabel={value === null ? "未提供" : `${formatTokens(value)} tokens`}
            style={{
              color: theme.colors.foreground,
              fontSize: 14,
              fontWeight: "600",
              fontVariant: ["tabular-nums"],
              minWidth: 60,
              textAlign: "right",
            }}
          >
            {value === null ? "未提供" : formatTokens(value)}
          </Text>
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 14,
              fontVariant: ["tabular-nums"],
              minWidth: 48,
              textAlign: "right",
            }}
          >
            {value !== null && total !== null && total > 0
              ? percentFormatter.format(value / total)
              : "—"}
          </Text>
        </View>
      ))}
      <View style={{ borderTopWidth: 1, borderColor: theme.colors.border, marginVertical: 4 }} />
      <View
        style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}
      >
        <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>
          Token 总量
        </Text>
        <Text
          selectable
          accessibilityLabel={
            snapshot.tokens === null
              ? "未提供"
              : `${formatTokens(snapshot.tokens)} tokens | ${formatCost(snapshot.cost)}`
          }
          style={{
            color: theme.colors.foreground,
            fontSize: 14,
            fontWeight: "600",
            fontVariant: ["tabular-nums"],
          }}
        >
          {snapshot.tokens === null ? "未提供" : formatTokenCost(snapshot.tokens, snapshot.cost)}
        </Text>
      </View>
      {snapshot.refreshError ? (
        <View style={{ gap: 8, marginTop: 4 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {snapshot.refreshError}
          </Text>
          <Pressable accessibilityRole="button" onPress={() => void refetch()}>
            <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>重试</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

interface Pill {
  workspaceId: string;
  sessionKey: string | null;
  registration: PluginButtonRegistration;
}

export function contributeSessionUsage(client: PluginClientContext): () => void {
  const pills = new Map<string, Pill>();
  const lifetime = new AbortController();
  let unsubscribe: (() => void) | undefined;
  let revision = 0;
  let changed = new Set<string>();
  const remove = (id: string) => {
    pills.get(id)?.registration.remove();
    pills.delete(id);
  };
  const register = (agent: PaseoAgent) => {
    if (lifetime.signal.aborted) return;
    if (agent.provider !== "traecli-queue" || !agent.workspaceId || agent.archivedAt) {
      remove(agent.id);
      return;
    }
    const agentId = agent.id;
    const workspaceId = agent.workspaceId;
    const sessionKey = agent.persistence?.sessionId ?? agent.runtimeInfo?.sessionId ?? null;
    const previous = pills.get(agentId);
    if (previous?.workspaceId === workspaceId && previous.sessionKey === sessionKey) return;
    remove(agentId);
    let registration: PluginButtonRegistration;
    let signature = "";
    const publish = (snapshot: SessionUsageSnapshot) => {
      if (lifetime.signal.aborted || pills.get(agentId)?.registration !== registration) return;
      const next = JSON.stringify(snapshot);
      if (next === signature) return;
      signature = next;
      registration.update({
        label: snapshot.tokens === null ? "—" : formatTokens(snapshot.tokens),
        title:
          snapshot.tokens === null
            ? (snapshot.refreshError ?? "暂无会话用量记录，点击查看明细。")
            : `本次会话累计 ${formatTokens(snapshot.tokens)} tokens，点击查看明细。`,
      });
    };
    registration = client.addComposerPill({
      id: "session-usage",
      workspaceId,
      agentId,
      button: {
        title: "本次会话 token 用量，点击查看明细。",
        label: "—",
        icon: (props) => (
          <SessionUsageIcon
            {...props}
            agentId={agentId}
            sessionKey={sessionKey}
            publish={publish}
          />
        ),
        behavior: {
          kind: "popover",
          Content: (props) => (
            <SessionUsagePopover
              {...props}
              agentId={agentId}
              sessionKey={sessionKey}
              publish={publish}
            />
          ),
        },
      },
    });
    pills.set(agentId, { workspaceId, sessionKey, registration });
  };
  const reconcile = async (first: PaseoAgentListResult) => {
    const current = ++revision;
    const updates = new Set<string>();
    changed = updates;
    const present = new Set<string>();
    const cursors = new Set<string>();
    let page = first;
    while (!lifetime.signal.aborted) {
      if (current !== revision) return;
      for (const { agent } of page.entries) {
        present.add(agent.id);
        // A live update received during pagination is newer than that page.
        if (!updates.has(agent.id)) register(agent);
      }
      if (!page.pageInfo.hasMore) {
        for (const id of pills.keys()) if (!present.has(id) && !updates.has(id)) remove(id);
        return;
      }
      const cursor = page.pageInfo.nextCursor;
      if (!cursor || cursors.has(cursor)) throw new Error("Incomplete agent directory page");
      cursors.add(cursor);
      // oxlint-disable-next-line no-await-in-loop
      page = await client.paseo.agents.list({
        includeBackground: true,
        page: { limit: 200, cursor },
        signal: lifetime.signal,
      });
    }
  };
  void client.paseo.agents
    .list({
      subscribe: {},
      includeBackground: true,
      page: { limit: 200 },
      signal: lifetime.signal,
    })
    .then(({ subscription }) => {
      if (lifetime.signal.aborted) {
        subscription.release();
        return undefined;
      }
      unsubscribe = subscription.subscribe({
        snapshot: (snapshot) => {
          void reconcile(snapshot).catch((error: unknown) => {
            if (!lifetime.signal.aborted)
              console.warn("TRAE session usage directory refresh failed", error);
          });
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          changed.add(
            message.payload.kind === "upsert" ? message.payload.agent.id : message.payload.agentId,
          );
          if (message.payload.kind === "upsert") register(message.payload.agent);
          else remove(message.payload.agentId);
        },
      });
      lifetime.signal.addEventListener("abort", () => subscription.release(), { once: true });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted) console.warn("TRAE session usage observation failed", error);
    });
  return () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    unsubscribe?.();
    for (const id of pills.keys()) remove(id);
  };
}
