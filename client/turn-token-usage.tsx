import type { PluginIcon, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import type { TurnUsageData } from "../shared/turn-usage.js";
import { formatTokenCost, formatTokens } from "./model-usage.js";
import { createWebOverlay } from "./web.js";
import { useTurnCost, type TurnCostTarget } from "./turn-cost.js";

type HostProps = Pick<PluginTimelineItemProps<TurnUsageData>, "theme" | "layout">;
interface UsageProps extends HostProps {
  data: TurnUsageData;
}
interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}
const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function totalTokens(data: TurnUsageData) {
  return data.state === "ready" && data.inputTokens !== null && data.outputTokens !== null
    ? data.inputTokens + data.outputTokens
    : null;
}

export function TurnTokenDetails({
  data,
  theme,
  inverse = false,
}: Omit<UsageProps, "layout"> & {
  inverse?: boolean;
}) {
  const total = totalTokens(data);
  const input = total === null ? null : data.inputTokens;
  const rows = [
    { label: "输入 Token", value: input, denominator: total },
    { label: "缓存读取 Token", value: data.cachedInputTokens, denominator: input, indent: true },
    {
      label: "缓存创建 Token",
      value: data.cacheCreationInputTokens ?? null,
      denominator: input,
      indent: true,
    },
    { label: "输出 Token", value: data.outputTokens, denominator: total },
    { label: "推理 Token", value: data.reasoningOutputTokens ?? null, denominator: total },
  ];
  const color = inverse ? theme.colors.surface0 : theme.colors.foreground;
  const numberStyle = {
    color,
    fontSize: 14,
    lineHeight: 22,
    fontVariant: ["tabular-nums" as const],
  };
  return (
    <View style={{ gap: 6 }}>
      {data.state !== "ready" ? (
        <Text style={{ color, fontSize: 12, lineHeight: 18 }}>
          {data.state === "pending" ? "本轮用量统计中…" : "本轮用量未提供"}
        </Text>
      ) : null}
      {rows.map(({ label, value: knownValue, denominator, indent }) => {
        const value = total === null ? null : knownValue;
        return (
          <View key={label} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text
              style={{ color, fontSize: 14, lineHeight: 22, flex: 1, paddingLeft: indent ? 14 : 0 }}
            >
              {label}
            </Text>
            <Text selectable style={{ ...numberStyle, fontWeight: "600", textAlign: "right" }}>
              {value === null ? "未提供" : formatTokens(value)}
            </Text>
            <Text style={{ ...numberStyle, textAlign: "right", minWidth: 48 }}>
              {value !== null && denominator !== null && denominator > 0
                ? percentFormatter.format(value / denominator)
                : "—"}
            </Text>
          </View>
        );
      })}
      <View style={{ borderTopWidth: 1, borderColor: color, opacity: 0.25, marginVertical: 6 }} />
      <View
        style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}
      >
        <Text style={{ ...numberStyle, fontWeight: "600" }}>Token 总量</Text>
        <Text selectable style={{ ...numberStyle, fontWeight: "600" }}>
          {total === null ? "未提供" : formatTokenCost(total, data.cost)}
        </Text>
      </View>
    </View>
  );
}

