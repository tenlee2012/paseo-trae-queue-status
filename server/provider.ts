import type { AcpTransformer } from "@getpaseo/plugin/server/acp";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type {
  ProviderConnection,
  ProviderConfigState,
  ProviderContent,
  ProviderEvent,
  ProviderInput,
  ProviderPersistence,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import {
  createTraeAcpSteeringRegistry,
  type TraeAcpLaunchOptions,
  type TraeAcpSteeringRegistry,
} from "./acp-connector.js";
import { TraeModelLoadRefresh } from "./model-load-refresh.js";
import { COLLABORATION_MODE_ID, PLAN_MODE_ID, preferredPlanSettings } from "./plan-mode.js";
import { historyReplayTransformer } from "./history-replay.js";
import { PaseoQuestionTool, QUESTION_SERVER_NAME } from "./question-tool.js";

import { queueStatusTransformer } from "./queue-status.js";
import { createTraeCliCommand } from "./traecli-command.js";
import { canonicalSessionCwd, workspaceSessionPersistence } from "./session-persistence.js";
import { TraeSubagents } from "./subagents.js";
import { TraeTurnUsage } from "./turn-usage.js";
import { TraeCallCounts } from "./call-counts.js";
import type { ModelPricingSource } from "./model-pricing.js";

const steeringResponseSchema = z.object({ outcome: z.string() }).passthrough();

type AcpPromptPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export function createTraeQueueStatusProvider(
  launch: TraeAcpLaunchOptions = {},
  modelLoads?: TraeModelLoadRefresh | null,
  pricing?: ModelPricingSource,
): ProviderRegistration {
  const command = createTraeCliCommand(launch);
  modelLoads =
    modelLoads === undefined
      ? new TraeModelLoadRefresh({
          command,
          env: launch.env ?? process.env,
        })
      : modelLoads;

  return {
    id: "traecli-queue",
    label: "TraeX",
    icon: "shared/trae-icon.svg",
    description: "TRAE CLI ACP with backend queue status and steering",
    // This plugin has one fixed launch and TRAE's model list is account-wide.
    // Share the catalog so load refreshes reach both global and workspace menus.
    async getCatalogCacheKey() {
      return "traecli-account-models";
    },
    async connect(request) {
      const subagents = new TraeSubagents(
        request.capabilities.includes("session.subsession"),
        launch.env ?? process.env,
      );
      const callCounts = await TraeCallCounts.create(launch.env ?? process.env);
      const steering = createTraeAcpSteeringRegistry(
        { ...launch, env: callCounts.env },
        command,
        modelLoads ? (unavailableModel) => modelLoads.fallbackModel(unavailableModel) : undefined,
        (message) => subagents.capture(message),
      );
      const base = runAcpProvider({
        id: "traecli-queue",
        label: "TraeX",
        description: "TRAE CLI ACP with backend queue status and steering",
        connector: steering.connector,
        acpOptions: {
          waitForInitialCommands: true,
          initialCommandsTimeoutMs: 10_000,
        },
        transformers: [
          modelConfiguration(steering, modelLoads),
          queueStatusTransformer,
          historyReplayTransformer,
        ],
      });

      try {
        const connection = await base.connect(request);
        const steeringEnabled =
          request.capabilities.includes("prompt.steer") && steering.supportsSteering();
        return wrapConnection(
          connection,
          steering,
          steeringEnabled,
          request.capabilities,
          modelLoads,
          callCounts,
          subagents,
          pricing,
        );
      } catch (error) {
        await steering.dispose();
        await callCounts.dispose();
        throw error;
      }
    },
  };
}

function modelConfiguration(
  steering: TraeAcpSteeringRegistry,
  modelLoads: TraeModelLoadRefresh | null,
): AcpTransformer {
  return {
    async discover(catalog) {
      if (modelLoads) {
        await modelLoads.refresh().catch((error: unknown) => {
          console.warn("TRAE model load discovery refresh failed", error);
        });
      }
      const models = new Map(steering.modelCatalog().map((model) => [model.id, model]));
      if (models.size === 0)
        return {
          ...catalog,
          models: modelPickerModels(catalog.models, modelLoads),
        };
      return {
        ...catalog,
        thinkingOptions: [],
        defaultThinkingOption: undefined,
        models: modelPickerModels(
          catalog.models.map((model) => {
            const native = models.get(model.id);
            if (!native) return model;
            return {
              ...model,
              label: native.label,
              thinkingOptions: native.thinkingOptions,
              defaultThinkingOptionId: native.defaultThinkingOptionId,
            };
          }),
          modelLoads,
        ),
      };
    },
    async configure(change, context) {
      if (change.target === "mode" && change.value === "plan") {
        const current = await context.config.read();
        if (COLLABORATION_MODE_ID in current) {
          await context.config.set(COLLABORATION_MODE_ID, "plan");
          return "handled";
        }
      }
      if (change.target !== "thinking") return "pass";
      const current = await context.config.read();
      const model = steering.modelCatalog().find((candidate) => candidate.id === current.model);
      // Fixed-reasoning models have no adjustable level. Discard a saved
      // level instead of asking the ACP shim to set a nonexistent selector.
      if (model?.thinkingOptions?.length === 0) return "handled";
      return "pass";
    },
  };
}

function wrapConnection(
  connection: ProviderConnection,
  steering: ReturnType<typeof createTraeAcpSteeringRegistry>,
  steeringEnabled: boolean,
  offeredCapabilities: readonly string[],
  modelLoads: TraeModelLoadRefresh | null,
  callCounts: TraeCallCounts,
  subagents: TraeSubagents,
  pricing?: ModelPricingSource,
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const activeTurns = new Map<string, string>();
  const skippedHistory = new Map<string, string>();
  const launches = new Map<string, { cwd: string; requestId: string; nativeId?: string }>();
  const capabilities = offeredCapabilities.filter(
    (capability) =>
      connection.capabilities.includes(capability) ||
      capability === "session.subsession" ||
      (steeringEnabled && capability === "prompt.steer"),
  );
  let closed = false;
  const replaying = new Set<string>();
  const configs = new Map<string, ProviderConfigState>();

  const emit = (incomingEvent: ProviderEvent): void => {
    if (closed) return;
    if (incomingEvent.type === "session.closed") subagents.release(incomingEvent.sessionId);
    if (incomingEvent.type === "session.turn" && incomingEvent.state !== "started")
      subagents.finish(incomingEvent.sessionId, incomingEvent.state);
    if (incomingEvent.type === "session.ready" && replaying.delete(incomingEvent.sessionId)) {
      const ready = incomingEvent;
      void subagents.restore(ready.sessionId).then(() => {
        if (launches.has(ready.sessionId)) emit(ready);
        return undefined;
      });
      return;
    }
    if (incomingEvent.type === "timeline.item" && skippedHistory.has(incomingEvent.sessionId))
      return;
    if (incomingEvent.type === "session.ready" || incomingEvent.type === "session.closed")
      skippedHistory.delete(incomingEvent.sessionId);
    if (incomingEvent.type === "request.failed") {
      for (const [sessionId, requestId] of skippedHistory) {
        if (requestId === incomingEvent.requestId) skippedHistory.delete(sessionId);
      }
      for (const [sessionId, launch] of launches) {
        if (launch.requestId !== incomingEvent.requestId) continue;
        launches.delete(sessionId);
        replaying.delete(sessionId);
        if (launch.nativeId) subagents.discard(launch.nativeId);
        questionTool.release(sessionId);
      }
    }
    if (incomingEvent.type === "session.opened" && capabilities.includes("session.subsession"))
      incomingEvent = {
        ...incomingEvent,
        capabilities: [...incomingEvent.capabilities, "session.subsession"],
      };
    let event = exposeSessionSteering(deduplicateModeSettings(incomingEvent), steeringEnabled);
    if (event.type === "session.opened" || event.type === "session.persistence") {
      const nativeId = readNativeSessionId(event.persistence);
      if (nativeId) turnUsage.bind(event.sessionId, nativeId);
      const launch = launches.get(event.sessionId);
      if (launch && event.persistence) {
        event = {
          ...event,
          persistence: workspaceSessionPersistence(event.persistence, launch.cwd),
        };
      }
    }
    if (event.type === "session.config") {
      configs.set(event.sessionId, event.config);
      event = {
        ...event,
        config: {
          ...event.config,
          models: modelPickerModels(event.config.models, modelLoads),
          settings: event.config.settings.map((setting) =>
            setting.id === PLAN_MODE_ID
              ? Object.assign({}, setting, { icon: "list-todo", tooltip: "Toggle plan mode" })
              : setting,
          ),
        },
      };
    } else if (event.type === "session.closed") {
      launches.delete(event.sessionId);
      configs.delete(event.sessionId);
      questionTool.release(event.sessionId);
    }
    observeEvent(event, steering, activeTurns);
    turnUsage.observe(event);
    for (const listener of listeners) listener(event);
    if (event.type === "session.opened" && !event.parentSessionId) {
      const nativeId = readNativeSessionId(event.persistence);
      if (nativeId) subagents.bind(event.sessionId, nativeId, event.cwd);
    }
  };
  subagents.setEmitter((event) => {
    if (closed) return;
    if (event.type === "timeline.item" && skippedHistory.has(event.sessionId)) return;
    for (const listener of listeners) listener(event);
  });
  const turnUsage = new TraeTurnUsage(emit, { env: callCounts.env, callCounts, pricing });
  const questionTool = new PaseoQuestionTool(emit);
  const unsubscribe = connection.onEvent(emit);
  const unsubscribeQuestions = steering.onQuestionEvent(emit);
  const unsubscribeLoads = modelLoads?.subscribe(() => {
    for (const [sessionId, config] of configs) emit({ type: "session.config", sessionId, config });
  });

  return {
    version: connection.version,
    capabilities,
    async send(input) {
      if (input.type === "session.close" && subagents.closeChild(input.sessionId)) {
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      if (input.type === "sessions" && capabilities.includes("session.list")) {
        const requestId = input.requestId;
        void steering.listSessions(input).then(
          (sessions) => emit({ type: "sessions", requestId, sessions }),
          (error: unknown) =>
            emit({
              type: "request.failed",
              requestId,
              error: { message: describeError(error) },
            }),
        );
        return;
      }
      if (input.type === "session.configure" && input.changes.settings) {
        input = {
          ...input,
          changes: { ...input.changes, settings: preferredPlanSettings(input.changes.settings) },
        };
      }
      if (input.type === "session.open") {
        input = {
          ...input,
          config: { ...input.config, settings: preferredPlanSettings(input.config.settings) },
        };
        const sessionId = input.sessionId;
        if (input.persistence) replaying.add(sessionId);
        launches.set(sessionId, {
          cwd: await canonicalSessionCwd(input.config.cwd),
          requestId: input.requestId,
          nativeId: readNativeSessionId(input.persistence) ?? undefined,
        });
        if (input.history === "skip" && input.persistence)
          skippedHistory.set(sessionId, input.requestId);
        try {
          if (capabilities.includes("permission")) {
            if (QUESTION_SERVER_NAME in input.config.mcpServers)
              throw new Error(
                `MCP server name ${QUESTION_SERVER_NAME} is reserved by the Paseo plugin`,
              );
            const server = await questionTool.open(sessionId);
            input = {
              ...input,
              config: {
                ...input.config,
                mcpServers: { ...input.config.mcpServers, [QUESTION_SERVER_NAME]: server },
              },
            };
          }
          await connection.send(input);
        } catch (error) {
          launches.delete(sessionId);
          replaying.delete(sessionId);
          const nativeId = readNativeSessionId(input.persistence);
          if (nativeId) subagents.discard(nativeId);
          skippedHistory.delete(sessionId);
          questionTool.release(sessionId);
          throw error;
        }
        return;
      }
      if (input.type === "session.permission" && input.permissionId.startsWith("paseo-question:")) {
        questionTool.respond(input.permissionId, input.sessionId, input.response);
        return;
      }
      if (input.type === "session.interrupt") questionTool.cancel(input.sessionId);
      if (input.type === "session.close") questionTool.release(input.sessionId);

      if (input.type === "session.permission" && input.permissionId.startsWith("trae-question:")) {
        const handled = await steering.respondToQuestion(
          input.sessionId,
          input.permissionId,
          input.response,
        );
        if (!handled) throw new Error(`Unknown TRAE question: ${input.permissionId}`);
        return;
      }

      if (steeringEnabled && input.type === "session.prompt" && input.prompt.delivery === "steer") {
        await sendSteer(input, steering, activeTurns, emit);
        return;
      }
      // Question guidance is supplied by MCP initialize instructions and the
      // tool description, never appended to the user's persisted message.
      if (input.type === "session.prompt" && !activeTurns.has(input.sessionId))
        await turnUsage.prepare(input.sessionId);
      await connection.send(input);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      turnUsage.dispose();
      subagents.clear();
      replaying.clear();
      unsubscribe();
      unsubscribeQuestions();
      unsubscribeLoads?.();
      configs.clear();
      launches.clear();
      skippedHistory.clear();
      listeners.clear();
      try {
        await Promise.all([questionTool.close(), steering.dispose()]);
      } finally {
        try {
          await connection.close();
        } finally {
          await callCounts.dispose();
        }
      }
    },
  };
}

function modelPickerModels(
  models: ProviderConfigState["models"],
  modelLoads: TraeModelLoadRefresh | null,
): ProviderConfigState["models"] {
  const loaded = modelLoads ? modelLoads.apply(models) : models;
  // An absent description makes Paseo display the internal model ID.
  // An explicit empty description keeps TRAE rows to their name and load.
  return loaded.map((model) => Object.assign({}, model, { description: "" }));
}

// The ACP shim renders mode configOptions as settings even when legacy modes
// already supply the permission selector. Keep the legacy control as the owner.
function deduplicateModeSettings(event: ProviderEvent): ProviderEvent {
  if (event.type !== "session.config" || event.config.modes.length === 0) return event;
  const modeIds = new Set(event.config.modes.map((mode) => mode.id));
  const settings = event.config.settings.filter((setting) => {
    if (setting.type !== "select" || setting.options.length !== modeIds.size) return true;
    return !setting.options.every(
      (option) => typeof option.value === "string" && modeIds.has(option.value),
    );
  });
  if (settings.length === event.config.settings.length) return event;
  return { ...event, config: { ...event.config, settings } };
}

function exposeSessionSteering(event: ProviderEvent, steeringEnabled: boolean): ProviderEvent {
  if (!steeringEnabled || event.type !== "session.opened") return event;
  if (event.capabilities.includes("prompt.steer")) return event;
  return { ...event, capabilities: [...event.capabilities, "prompt.steer"] };
}

function observeEvent(
  event: ProviderEvent,
  steering: ReturnType<typeof createTraeAcpSteeringRegistry>,
  activeTurns: Map<string, string>,
): void {
  if (event.type === "session.opened" || event.type === "session.persistence") {
    const nativeSessionId = readNativeSessionId(event.persistence);
    if (nativeSessionId) steering.bindSession(event.sessionId, nativeSessionId);
  }
  if (event.type === "session.turn") {
    if (event.state === "started") activeTurns.set(event.sessionId, event.turnId);
    else if (activeTurns.get(event.sessionId) === event.turnId) activeTurns.delete(event.sessionId);
  }
  if (event.type === "session.closed") {
    activeTurns.delete(event.sessionId);
    steering.unbindSession(event.sessionId);
  }
}

async function sendSteer(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  steering: ReturnType<typeof createTraeAcpSteeringRegistry>,
  activeTurns: Map<string, string>,
  emit: (event: ProviderEvent) => void,
): Promise<void> {
  const turnId = activeTurns.get(input.sessionId);
  if (!turnId) {
    emitSteerFailure(input, emit, "There is no active turn to steer");
    return;
  }
  if (input.prompt.input.type !== "message") {
    emitSteerFailure(input, emit, "Only message prompts can steer a TRAE turn");
    return;
  }

  const prompt = input.prompt.input.content.map(toAcpContent);
  try {
    const response = steeringResponseSchema.parse(await steering.steer(input.sessionId, prompt));
    if (response.outcome !== "injected") {
      emitSteerFailure(input, emit, `TRAE CLI did not inject steer input: ${response.outcome}`);
      return;
    }
  } catch (error) {
    emitSteerFailure(input, emit, describeError(error));
    return;
  }
  if (activeTurns.get(input.sessionId) !== turnId) {
    emitSteerFailure(input, emit, "The active TRAE turn changed before steering was acknowledged");
    return;
  }

  emit({
    type: "timeline.item",
    sessionId: input.sessionId,
    item: {
      type: "user_message",
      id: input.prompt.clientMessageId,
      text: prompt
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
      clientMessageId: input.prompt.clientMessageId,
    },
  });
  emit({
    type: "session.prompt_result",
    sessionId: input.sessionId,
    clientMessageId: input.prompt.clientMessageId,
    result: { type: "steer", turnId },
  });
}

function emitSteerFailure(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  emit: (event: ProviderEvent) => void,
  message: string,
): void {
  emit({
    type: "session.prompt_result",
    sessionId: input.sessionId,
    clientMessageId: input.prompt.clientMessageId,
    result: { type: "failed", error: { message } },
  });
}

function toAcpContent(content: ProviderContent): AcpPromptPart {
  if (content.type === "text" || content.type === "image") return content;
  return { type: "text", text: JSON.stringify(content) };
}

function readNativeSessionId(persistence: ProviderPersistence | undefined): string | null {
  if (!persistence || typeof persistence.data !== "object" || persistence.data === null)
    return null;
  if (Array.isArray(persistence.data)) return null;
  const sessionId = persistence.data.sessionId;
  return typeof sessionId === "string" ? sessionId : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
