import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { z } from "zod";

export const PLAN_MODE_ID = "plan_mode";
export const COLLABORATION_MODE_ID = "collaboration_mode";

export function preferredPlanSettings<T extends Record<string, unknown>>(settings: T): T {
  if (!(COLLABORATION_MODE_ID in settings) || !(PLAN_MODE_ID in settings)) return settings;
  const preferred = { ...settings };
  delete preferred[PLAN_MODE_ID];
  return preferred;
}
const modeSchema = z.looseObject({ id: z.string(), name: z.string() });
const optionSchema = z.looseObject({
  id: z.string(),
  category: z.string().optional(),
  currentValue: z.unknown().optional(),
});
const resultSchema = z.looseObject({
  modes: z.looseObject({ currentModeId: z.string(), availableModes: z.array(modeSchema) }),
  configOptions: z.array(optionSchema).optional(),
});
const initialResultSchema = resultSchema.extend({ modes: resultSchema.shape.modes.nullish() });
const paramsSchema = z.looseObject({ sessionId: z.string() });
const modeParamsSchema = paramsSchema.extend({ modeId: z.string() });
const settingParamsSchema = paramsSchema.extend({ configId: z.string(), value: z.unknown() });
const configSchema = z.looseObject({ configOptions: z.array(optionSchema) });
const updateSchema = paramsSchema.extend({ update: z.looseObject({ sessionUpdate: z.string() }) });
type Option = z.infer<typeof optionSchema>;
type Mode = z.infer<typeof modeSchema>;
type RequestId = string | number | null;

interface State {
  modes: Mode[];
  options: Option[];
  permission: string;
  plan: boolean;
  changing: boolean;
  collaboration?: Option;
}
interface Pending {
  method: string;
  sessionId?: string;
  change?: { sessionId: string; state: State; permission: string; plan: boolean };
}
type Outgoing = { message: AcpStreamMessage } | { responses: AcpStreamMessage[] };

// Prefer native collaboration controls. Older CLIs expose Plan as a permission
// mode; keep their read-only behavior behind a separate planning toggle.
export class TraePlanModeBridge {
  private readonly sessions = new Map<string, State>();
  private readonly pending = new Map<RequestId, Pending>();

  initialMode(message: AcpStreamMessage) {
    if (!("result" in message)) return undefined;
    const request = this.pending.get(message.id);
    if (request?.method !== "session/new" && request?.method !== "session/load") return undefined;
    const result = initialResultSchema.safeParse(message.result);
    if (!result.success) return undefined;
    const permissionOption = result.data.modes
      ? undefined
      : modesFromOptions(result.data.configOptions ?? []);
    const modes = result.data.modes ?? permissionOption?.modes;
    if (!modes || modes.currentModeId !== "plan") return undefined;
    const collaboration = findCollaboration(result.data.configOptions ?? []);
    if (!collaboration || typeof collaboration.currentValue !== "string") return undefined;
    const permission =
      modes.availableModes.find((mode) => mode.id === "default") ??
      modes.availableModes.find((mode) => mode.id !== "plan");
    const id = paramsSchema.safeParse(message.result);
    const sessionId = id.success ? id.data.sessionId : request.sessionId;
    if (!permission || !sessionId) return undefined;
    return {
      sessionId,
      modes: { ...modes, currentModeId: permission.id },
      permissionConfigId: permissionOption?.configId,
      previousCollaboration: collaboration.currentValue,
    };
  }

