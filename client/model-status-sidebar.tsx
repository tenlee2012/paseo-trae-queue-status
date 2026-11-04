import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { modelStatusIcon } from "./icons.js";

export function ModelStatusSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon={modelStatusIcon}
      active={currentScreen?.screenId === "model-status"}
      onPress={() => openScreen({ screenId: "model-status" })}
    />
  );
}
