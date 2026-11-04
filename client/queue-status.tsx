import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { z } from "zod";
import { queueStatusSchema } from "../shared/queue-status.js";

type QueueStatusData = z.output<typeof queueStatusSchema>;

export function QueueStatusCard({ item, theme, layout }: PluginTimelineItemProps<QueueStatusData>) {
  const styles = useMemo(
    () => ({
      card: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: layout.compact ? 8 : 10,
        paddingHorizontal: layout.compact ? 12 : 16,
        paddingVertical: layout.compact ? 10 : 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      message: {
        flex: 1,
        color: theme.colors.foreground,
        fontSize: layout.compact ? 14 : 15,
        lineHeight: layout.compact ? 20 : 22,
      },
    }),
    [item.data.active, layout.compact, theme],
  );

  return (
    <View style={styles.card}>
      <Icon
        name={item.data.active ? "Hourglass" : "Info"}
        size={layout.compact ? 16 : 18}
        color={item.data.active ? theme.colors.accent : theme.colors.foregroundMuted}
      />
      <Text style={styles.message}>{item.data.message}</Text>
    </View>
  );
}