export function TurnTokenUsage({
  data,
  theme,
  layout,
  icon,
  ...target
}: UsageProps & TurnCostTarget & { icon: PluginIcon }) {
  const trigger = useRef<View>(null);
  const overlay = useRef<ReturnType<typeof createWebOverlay>>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const desired = useRef(false);
  const hovered = useRef(false);
  const focused = useRef(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [cardHeight, setCardHeight] = useState(230);
  const [sheetOpen, setSheetOpen] = useState(false);
  const viewport = useWindowDimensions();
  const tooltipId = useId();
  const cancelClose = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const close = useCallback(() => {
    desired.current = false;
    cancelClose();
    setAnchor(null);
  }, [cancelClose]);
  const scheduleClose = useCallback(() => {
    if (hovered.current || focused.current) return;
    desired.current = false;
    cancelClose();
    timer.current = setTimeout(close, 150);
  }, [cancelClose, close]);
  const show = () => {
    if (layout.platform !== "web") return;
    desired.current = true;
    cancelClose();
    trigger.current?.measureInWindow((x, y, width, height) => {
      if (desired.current) setAnchor({ x, y, width, height });
    });
  };
  const enterCard = useCallback(() => {
    hovered.current = true;
    desired.current = true;
    cancelClose();
  }, [cancelClose]);
  const leaveCard = useCallback(() => {
    hovered.current = false;
    scheduleClose();
  }, [scheduleClose]);
  const visible = anchor !== null;
  const detailsData = useTurnCost(data, target, visible || sheetOpen);
  useEffect(() => {
    if (!visible) return;
    const portal = createWebOverlay(close);
    overlay.current = portal;
    return () => {
      overlay.current = null;
      portal?.dispose();
    };
  }, [visible, close]);
  useEffect(() => {
    if (!anchor) return;
    const width = Math.min(320, Math.max(0, viewport.width - 16));
    const left = Math.max(
      8,
      Math.min(anchor.x + anchor.width / 2 - width / 2, viewport.width - width - 8),
    );
    const above =
      anchor.y >= cardHeight + 8 || anchor.y > viewport.height - anchor.y - anchor.height;
    const space = above ? anchor.y - 16 : viewport.height - anchor.y - anchor.height - 16;
    const arrowLeft = Math.max(8, Math.min(width - 20, anchor.x + anchor.width / 2 - left - 6));
    const arrow = (
      <View
        style={{
          marginLeft: arrowLeft,
          width: 0,
          height: 0,
          borderLeftWidth: 6,
          borderRightWidth: 6,
          borderLeftColor: "transparent",
          borderRightColor: "transparent",
          ...(above
            ? { borderTopWidth: 6, borderTopColor: theme.colors.foreground }
            : { borderBottomWidth: 6, borderBottomColor: theme.colors.foreground }),
        }}
      />
    );
    overlay.current?.render(
      <Pressable
        pointerEvents="auto"
        focusable={false}
        accessible={false}
        onHoverIn={enterCard}
        onHoverOut={leaveCard}
        onLayout={(event) => {
          if (event.nativeEvent.layout.height > 0) setCardHeight(event.nativeEvent.layout.height);
        }}
        style={{
          position: "absolute",
          width,
          left,
          top: above ? Math.max(8, anchor.y - cardHeight - 4) : anchor.y + anchor.height + 4,
        }}
      >
        {!above ? arrow : null}
        <View
          nativeID={tooltipId}
          role="tooltip"
          style={{
            backgroundColor: theme.colors.foreground,
            padding: 14,
            borderRadius: 6,
            maxHeight: Math.max(0, space),
            overflow: "scroll",
          }}
        >
          <TurnTokenDetails data={detailsData} theme={theme} inverse />
        </View>
        {above ? arrow : null}
      </Pressable>,
    );
  }, [
    anchor,
    cardHeight,
    detailsData,
    theme,
    viewport.width,
    viewport.height,
    tooltipId,
    enterCard,
    leaveCard,
  ]);
  useEffect(
    () => () => {
      desired.current = false;
      cancelClose();
    },
    [cancelClose],
  );

  const total = totalTokens(data);
  const label =
    total !== null ? formatTokens(total) : data.state === "pending" ? "用量统计中…" : "用量未提供";
  const suffix =
    data.outcome === "canceled" ? " · 已停止" : data.outcome === "failed" ? " · 失败" : "";
  return (
    <>
      <Pressable
        ref={trigger}
        accessibilityRole="button"
        accessibilityLabel={`本轮 ${label}${total === null ? "" : " tokens"}，查看用量明细`}
        accessibilityHint="悬浮或聚焦查看明细，触屏轻点查看。"
        aria-describedby={visible ? tooltipId : undefined}
        delayHoverIn={150}
        onHoverIn={() => {
          hovered.current = true;
          show();
        }}
        onHoverOut={leaveCard}
        onFocus={() => {
          focused.current = true;
          show();
        }}
        onBlur={() => {
          focused.current = false;
          scheduleClose();
        }}
        onPress={() => {
          close();
          setSheetOpen(true);
        }}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}
      >
        <View accessible={false} importantForAccessibility="no-hide-descendants">
          <Icon icon={icon} size={14} color={theme.colors.foregroundMuted} />
        </View>
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 18,
            textDecorationLine: "underline",
            textDecorationStyle: "dotted",
            textDecorationColor: theme.colors.foregroundMuted,
          }}
          numberOfLines={1}
        >
          {label + suffix}
        </Text>
      </Pressable>
      {sheetOpen ? (
        <Modal title="本轮 token 用量" open onOpenChange={setSheetOpen}>
          <Modal.Content>
            <TurnTokenDetails data={detailsData} theme={theme} />
          </Modal.Content>
        </Modal>
      ) : null}
    </>
  );
}
