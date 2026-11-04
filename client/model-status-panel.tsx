import {
  openExternalUrl,
  useRpc,
  useTabState,
  type PluginWorkspacePanelProps,
  type PluginHostProps,
  type PluginScreenProps,
} from "@getpaseo/plugin/client";
import {
  Icon,
  Loading,
  ScrollView,
  SettingsCard,
  SettingsSelect,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { getModelStatus } from "../shared/model-status.js";
import { getModelUsage } from "../shared/model-usage.js";
import { formatCost, formatTokenCost, formatUsageBreakdown, usageForModel } from "./model-usage.js";
import { modelStatusIcon } from "./icons.js";
import {
  defaultModelStatusPanelState,
  modelStatusPanelStateSchema,
  modelSortDirection,
  selectModels,
  toggleModelSort,
  type ModelStatusPanelState,
} from "./model-status-state.js";

const FEEDBACK_URL = "https://github.com/tenlee2012/paseo-trae-queue-status/issues";

const MODEL_COLUMNS: { key: ModelStatusPanelState["sort"]; label: string }[] = [
  { key: "name", label: "模型名称" },
  { key: "load", label: "模型负载" },
  { key: "quota", label: "周额度剩余" },
  { key: "today", label: "今日用量 · tokens" },
  { key: "week", label: "本周用量 · tokens" },
];

export function ModelStatusPanel(props: PluginWorkspacePanelProps) {
  const [state, setState] = useTabState(
    props.tab,
    modelStatusPanelStateSchema,
    defaultModelStatusPanelState,
  );
  return <ModelStatusView {...props} state={state} setState={setState} />;
}

export function ModelStatusScreen(props: PluginScreenProps) {
  const [state, setState] = useState(defaultModelStatusPanelState);
  return <ModelStatusView {...props} state={state} setState={setState} />;
}

function ModelStatusView({
  theme,
  layout,
  host,
  state,
  setState,
}: PluginHostProps & {
  state: ModelStatusPanelState;
  setState: (state: ModelStatusPanelState) => void;
}) {
  const toast = useToast();
  const readStatus = useRpc(getModelStatus);
  const readUsage = useRpc(getModelUsage);
  const usage = useQuery({
    queryKey: ["trae-model-usage", host.id],
    queryFn: () => readUsage({}),
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: false,
  });
  const status = useQuery({
    queryKey: ["trae-model-status", host.id],
    queryFn: () => readStatus({}),
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: false,
  });
  const models = useMemo(
    () => selectModels(status.data?.models ?? [], state, usage.data?.snapshot),
    [status.data, state, usage.data?.snapshot],
  );
  const { colors } = theme;
  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: colors.surface0 },
      content: { padding: layout.compact ? 16 : 24, gap: 20 },
      heading: {
        flexDirection: layout.compact ? ("column" as const) : ("row" as const),
        alignItems: layout.compact ? ("stretch" as const) : ("center" as const),
        gap: 12,
      },
      headingIdentity: {
        flex: layout.compact ? undefined : 1,
        minWidth: 0,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 12,
      },
      headingText: { flex: 1, minWidth: 0, gap: 4 },
      headingActions: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "flex-end" as const,
        flexWrap: "wrap" as const,
        gap: 8,
      },
      feedbackButton: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        minHeight: 44,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
      },
      feedbackLabel: { color: colors.foreground, fontSize: 14 },
      title: { color: colors.foreground, fontSize: 20, fontWeight: "600" as const },
      text: { color: colors.foreground, fontSize: 14, lineHeight: 21 },
      muted: { color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      refresh: {
        minWidth: 44,
        minHeight: 44,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        padding: 10,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
      },
      controls: { gap: 10 },
      search: {
        color: colors.foreground,
        backgroundColor: colors.surface1,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 14,
      },
      notice: {
        backgroundColor: colors.surface1,
        borderLeftWidth: 3,
        borderLeftColor: colors.statusWarning,
        padding: 12,
        gap: 4,
      },
      list: { gap: 10 },
      tableContent: { flexGrow: 1 },
      table: {
        flex: 1,
        minWidth: 1170,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 10,
        overflow: "hidden" as const,
      },
      tableHeader: {
        flexDirection: "row" as const,
        backgroundColor: colors.surface1,
      },
      columnHeader: {
        minHeight: 52,
        paddingVertical: 12,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      columnLabel: { fontSize: 12, lineHeight: 18, fontWeight: "600" as const, flexShrink: 1 },
      sortIndicator: { flexShrink: 0, width: 18, height: 18 },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        borderTopWidth: 1,
        borderColor: colors.border,
      },
      nameColumn: { flex: 2, minWidth: 240, paddingHorizontal: 16 },
      metricColumn: { flex: 1, minWidth: 155, paddingHorizontal: 16 },
      usageColumn: { flex: 2, minWidth: 310, paddingHorizontal: 16 },
      cell: { paddingVertical: 16, gap: 4 },
      name: { color: colors.foreground, fontSize: 15, fontWeight: "600" as const },
      value: { fontSize: 16, fontWeight: "600" as const },
      empty: { paddingVertical: 24, gap: 8 },
      loading: { minHeight: 120 },
    }),
    [colors, layout.compact],
  );
  const refreshError =
    status.data?.refreshError ??
    (status.isError ? "无法连接模型状态服务，请检查宿主连接后重试。" : null);
  const refreshedAt = status.data?.refreshedAt;
  const usageSnapshot = usage.data?.snapshot;
  const usageError =
    usage.data?.refreshError ?? (usage.isError ? "无法连接本机用量统计服务。" : null);
  const isRefreshing = status.isFetching || usage.isFetching;
  const sortDirection = modelSortDirection(state);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.heading}>
        <View style={styles.headingIdentity}>
          <Icon icon={modelStatusIcon} size={28} color={colors.accent} />
          <View style={styles.headingText}>
            <Text style={styles.title}>TraeX 模型状态</Text>
            <Text style={styles.muted}>{host.label} · 当前 TRAE 账号</Text>
          </View>
        </View>
        <View style={styles.headingActions}>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="反馈 TraeX 使用问题"
            accessibilityHint="打开 GitHub Issues"
            onPress={() => {
              void openExternalUrl(FEEDBACK_URL).catch(() => {
                toast.error("无法打开反馈链接，请重试，或从 README 中打开。");
              });
            }}
            style={({ pressed }) => [
              styles.feedbackButton,
              { backgroundColor: pressed ? colors.surface1 : colors.surface0 },
            ]}
          >
            <Icon name="MessageCircle" size={16} color={colors.foreground} />
            <Text style={styles.feedbackLabel}>问题反馈</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="刷新模型状态"
            accessibilityState={{ disabled: isRefreshing, busy: isRefreshing }}
            disabled={isRefreshing}
            onPress={() => {
              void status.refetch();
              void usage.refetch();
            }}
            style={styles.refresh}
          >
            <Icon
              name="RefreshCw"
              size={18}
              color={isRefreshing ? colors.foregroundMuted : colors.accent}
            />
          </Pressable>
        </View>
      </View>

      <View style={styles.controls}>
        <TextInput
          accessibilityLabel="搜索模型名称或 ID"
          placeholder="搜索模型名称或 ID"
          placeholderTextColor={colors.foregroundMuted}
          value={state.query}
          maxLength={200}
          onChangeText={(query) => setState({ ...state, query })}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.search}
        />
        <SettingsCard>
          <SettingsSelect
            label="显示"
            value={state.filter}
            options={[
              { value: "all", label: "全部模型" },
              { value: "busy", label: "高负载（≥100%）" },
              { value: "quota", label: "有周额度的模型" },
            ]}
            onValueChange={(filter) => setState({ ...state, filter })}
          />
        </SettingsCard>
        <Text style={styles.muted}>
          自动刷新开启，数据最多每 30 秒更新一次。
          {refreshedAt != null ? `\n上次成功更新：${new Date(refreshedAt).toLocaleString()}` : ""}
        </Text>
        <Text style={styles.muted}>
          用量按输入 + 输出统计，包含缓存；普通和 max 模式合计。范围为当前宿主的本机 TRAE CLI 记录。
          新增为总用量减缓存输入，缓存占比按缓存输入 / 总用量计算。
          {usageSnapshot
            ? `\n统计时区：${usageSnapshot.timeZone} · 本周从周一 ${new Date(usageSnapshot.weekStart).toLocaleDateString("zh-CN", { timeZone: usageSnapshot.timeZone })} 00:00 起。\n用量更新：${new Date(usageSnapshot.refreshedAt).toLocaleString("zh-CN", { timeZone: usageSnapshot.timeZone })}`
            : "\n本周从宿主时区周一 00:00 起。"}
        </Text>
      </View>

      {refreshError ? (
        <View style={styles.notice} accessibilityRole="alert">
          <Text style={styles.text}>
            {refreshedAt != null
              ? "刷新失败，以下为上次成功读取的数据。"
              : "暂时无法读取模型状态。"}
          </Text>
          <Text style={styles.muted}>{refreshError}</Text>
        </View>
      ) : null}
      {usageError ? (
        <View style={styles.notice} accessibilityRole="alert">
          <Text style={styles.text}>
            {usageSnapshot ? "用量刷新失败，显示上次成功统计的用量。" : "暂时无法统计本机用量。"}
          </Text>
          <Text style={styles.muted}>{usageError}</Text>
        </View>
      ) : null}

      {status.isPending ? (
        <View style={styles.loading}>
          <Loading />
        </View>
      ) : (
        <View style={styles.list}>
          <Text style={styles.muted}>
            {models.length} / {status.data?.models.length ?? 0} 个模型 · 切换模型请使用会话模型菜单
          </Text>
          <ScrollView
            horizontal
            testID="trae-model-table-scroll"
            contentContainerStyle={styles.tableContent}
            keyboardShouldPersistTaps="handled"
          >
            <View role="table" accessibilityLabel="TraeX 模型状态" style={styles.table}>
              <View role="row" testID="trae-model-list-header" style={styles.tableHeader}>
                {MODEL_COLUMNS.map(({ key, label }) => {
                  const active = state.sort === key;
                  return (
                    <View
                      key={key}
                      role="columnheader"
                      style={
                        key === "name"
                          ? styles.nameColumn
                          : key === "today" || key === "week"
                            ? styles.usageColumn
                            : styles.metricColumn
                      }
                    >
                      <Pressable
                        testID={`trae-model-sort-${key}`}
                        accessibilityRole="button"
                        accessibilityLabel={`${label}，${active ? (sortDirection === "asc" ? "当前升序" : "当前降序") : "未排序"}`}
                        accessibilityHint="点击按此列排序，再次点击切换升序或降序"
                        onPress={() => setState(toggleModelSort(state, key))}
                        style={styles.columnHeader}
                      >
                        <Text
                          style={[
                            styles.columnLabel,
                            { color: active ? colors.foreground : colors.foregroundMuted },
                          ]}
                        >
                          {label}
                        </Text>
                        <View
                          testID={`trae-model-sort-indicator-${key}`}
                          accessibilityElementsHidden
                          importantForAccessibility="no-hide-descendants"
                          style={styles.sortIndicator}
                        >
                          <Icon
                            name={
                              active
                                ? sortDirection === "asc"
                                  ? "ArrowUp"
                                  : "ArrowDown"
                                : "ArrowUpDown"
                            }
                            size={18}
                            color={active ? colors.foreground : colors.foregroundMuted}
                          />
                        </View>
                      </Pressable>
                    </View>
                  );
                })}
              </View>
              {models.map((model) => {
                const load = model.loadPercent;
                const loadColor =
                  load === null
                    ? colors.foregroundMuted
                    : load > 150
                      ? colors.statusDanger
                      : load >= 100
                        ? colors.statusWarning
                        : colors.statusSuccess;
                const loadLabel =
                  load === null
                    ? "未提供"
                    : load > 150
                      ? "高负载"
                      : load >= 100
                        ? "繁忙"
                        : "低负载";
                const quota = model.weeklyQuotaRemainingPercent;
                const modelUsage = usageSnapshot ? usageForModel(usageSnapshot, model) : null;
                const unavailableUsage = usage.isPending ? "统计中…" : "暂不可用";
                return (
                  <View
                    key={model.id}
                    testID={`trae-model-row-${model.id}`}
                    role="row"
                    style={styles.row}
                  >
                    <View role="rowheader" style={[styles.nameColumn, styles.cell]}>
                      <Text selectable style={styles.name}>
                        {model.name}
                      </Text>
                      {model.id !== model.name ? (
                        <Text selectable style={styles.muted}>
                          {model.id}
                        </Text>
                      ) : null}
                    </View>
                    <View role="cell" style={[styles.metricColumn, styles.cell]}>
                      <Text style={[styles.value, { color: loadColor }]}>
                        {load === null ? loadLabel : `${load}% · ${loadLabel}`}
                      </Text>
                    </View>
                    <View role="cell" style={[styles.metricColumn, styles.cell]}>
                      <Text
                        style={[
                          styles.value,
                          { color: quota === 0 ? colors.statusDanger : colors.foreground },
                        ]}
                      >
                        {quota === null ? "未提供" : `${quota}%${quota === 0 ? " · 已用尽" : ""}`}
                      </Text>
                    </View>
                    <View role="cell" style={[styles.usageColumn, styles.cell]}>
                      <Text
                        selectable
                        accessibilityLabel={
                          modelUsage
                            ? `${modelUsage.todayTokens.toLocaleString("en-US")} tokens | ${formatCost(modelUsage.todayCost)}`
                            : unavailableUsage
                        }
                        style={[styles.value, { color: colors.foreground }]}
                      >
                        {modelUsage
                          ? formatTokenCost(modelUsage.todayTokens, modelUsage.todayCost)
                          : unavailableUsage}
                      </Text>
                      {modelUsage ? (
                        <Text selectable numberOfLines={1} style={styles.muted}>
                          {formatUsageBreakdown(
                            modelUsage.todayTokens,
                            modelUsage.todayCachedTokens,
                          )}
                        </Text>
                      ) : null}
                    </View>
                    <View role="cell" style={[styles.usageColumn, styles.cell]}>
                      <Text
                        selectable
                        accessibilityLabel={
                          modelUsage
                            ? `${modelUsage.weekTokens.toLocaleString("en-US")} tokens | ${formatCost(modelUsage.weekCost)}`
                            : unavailableUsage
                        }
                        style={[styles.value, { color: colors.foreground }]}
                      >
                        {modelUsage
                          ? formatTokenCost(modelUsage.weekTokens, modelUsage.weekCost)
                          : unavailableUsage}
                      </Text>
                      {modelUsage ? (
                        <Text selectable numberOfLines={1} style={styles.muted}>
                          {formatUsageBreakdown(modelUsage.weekTokens, modelUsage.weekCachedTokens)}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                );
              })}
            </View>
          </ScrollView>
          {models.length === 0 && !refreshError ? (
            <View style={styles.empty}>
              <Text style={styles.text}>
                {status.data?.models.length
                  ? "没有匹配的模型，请调整搜索或筛选条件。"
                  : "TRAE CLI 尚未返回模型。"}
              </Text>
            </View>
          ) : null}
        </View>
      )}
      <Text style={styles.muted}>
        负载、日额度和周额度由 TRAE 提供。负载可能超过 100%；额度百分比不代表剩余请求数或 token 数。
      </Text>
      <Text style={styles.muted}>
        费用按 Models.dev 价格估算（USD），价格缓存 24 小时；$— 表示价格或计费明细未提供。
      </Text>
    </ScrollView>
  );
}
