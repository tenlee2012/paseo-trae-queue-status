import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { z } from "zod";

const valueSchema = z.looseObject({
  value: z.string().min(1),
  name: z.string(),
  description: z.string().nullish(),
});
const groupSchema = z.looseObject({
  group: z.string(),
  name: z.string(),
  options: z.array(valueSchema),
});
const selectorSchema = z.looseObject({
  id: z.string(),
  category: z.literal("mode"),
  type: z.literal("select"),
  currentValue: z.string().min(1),
  options: z.array(z.union([valueSchema, groupSchema])),
});
const snapshotSchema = z.looseObject({ configOptions: z.array(z.unknown()) });
const paramsSchema = z.looseObject({ sessionId: z.string() });
const modeParamsSchema = paramsSchema.extend({ modeId: z.string() });
const updateSchema = paramsSchema.extend({
  update: z.looseObject({ sessionUpdate: z.literal("config_option_update") }),
});
type Selector = z.infer<typeof selectorSchema>;
type RequestId = string | number | null;
interface Pending {
  method: string;
  sessionId?: string;
  modeId?: string;
}

// Paseo's mode API requires legacy `modes`. Adapt sessions that expose only
// a mode config option, keeping the real option as the authority for permissions.
export class TraePermissionModeBridge {
  private readonly sessions = new Map<string, Selector>();
  private readonly pending = new Map<RequestId, Pending>();

  outgoing(message: AcpStreamMessage): AcpStreamMessage {
    if (!("method" in message) || !("id" in message)) return message;
    const params = paramsSchema.safeParse(message.params);
    const sessionId = params.success ? params.data.sessionId : undefined;
    const request: Pending = { method: message.method, sessionId };
    const selector = sessionId ? this.sessions.get(sessionId) : undefined;
    const mode =
      message.method === "session/set_mode" ? modeParamsSchema.safeParse(message.params) : null;
    if (selector && mode?.success) {
      request.modeId = mode.data.modeId;
      this.pending.set(message.id, request);
      return {
        ...message,
        method: "session/set_config_option",
        params: {
          sessionId: mode.data.sessionId,
          configId: selector.id,
          value: mode.data.modeId,
        },
      };
    }
    this.pending.set(message.id, request);
    return message;
  }

  incoming(message: AcpStreamMessage): AcpStreamMessage[] {
    if ("method" in message) {
      if (message.method !== "session/update") return [message];
      const parsed = updateSchema.safeParse(message.params);
      if (!parsed.success) return [message];
      return [...this.update(parsed.data.sessionId, parsed.data.update), message];
    }
    const request = this.pending.get(message.id);
    if (!request) return [message];
    this.pending.delete(message.id);
    if ("error" in message) return [message];
    if (request.method === "session/close" && request.sessionId) {
      this.sessions.delete(request.sessionId);
      return [message];
    }
    if (request.method === "session/new" || request.method === "session/load") {
      const snapshot = snapshotSchema.safeParse(message.result);
      if (!snapshot.success || snapshot.data.modes != null) return [message];
      const params = paramsSchema.safeParse(message.result);
      const sessionId = params.success ? params.data.sessionId : request.sessionId;
      const selector = findSelector(snapshot.data.configOptions);
      if (!sessionId || !selector) return [message];
      this.sessions.set(sessionId, selector);
      return [{ ...message, result: { ...snapshot.data, modes: modes(selector) } }];
    }
    if (!request.sessionId) return [message];
    if (request.modeId !== undefined) {
      const snapshot = snapshotSchema.safeParse(message.result);
      const selector = snapshot.success ? findSelector(snapshot.data.configOptions) : undefined;
      if (!snapshot.success || !selector || selector.currentValue !== request.modeId) {
        return [
          {
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32603,
              message: "TRAE CLI did not confirm the selected permission mode",
            },
          },
        ];
      }
      return [
        ...this.update(request.sessionId, message.result),
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: request.sessionId,
            update: {
              sessionUpdate: "config_option_update",
              configOptions: snapshot.data.configOptions,
            },
          },
        },
        message,
      ];
    }
    return [...this.update(request.sessionId, message.result), message];
  }

  private update(sessionId: string, value: unknown): AcpStreamMessage[] {
    const previous = this.sessions.get(sessionId);
    if (!previous) return [];
    const snapshot = snapshotSchema.safeParse(value);
    if (!snapshot.success) return [];
    const selector = findSelector(snapshot.data.configOptions);
    if (!selector) return [];
    this.sessions.set(sessionId, selector);
    if (selector.currentValue === previous.currentValue) return [];
    return [
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "current_mode_update", currentModeId: selector.currentValue },
        },
      },
    ];
  }
}

function findSelector(options: unknown[]): Selector | undefined {
  for (const option of options) {
    const parsed = selectorSchema.safeParse(option);
    if (
      parsed.success &&
      values(parsed.data).some((entry) => entry.value === parsed.data.currentValue)
    )
      return parsed.data;
  }
  return undefined;
}

function values(selector: Selector): z.infer<typeof valueSchema>[] {
  return selector.options.flatMap((entry) =>
    "group" in entry ? groupSchema.parse(entry).options : [valueSchema.parse(entry)],
  );
}

function modes(selector: Selector) {
  return {
    currentModeId: selector.currentValue,
    availableModes: values(selector).map(({ value, name, description }) => ({
      id: value,
      name,
      description: description ?? undefined,
    })),
  };
}
