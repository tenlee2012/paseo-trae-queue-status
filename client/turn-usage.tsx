import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import type { TurnUsageData } from "../shared/turn-usage.js";
import { TurnTokenUsage } from "./turn-token-usage.js";

const tokenIcon = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><path fill="currentColor" d="M7.001 1.979c-3.325 0-5.833 1.254-5.833 2.917v3.5c0 1.61 2.325 2.834 5.527 2.912.102.003.204.004.306.004 3.326 0 5.834-1.253 5.834-2.916v-3.5c0-1.663-2.508-2.917-5.834-2.917zm-3.475 1.8C4.445 3.37 5.679 3.146 7 3.146c2.849 0 4.667 1.036 4.667 1.75 0 .362-.457.79-1.191 1.117-.919.408-2.153.633-3.476.633-.093 0-.185-.002-.277-.004-1.262-.03-2.427-.268-3.283-.668-.693-.324-1.106-.727-1.106-1.078 0-.363.456-.79 1.19-1.117zm6.538 5.897a7.15 7.15 0 01-.73.213V7.586c.246-.05.49-.11.73-.182v2.272zM7.293 7.809c.292-.007.584-.023.875-.05v2.326c-.284.03-.577.05-.875.057V7.809zm-4.958.587V6.692c.882.583 2.21.98 3.791 1.09v2.329c-1.029-.08-1.966-.301-2.685-.637-.693-.324-1.106-.728-1.106-1.078zm8.895.672V6.943a4.74 4.74 0 00.438-.255v1.708c0 .212-.159.448-.438.672z"/></svg>',
};

const toolIcon = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="currentColor" d="M19.994 11.035c3.66-3.659 9.094-4.46 13.531-2.405a.1.1 0 0 1 .028.16l-6.488 6.488a1 1 0 0 0 0 1.414l4.243 4.243a1 1 0 0 0 1.414 0l6.488-6.488a.1.1 0 0 1 .16.028c2.056 4.437 1.254 9.872-2.405 13.53-3.695 3.696-9.2 4.477-13.66 2.347L12.923 40.733a1 1 0 0 1-1.414 0L7.266 36.49a1 1 0 0 1 0-1.414l10.382-10.382c-2.13-4.46-1.349-9.965 2.346-13.66Z"/></svg>',
};
const reasoningIcon = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" d="M7 2.625v1.959a.2.2 0 00.059.141L8.75 6.417M7 11.375V9.416a.2.2 0 00-.059-.141L5.25 7.583m1.813-5.27l1.598-.533a.2.2 0 01.169.02l2.16 1.35a.2.2 0 01.093.17v1.247a.2.2 0 00.08.16l1.007.755a.2.2 0 01.08.16v2.133a.2.2 0 01-.08.16l-1.007.755a.2.2 0 00-.08.16v1.83a.2.2 0 01-.094.17L8.83 12.2a.2.2 0 01-.168.02l-1.598-.532a.201.201 0 00-.126 0l-1.598.532a.2.2 0 01-.169-.02l-2.16-1.35a.2.2 0 01-.093-.17V8.85a.2.2 0 00-.08-.16L1.83 7.935a.2.2 0 01-.08-.16V5.642a.2.2 0 01.08-.16l1.007-.755a.2.2 0 00.08-.16V3.319a.2.2 0 01.094-.17L5.17 1.8a.2.2 0 01.168-.02l1.598.533a.2.2 0 00.126 0z"/></svg>',
};

export function TurnUsageRow({
  item,
  theme,
  layout,
  agentId,
  host,
  timestamp,
}: PluginTimelineItemProps<TurnUsageData>) {
  const data = item.data;
  const activities = [];
  if (data.modelCallCount !== undefined)
    activities.push({
      id: "reasoning",
      label: `${data.modelCallCount ?? "—"} calls`,
      accessibilityLabel:
        data.modelCallCount === null
          ? "Model call count unavailable"
          : `Model ${data.modelCallCount} calls`,
      icon: reasoningIcon,
    });
  // Older rows counted only ACP-visible tools. Do not present those partial
  // counts as native trace statistics after upgrading the renderer.
  if (data.modelCallCount !== undefined && data.toolCallCount !== undefined)
    activities.push({
      id: "tools",
      label: `${data.toolCallCount ?? "—"} calls`,
      accessibilityLabel:
        data.toolCallCount === null
          ? "Tool call count unavailable"
          : `Tools ${data.toolCallCount} calls`,
      icon: toolIcon,
    });
  const textStyle = { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 };
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ maxWidth: "100%", alignSelf: "stretch" }}
      contentContainerStyle={{
        paddingHorizontal: layout.compact ? 12 : 16,
        paddingVertical: 6,
        flexDirection: "row",
        flexWrap: "nowrap",
        alignItems: "center",
        columnGap: 6,
      }}
    >
      <Text style={textStyle} numberOfLines={1} selectable>
        本轮:
      </Text>
      {activities.map((activity) => (
        <View key={activity.id} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <View accessible={false} importantForAccessibility="no-hide-descendants">
            <Icon icon={activity.icon} size={14} color={theme.colors.foregroundMuted} />
          </View>
          <Text
            style={textStyle}
            numberOfLines={1}
            accessibilityLabel={activity.accessibilityLabel}
            selectable
          >
            {activity.label}
          </Text>
        </View>
      ))}
      <TurnTokenUsage
        data={data}
        theme={theme}
        layout={layout}
        icon={tokenIcon}
        agentId={agentId}
        hostId={host.id}
        timestamp={timestamp.getTime()}
      />
    </ScrollView>
  );
}
