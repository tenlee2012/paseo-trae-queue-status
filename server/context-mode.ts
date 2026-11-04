import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ProviderModel } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { modelStatusLabel } from "./model-status.js";
import { hasNativeContext } from "./native-context.js";

export const CONTEXT_MODE_ID = "trae_context_mode";

const valueSchema = z.looseObject({ value: z.string(), name: z.string() });
const groupSchema = z.looseObject({
  group: z.string(),
  name: z.string(),
  options: z.array(valueSchema),
});
const selectSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  category: z.string().optional(),
  type: z.literal("select"),
  currentValue: z.string(),
  options: z.array(z.union([valueSchema, groupSchema])),
});
const configSchema = z.union([
  selectSchema,
  z.looseObject({ id: z.string(), type: z.literal("boolean"), currentValue: z.boolean() }),
]);
const sessionSchema = z.looseObject({
  configOptions: z.array(configSchema),
  models: z.looseObject({
    currentModelId: z.string(),
    availableModels: z.array(z.looseObject({ modelId: z.string(), name: z.string() })),
  }),
});
const metadataSchema = z.object({
  trae: z.object({ supportsMaxMode: z.boolean() }),
});
const paramsSchema = z.looseObject({ sessionId: z.string() });
const settingSchema = paramsSchema.extend({ configId: z.string(), value: z.unknown() });
const updateSchema = z.looseObject({
  sessionId: z.string(),
  update: z.looseObject({ sessionUpdate: z.string() }),
});

type Select = z.infer<typeof selectSchema>;
type Config = z.infer<typeof configSchema>;
type Value = z.infer<typeof valueSchema>;
type RequestId = string | number | null;
type ContextMode = "standard" | "max";

interface ModelSelection {
  nativeId: string;
  model: string;
  context: ContextMode;
  thinking: string | null;
}

interface SessionState {
  options: Config[];
  modelOption: Select;
  thinkingOption: Select | null;
  selections: ModelSelection[];
  selected: ModelSelection;
  changing: boolean;
}

interface PendingRequest {
  method: string;
  params: unknown;
  change?: { state: SessionState; selected: ModelSelection };
}

type Outgoing = { message: AcpStreamMessage } | { response: AcpStreamMessage };

// TRAE's configOptions omit context mode. Its legacy model IDs encode both
// context and effort, so model/effort changes must use the same legacy setter.
export class TraeContextModeBridge {
  private readonly sessions = new Map<string, SessionState>();
  private readonly pending = new Map<RequestId, PendingRequest>();
  private catalogState: SessionState | null = null;
  constructor(private initializing = false) {}

  markSessionBound(): void {
    this.initializing = false;
  }

  modelCatalog(): readonly ProviderModel[] {
    const state = this.sessions.values().next().value ?? this.catalogState;
    if (!state) return [];
    const labels = state.thinkingOption ? values(state.thinkingOption) : [];
    return values(state.modelOption).map((model) => {
      const candidates = state.selections.filter(
        (candidate) => candidate.model === model.value && candidate.context === "standard",
      );
      const levels =
        state.modelOption.currentValue === model.value && state.thinkingOption?.options.length === 0
          ? []
          : [
              ...new Set(
                candidates.flatMap((candidate) =>
                  candidate.thinking === null ? [] : [candidate.thinking],
                ),
              ),
            ];
      const thinkingOptions = levels.map((id) => ({
        id,
        label:
          labels.find((option) => option.value === id)?.name ??
          id.charAt(0).toUpperCase() + id.slice(1),
      }));
      const current = state.thinkingOption?.currentValue;
      const defaultThinkingOptionId = levels.find((id) => id === current) ?? levels[0];
      return {
        id: model.value,
        label: modelStatusLabel(model.name, model._meta),
        thinkingOptions,
        defaultThinkingOptionId,
      };
    });
  }

  outgoing(message: AcpStreamMessage): Outgoing {
    if (!("method" in message) || !("id" in message)) return { message };
    const request: PendingRequest = { method: message.method, params: message.params };
    if (message.method === "session/set_config_option") {
      const parsed = settingSchema.safeParse(message.params);
      if (parsed.success) {
        const state = this.sessions.get(parsed.data.sessionId);
        if (state && isSelectionSetting(state, parsed.data.configId)) {
          if (state.changing)
            return { response: rpcError(message.id, "Model configuration is already changing") };
          const selected = selectChange(
            state,
            parsed.data.configId,
            parsed.data.value,
            this.initializing,
          );
          if (!selected)
            return {
              response: rpcError(
                message.id,
                "This model, context mode, or thinking level is unavailable",
              ),
            };
          state.changing = true;
          request.change = { state, selected };
          this.pending.set(message.id, request);
          return {
            message: {
              ...message,
              method: "session/set_model",
              params: { sessionId: parsed.data.sessionId, modelId: selected.nativeId },
            },
          };
        }
        if (parsed.data.configId === CONTEXT_MODE_ID) {
          return {
            response: rpcError(message.id, "TRAE CLI did not expose context mode for this session"),
          };
        }
      }
    }
    this.pending.set(message.id, request);
    return { message };
  }