  outgoing(message: AcpStreamMessage): Outgoing {
    if (!("method" in message) || !("id" in message)) return { message };
    const params = paramsSchema.safeParse(message.params);
    const sessionId = params.success ? params.data.sessionId : undefined;
    const request: Pending = { method: message.method, sessionId };
    const state = sessionId ? this.sessions.get(sessionId) : undefined;
    const setting =
      message.method === "session/set_config_option"
        ? settingParamsSchema.safeParse(message.params)
        : null;
    const mode =
      message.method === "session/set_mode" ? modeParamsSchema.safeParse(message.params) : null;
    const legacySetting = setting?.success && setting.data.configId === PLAN_MODE_ID;
    const collaborationFallback =
      setting?.success &&
      setting.data.configId === COLLABORATION_MODE_ID &&
      state &&
      !state.collaboration;
    const planSetting = legacySetting || collaborationFallback;
    const requestedPlan = setting?.success
      ? legacySetting && typeof setting.data.value === "boolean"
        ? setting.data.value
        : collaborationFallback &&
            (setting.data.value === "plan" || setting.data.value === "default")
          ? setting.data.value === "plan"
          : undefined
      : undefined;
    if (planSetting && (!state || requestedPlan === undefined)) {
      return {
        responses: [
          rpcError(message.id, "TRAE CLI did not expose a valid Plan toggle for this session"),
        ],
      };
    }
    if (state && sessionId) {
      // Old saved toggles remain valid after upgrading, but only the native
      // collaboration selector owns planning when it is advertised.
      if (legacySetting && state.collaboration) {
        this.pending.set(message.id, request);
        return {
          message: {
            ...message,
            params: {
              sessionId,
              configId: COLLABORATION_MODE_ID,
              value: requestedPlan ? "plan" : "default",
            },
          },
        };
      }
      const nativeSetting =
        setting?.success &&
        state.options.some(
          (option) =>
            option.id === setting.data.configId &&
            option.category === "mode" &&
            option.id !== COLLABORATION_MODE_ID,
        );
      let permission: string | null = null;
      if (mode?.success) permission = mode.data.modeId;
      else if (nativeSetting && setting?.success && typeof setting.data.value === "string") {
        permission = setting.data.value;
      }
      if (planSetting || permission !== null) {
        if (state.changing)
          return {
            responses: [rpcError(message.id, "TRAE mode configuration is already changing")],
          };
        if (state.collaboration && permission === "plan")
          return { responses: [rpcError(message.id, "Use Collaboration mode to select Plan")] };
        if (
          permission !== null &&
          permission !== "plan" &&
          !state.modes.some((entry) => entry.id === permission)
        ) {
          return { responses: [rpcError(message.id, "TRAE permission mode is unavailable")] };
        }
        if (permission !== null && permission !== "plan" && state.plan && !state.collaboration) {
          state.permission = permission;
          return {
            responses: [...updates(sessionId, state), response(message.id, request.method, state)],
          };
        }
        const plan = state.collaboration
          ? false
          : planSetting
            ? requestedPlan!
            : permission === "plan";
        const nextPermission = permission && permission !== "plan" ? permission : state.permission;
        if (planSetting && state.plan === plan) {
          return { responses: [response(message.id, request.method, state)] };
        }
        request.change = { sessionId, state, permission: nextPermission, plan };
        state.changing = true;
        this.pending.set(message.id, request);
        return {
          message: {
            ...message,
            method: "session/set_mode",
            params: { sessionId, modeId: plan ? "plan" : nextPermission },
          },
        };
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
      const { sessionId, state, permission, plan } = request.change;
      state.changing = false;
      if ("error" in message) return [message];
      state.permission = permission;
      state.plan = plan;
      const snapshot = configSchema.safeParse(message.result);
      if (snapshot.success) updateOptions(state, snapshot.data.configOptions);
      return [...updates(sessionId, state), response(message.id, request.method, state)];
    }
    if ("error" in message) return [message];
    if (request.method === "session/close" && request.sessionId) {
      this.sessions.delete(request.sessionId);
      return [message];
    }
    const opened = resultSchema.safeParse(message.result);
    if (opened.success) {
      const id = paramsSchema.safeParse(message.result);
      const sessionId = id.success ? id.data.sessionId : request.sessionId;
      const { modes, configOptions = [] } = opened.data;
      const collaboration = findCollaboration(configOptions);
      const permissions = modes.availableModes.filter((mode) => mode.id !== "plan");
      const supportsPlan = modes.availableModes.some((mode) => mode.id === "plan");
      if (
        !sessionId ||
        (!supportsPlan && !collaboration) ||
        permissions.length === 0 ||
        (!collaboration && configOptions.some((option) => option.id === PLAN_MODE_ID))
      )
        return [message];
      const permission =
        modes.currentModeId === "plan"
          ? (permissions.find((mode) => mode.id === "default") ?? permissions[0]).id
          : modes.currentModeId;
      const state: State = {
        modes: permissions,
        options: configOptions,
        permission,
        plan: !collaboration && modes.currentModeId === "plan",
        changing: false,
        collaboration,
      };
      this.sessions.set(sessionId, state);
      return [
        {
          ...message,
          result: {
            ...opened.data,
            modes: { ...modes, currentModeId: permission, availableModes: permissions },
            configOptions: sessionOptions(state),
          },
        },
      ];
    }
    const state = request.sessionId ? this.sessions.get(request.sessionId) : undefined;
    const snapshot = configSchema.safeParse(message.result);
    if (state && snapshot.success) {
      updateOptions(state, snapshot.data.configOptions);
      return [{ ...message, result: { ...snapshot.data, configOptions: sessionOptions(state) } }];
    }
    return [message];
  }

  private notification(message: Extract<AcpStreamMessage, { method: string }>): AcpStreamMessage[] {
    if (message.method !== "session/update") return [message];
    const parsed = updateSchema.safeParse(message.params);
    if (!parsed.success) return [message];
    const { sessionId, update } = parsed.data;
    const state = this.sessions.get(sessionId);
    if (!state) return [message];
    if (update.sessionUpdate === "current_mode_update") {
      if (state.changing) return [];
      if (typeof update.currentModeId !== "string") return [message];
      state.plan = !state.collaboration && update.currentModeId === "plan";
      if (!state.plan) state.permission = update.currentModeId;
      return updates(sessionId, state);
    }
    if (update.sessionUpdate === "config_option_update") {
      if (state.changing) return [];
      const snapshot = configSchema.safeParse(update);
      if (!snapshot.success) return [message];
      updateOptions(state, snapshot.data.configOptions);
      const nativeMode = state.options.find((option) => option.category === "mode")?.currentValue;
      if (typeof nativeMode === "string") {
        state.plan = !state.collaboration && nativeMode === "plan";
        if (!state.plan) state.permission = nativeMode;
      }
      return [
        {
          ...message,
          params: { ...parsed.data, update: { ...update, configOptions: sessionOptions(state) } },
        },
      ];
    }
    return [message];
  }
}

function sessionOptions(state: State): Option[] {
  const decorated = state.options
    .filter((option) => option.id !== PLAN_MODE_ID)
    .map((option) => {
      if (option.category !== "mode" || option.id === COLLABORATION_MODE_ID) return option;
      const entries = z.array(z.looseObject({ value: z.string() })).safeParse(option.options);
      if (!entries.success) return option;
      return Object.assign({}, option, {
        currentValue: state.permission,
        options: entries.data.filter((entry) => entry.value !== "plan"),
      });
    });
  if (state.collaboration) return decorated;
  return [
    ...decorated,
    {
      id: PLAN_MODE_ID,
      name: "Plan",
      description: "Toggle plan mode",
      type: "boolean",
      currentValue: state.plan,
    },
  ];
}

function findCollaboration(options: Option[]): Option | undefined {
  return options.find((option) => option.id === COLLABORATION_MODE_ID && option.type === "select");
}

function modesFromOptions(options: Option[]) {
  const selector = options.find(
    (option) => option.category === "mode" && option.id !== COLLABORATION_MODE_ID,
  );
  if (!selector || typeof selector.currentValue !== "string" || !Array.isArray(selector.options))
    return undefined;
  const values = selector.options.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const group = z.looseObject({ options: z.array(z.unknown()) }).safeParse(entry);
    return group.success ? group.data.options : [entry];
  });
  const parsed = z.array(z.object({ value: z.string(), name: z.string() })).safeParse(values);
  if (!parsed.success) return undefined;
  return {
    configId: selector.id,
    modes: {
      currentModeId: selector.currentValue,
      availableModes: parsed.data.map(({ value, name }) => ({ id: value, name })),
    },
  };
}

function updateOptions(state: State, options: Option[]): void {
  state.collaboration = findCollaboration(options) ?? state.collaboration;
  state.options =
    state.collaboration && !findCollaboration(options)
      ? [...options, state.collaboration]
      : options;
  if (state.collaboration) state.plan = false;
}

function updates(sessionId: string, state: State): AcpStreamMessage[] {
  return [
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "current_mode_update", currentModeId: state.permission },
      },
    },
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "config_option_update", configOptions: sessionOptions(state) },
      },
    },
  ];
}

function response(id: RequestId, method: string, state: State): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    id,
    result: method === "session/set_config_option" ? { configOptions: sessionOptions(state) } : {},
  };
}

function rpcError(id: RequestId, message: string): AcpStreamMessage {
  return { jsonrpc: "2.0", id, error: { code: -32602, message } };
}
