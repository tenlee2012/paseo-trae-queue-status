import type { PluginClientContext } from "@getpaseo/plugin/client";
import { QueueStatusCard } from "./client/queue-status.js";
import { refreshModelLoads } from "./client/model-load-refresh.js";
import { queueStatusKind, queueStatusSchema } from "./shared/queue-status.js";
import { modelStatusIcon } from "./client/icons.js";
import { ModelStatusPanel, ModelStatusScreen } from "./client/model-status-panel.js";
import { ModelStatusSidebarItem } from "./client/model-status-sidebar.js";
import { WorkspaceImportPanel } from "./client/workspace-import-panel.js";
import { TurnUsageRow } from "./client/turn-usage.js";
import { turnUsageKind, turnUsageSchema } from "./shared/turn-usage.js";
import { contributeSessionUsage } from "./client/session-usage.js";

export default function contribute(client: PluginClientContext) {
  client.addScreen({
    id: "model-status",
    title: "TraeX 模型状态",
    Component: ModelStatusScreen,
  });
  client.addSidebarHeaderItem({
    id: "model-status",
    title: "TraeX 模型状态",
    Component: ModelStatusSidebarItem,
  });
  client.addWorkspacePanel({
    id: "workspace-import",
    title: "导入 TraeX 会话",
    icon: "Import",
    locations: ["workspace", "explorer"],
    Component: WorkspaceImportPanel,
  });
  client.addCommandCenterItem({
    id: "workspace-import",
    title: "导入 TraeX 会话到当前工作区",
    icon: "Import",
    keywords: ["trae", "import", "session", "导入", "会话", "工作区"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("workspace-import");
    },
  });
  client.addWorkspacePanel({
    id: "model-status",
    title: "TraeX 模型状态",
    icon: modelStatusIcon,
    locations: ["workspace", "explorer"],
    Component: ModelStatusPanel,
  });
  client.addCommandCenterItem({
    id: "model-status",
    title: "查看 TraeX 模型负载、额度与用量",
    icon: modelStatusIcon,
    keywords: ["trae", "model", "load", "quota", "tokens", "usage", "负载", "额度", "用量"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("model-status");
    },
  });
  client.addTimelineRenderer({
    kind: queueStatusKind,
    version: 1,
    schema: queueStatusSchema,
    Component: QueueStatusCard,
  });
  client.addTimelineRenderer({
    kind: turnUsageKind,
    version: 1,
    schema: turnUsageSchema,
    Component: TurnUsageRow,
  });
  const disposeSessionUsage = contributeSessionUsage(client);
  const disposeModelLoads = refreshModelLoads(client.paseo.providers);
  return () => {
    disposeSessionUsage();
    disposeModelLoads();
  };
}