  incoming(message: AcpStreamMessage): AcpStreamMessage[] {
    if ("method" in message) return this.notification(message);
    const request = this.pending.get(message.id);
    if (!request) return [message];
    this.pending.delete(message.id);
    if (request.change) {
      const { state, selected } = request.change;
      state.changing = false;
      if ("error" in message) return [message];
      state.selected = selected;
      const result = z.record(z.string(), z.unknown()).parse(message.result);
      return [{ ...message, result: { ...result, configOptions: decorate(state) } }];
    }
    if ("error" in message) return [message];
    const params = paramsSchema.safeParse(request.params);
    if (request.method === "session/close" && params.success) {
      this.sessions.delete(params.data.sessionId);
      return [message];
    }
    const snapshot = z.object({ configOptions: z.array(configSchema) }).safeParse(message.result);
    const existing = params.success ? this.sessions.get(params.data.sessionId) : undefined;
    if (existing && snapshot.success) {
      updateOptions(existing, snapshot.data.configOptions);
      const result = z.record(z.string(), z.unknown()).parse(message.result);
      return [{ ...message, result: { ...result, configOptions: decorate(existing) } }];
    }
    const result = sessionSchema.safeParse(message.result);
    if (!result.success) return [message];
    const sessionId = z.object({ sessionId: z.string() }).safeParse(message.result);
    const id = sessionId.success
      ? sessionId.data.sessionId
      : params.success
        ? params.data.sessionId
        : null;
    if (!id) return [message];
    this.catalogState = createState(result.data, true);
    const state = createState(result.data);
    if (!state) return [{ ...message, result: result.data }];
    this.sessions.set(id, state);
    return [{ ...message, result: { ...result.data, configOptions: decorate(state) } }];
  }

  private notification(message: Extract<AcpStreamMessage, { method: string }>): AcpStreamMessage[] {
    if (message.method !== "session/update") return [message];
    const parsed = updateSchema.safeParse(message.params);
    if (!parsed.success) return [message];
    const state = this.sessions.get(parsed.data.sessionId);
    if (!state) return [message];
    const update = parsed.data.update;
    if (update.sessionUpdate !== "config_option_update") return [message];
    // Do not publish a partial snapshot while the legacy setter is in flight.
    if (state.changing) return [];
    const options = z.object({ configOptions: z.array(configSchema) }).safeParse(update);
    if (!options.success) return [message];
    updateOptions(state, options.data.configOptions);
    const model = findSelect(state.options, "model");
    const thinking = findSelect(state.options, "thought_level");
    const selected = state.selections.find(
      (candidate) =>
        candidate.model === model?.currentValue &&
        candidate.context === state.selected.context &&
        candidate.thinking === (thinking?.currentValue ?? null),
    );
    const committed =
      selected ??
      state.selections.find(
        (candidate) =>
          candidate.model === model?.currentValue &&
          candidate.context === "standard" &&
          candidate.thinking === (thinking?.currentValue ?? null),
      );
    if (!committed) {
      // An unrecognized native model cannot safely inherit a synthetic Max value.
      this.sessions.delete(parsed.data.sessionId);
      return [message];
    }
    state.selected = committed;
    return [
      {
        ...message,
        params: { ...parsed.data, update: { ...update, configOptions: decorate(state) } },
      },
    ];
  }
}

function updateOptions(state: SessionState, options: Config[]): void {
  const restored = [...options];
  const model = findSelect(restored, "model");
  if (!restored.some((option) => option.category === "model"))
    restored.push({ ...state.modelOption, currentValue: state.selected.model });
  if (
    (!model || model.currentValue === state.selected.model) &&
    !restored.some((option) => option.category === "thought_level") &&
    state.selected.thinking !== null &&
    state.thinkingOption
  )
    restored.push({ ...state.thinkingOption, currentValue: state.selected.thinking });
  state.options = restored;
  const thinking = findSelect(restored, "thought_level");
  if (model) state.modelOption = model;
  if (thinking) state.thinkingOption = thinking;
}

function createState(
  response: z.infer<typeof sessionSchema>,
  forCatalog = false,
): SessionState | null {
  // A future native model_config control owns context selection without this bridge.
  const nativeContext = hasNativeContext(response.configOptions);
  if (nativeContext && !forCatalog) return null;
  const modelOption = findSelect(response.configOptions, "model");
  if (!modelOption) return null;
  const models = values(modelOption).toSorted(
    (left, right) => right.value.length - left.value.length,
  );
  const selections: ModelSelection[] = [];
  for (const model of models) {
    const native = response.models.availableModels.filter((entry) => {
      const owner = models.find(
        (candidate) =>
          entry.modelId === candidate.value || entry.modelId.startsWith(`${candidate.value}/`),
      );
      return owner === model;
    });
    const metadata = metadataSchema.safeParse(model._meta);
    const supportsMax = metadata.success && metadata.data.trae.supportsMaxMode;
    const hasBareModel = native.some((entry) => entry.modelId === model.value);
    for (const entry of native) {
      const suffix = entry.modelId
        .slice(model.value.length + 1)
        .split("/")
        .filter(Boolean);
      let context: ContextMode = "standard";
      let thinking: string | null = suffix[0] ?? null;
      if (supportsMax && suffix[0] === "max" && (suffix.length === 2 || hasBareModel)) {
        context = "max";
        thinking = suffix[1] ?? null;
      } else if (suffix.length > 1) continue;
      selections.push({ nativeId: entry.modelId, model: model.value, context, thinking });
    }
  }
  if (selections.length === 0) return null;
  const selected = selections.find(
    (selection) => selection.nativeId === response.models.currentModelId,
  );
  if (!selected) return null;
  return {
    options: response.configOptions,
    modelOption,
    thinkingOption: findSelect(response.configOptions, "thought_level"),
    selections,
    selected,
    changing: false,
  };
}

