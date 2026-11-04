import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createTraeQueueStatusProvider } from "./server/provider.js";
import { TraeModelLoadRefresh } from "./server/model-load-refresh.js";
import { createTraeCliCommand } from "./server/traecli-command.js";
import { getModelStatus } from "./shared/model-status.js";
import { getModelUsage } from "./shared/model-usage.js";
import { TraeModelUsage } from "./server/model-usage.js";
import { WorkspaceImports } from "./server/workspace-import.js";
import { importIntoWorkspace, listWorkspaceImports } from "./shared/workspace-import.js";
import { getSessionUsage } from "./shared/session-usage.js";
import { TraeSessionUsage } from "./server/session-usage.js";
import { ModelsDevPricing } from "./server/model-pricing.js";
import { getTurnCost } from "./shared/turn-usage.js";

export default function contribute(server: PluginServerContext) {
  const modelLoads = new TraeModelLoadRefresh({
    command: createTraeCliCommand(),
    env: process.env,
  });
  const pricing = new ModelsDevPricing();
  const modelUsage = new TraeModelUsage({ pricing });
  const sessionUsage = new TraeSessionUsage({ pricing });
  const workspaceImports = new WorkspaceImports();
  server.handle(getModelStatus, () => modelLoads.getStatus());
  server.handle(getModelUsage, () => modelUsage.getStatus());
  server.handle(getSessionUsage, (input, { paseo }) => sessionUsage.getStatus(paseo, input));
  server.handle(getTurnCost, (input, { paseo }) => sessionUsage.getTurnCost(paseo, input));
  server.handle(listWorkspaceImports, (input, { paseo }) => workspaceImports.list(paseo, input));
  server.handle(importIntoWorkspace, (input, { paseo }) => workspaceImports.import(paseo, input));
  server.registerProvider(createTraeQueueStatusProvider({}, modelLoads, pricing));
  return async () => {
    modelLoads.dispose();
    modelUsage.dispose();
    sessionUsage.dispose();
    pricing.dispose();
    await workspaceImports.dispose();
  };
}