function selectChange(
  state: SessionState,
  id: string,
  value: unknown,
  initializing: boolean,
): ModelSelection | undefined {
  if (typeof value !== "string") return undefined;
  const current = state.selected;
  if (id === state.thinkingOption?.id) {
    return state.selections.find(
      (candidate) =>
        candidate.model === current.model &&
        candidate.context === current.context &&
        candidate.thinking === value,
    );
  }
  const model = id === state.modelOption.id ? value : current.model;
  let context = current.context;
  if (id === CONTEXT_MODE_ID) {
    if (value !== "standard" && value !== "max") return undefined;
    context = value;
    // A new/restored session can inherit GPT's saved Max setting before the
    // composer receives the selected model's controls. Trust this session's
    // native variants and use Standard only during initial configuration.
    if (
      initializing &&
      context === "max" &&
      !state.selections.some(
        (candidate) => candidate.model === model && candidate.context === "max",
      )
    )
      context = "standard";
  } else if (
    !state.selections.some(
      (candidate) => candidate.model === model && candidate.context === context,
    )
  ) {
    context = "standard";
  }
  const choices = state.selections.filter(
    (candidate) => candidate.model === model && candidate.context === context,
  );
  return choices.find((candidate) => candidate.thinking === current.thinking) ?? choices[0];
}

function decorate(state: SessionState): Config[] {
  const selected = state.selected;
  const choices = state.selections.filter(
    (candidate) => candidate.model === selected.model && candidate.context === selected.context,
  );
  const hasMax = state.selections.some(
    (candidate) => candidate.model === selected.model && candidate.context === "max",
  );
  const options: Config[] = [
    {
      ...state.modelOption,
      currentValue: selected.model,
      options: state.modelOption.options.map((entry) => {
        if ("group" in entry) {
          const group = groupSchema.parse(entry);
          return { ...group, options: group.options.map(modelLoadValue) };
        }
        return modelLoadValue(valueSchema.parse(entry));
      }),
    },
    {
      id: CONTEXT_MODE_ID,
      name: "Context",
      category: "model_config",
      type: "select",
      currentValue: selected.context,
      options: hasMax
        ? [
            { value: "standard", name: "Standard" },
            { value: "max", name: "Max" },
          ]
        : [{ value: "standard", name: "Standard" }],
    },
  ];
  const thoughts = choices.flatMap((candidate) =>
    candidate.thinking === null ? [] : [candidate.thinking],
  );
  if (
    selected.thinking !== null &&
    findSelect(state.options, "thought_level")?.options.length !== 0
  ) {
    const template = state.thinkingOption ?? {
      id: "reasoning_effort",
      name: "Reasoning Effort",
      category: "thought_level",
      type: "select" as const,
      currentValue: selected.thinking,
      options: [],
    };
    const labels = values(template);
    const thinkingOption: Select = {
      ...template,
      currentValue: selected.thinking,
      options: [...new Set(thoughts)].map(
        (value) =>
          labels.find((option) => option.value === value) ?? {
            value,
            name: value.charAt(0).toUpperCase() + value.slice(1),
          },
      ),
    };
    state.thinkingOption = thinkingOption;
    options.push(thinkingOption);
  }
  options.push(
    ...state.options.filter(
      (option) =>
        option.id !== CONTEXT_MODE_ID &&
        !(
          option.type === "select" &&
          (option.category === "model" || option.category === "thought_level")
        ),
    ),
  );
  return options;
}

function findSelect(options: Config[], category: string): Select | null {
  return (
    options.find(
      (option): option is Select => option.type === "select" && option.category === category,
    ) ?? null
  );
}

function values(option: Select): Value[] {
  return option.options.flatMap((entry) =>
    "group" in entry ? groupSchema.parse(entry).options : [valueSchema.parse(entry)],
  );
}

function modelLoadValue(value: Value): Value {
  return { ...value, name: modelStatusLabel(value.name, value._meta) };
}

function isSelectionSetting(state: SessionState, id: string): boolean {
  return id === CONTEXT_MODE_ID || id === state.modelOption.id || id === state.thinkingOption?.id;
}

function rpcError(id: RequestId, message: string): AcpStreamMessage {
  return { jsonrpc: "2.0", id, error: { code: -32602, message } };
}
