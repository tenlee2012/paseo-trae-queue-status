import type {
  AcpStreamMessage,
  AcpTransformer,
  AcpToolCallSnapshot,
} from "@getpaseo/plugin/server/acp";
import { ProviderEventSchema, type ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { cleanTraePrompt } from "./prompt-text.js";

const HISTORY_METHOD = "paseo/trae-history-replay";
const chunkSchema = z.object({
  sessionUpdate: z.enum(["user_message_chunk", "agent_message_chunk", "agent_thought_chunk"]),
  messageId: z.string().nullish(),
  content: z.object({ type: z.string(), text: z.string().optional() }),
});
const toolSchema = z.object({
  sessionUpdate: z.enum(["tool_call", "tool_call_update"]),
  toolCallId: z.string(),
  name: z.string().nullish(),
  title: z.string().nullish(),
  kind: z.string().nullish(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]).nullish(),
  rawInput: z.json().optional(),
  rawOutput: z.json().optional(),
  content: z.array(z.json()).optional(),
  locations: z.array(z.object({ path: z.string() })).nullish(),
});
const planSchema = z.object({
  sessionUpdate: z.literal("plan"),
  entries: z.array(
    z.object({ content: z.string(), status: z.enum(["pending", "in_progress", "completed"]) }),
  ),
});
const compactionSchema = z.object({
  sessionUpdate: z.literal("compaction_update"),
  compactionId: z.string(),
  status: z.string(),
});
const updateSchema = z.union([chunkSchema, toolSchema, planSchema, compactionSchema]);
const updateTypes = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "compaction_update",
]);
const notificationSchema = z.object({
  sessionId: z.string(),
  update: z.looseObject({ sessionUpdate: z.string() }),
});

interface Replay {
  requestId: string | number;
  sessionId: string;
  items: Map<string, ProviderTimelineItem>;
  tools: Map<string, AcpToolCallSnapshot>;
  chunk?: { type: string; id: string };
  sequence: number;
}

// COMPAT(acp-load-history): added for Paseo v0.12.0, remove after 2027-01-20 once
// supported hosts accept replay before session/load resolves and retain user chunks.
// Vendor transforms run in wire order without the core adapter's unbound-session filter.
export class TraeHistoryReplayBridge {
  private replay: Replay | undefined;

  outgoing(message: AcpStreamMessage): void {
    if (
      !("id" in message) ||
      !("method" in message) ||
      message.method !== "session/load" ||
      message.id === null
    )
      return;
    const { sessionId } = z.object({ sessionId: z.string() }).parse(message.params);
    if (this.replay) throw new Error("TRAE history load is already in progress");
    this.replay = {
      requestId: message.id,
      sessionId,
      items: new Map(),
      tools: new Map(),
      sequence: 0,
    };
  }

  incoming(message: AcpStreamMessage): AcpStreamMessage[] {
    const replay = this.replay;
    if (!replay) return [message];
    if ("id" in message && !("method" in message) && message.id === replay.requestId) {
      this.replay = undefined;
      if ("error" in message) return [message];
      const notifications: AcpStreamMessage[] = [...replay.items.values()].map((item) => ({
        jsonrpc: "2.0",
        method: HISTORY_METHOD,
        params: {
          item: item.type === "user_message" ? { ...item, text: cleanTraePrompt(item.text) } : item,
        },
      }));
      return [...notifications, message];
    }
    if (!("method" in message) || "id" in message || message.method !== "session/update")
      return [message];
    const parsed = notificationSchema.safeParse(message.params);
    if (!parsed.success || parsed.data.sessionId !== replay.sessionId) return [message];
    if (!updateTypes.has(parsed.data.update.sessionUpdate)) return [message];
    this.accept(replay, updateSchema.parse(parsed.data.update));
    return [];
  }

  accept(replay: Replay, update: z.infer<typeof updateSchema>): ProviderTimelineItem | undefined {
    if (
      update.sessionUpdate === "user_message_chunk" ||
      update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk"
    ) {
      return this.acceptChunk(replay, update);
    }
    replay.chunk = undefined;
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const current = replay.tools.get(update.toolCallId);
      const snapshot: AcpToolCallSnapshot = {
        id: update.toolCallId,
        name: update.name ?? current?.name,
        title: update.title ?? current?.title ?? update.name ?? "Tool call",
        kind: update.kind ?? current?.kind,
        status: update.status ?? current?.status ?? "pending",
        input: update.rawInput === undefined ? (current?.input ?? null) : update.rawInput,
        output:
          update.rawOutput === undefined
            ? (update.content ?? current?.output ?? null)
            : update.rawOutput,
        locations: update.locations?.map((location) => location.path) ?? current?.locations ?? [],
      };
      replay.tools.set(snapshot.id, snapshot);
      return this.put(replay, toolItem(snapshot));
    } else if (update.sessionUpdate === "plan") {
      return this.put(replay, {
        type: "todo",
        id: "acp-plan",
        items: update.entries.map((entry, index) => ({
          id: String(index),
          text: entry.content,
          completed: entry.status === "completed",
          status: entry.status,
        })),
      });
    } else if (update.sessionUpdate === "compaction_update") {
      return this.put(replay, {
        type: "compaction",
        id: update.compactionId,
        status: update.status === "completed" ? "completed" : "loading",
      });
    }
  }

  private acceptChunk(
    replay: Replay,
    update: z.infer<typeof chunkSchema>,
  ): ProviderTimelineItem | undefined {
    if (update.content.type !== "text") return;
    let id: string;
    if (update.messageId) {
      id = JSON.stringify([update.sessionUpdate, update.messageId]);
      replay.chunk = undefined;
    } else {
      if (replay.chunk?.type === update.sessionUpdate) id = replay.chunk.id;
      else id = `trae-history:${replay.sessionId}:${++replay.sequence}`;
      replay.chunk = { type: update.sessionUpdate, id };
    }
    const previous = replay.items.get(id);
    const text = previous && "text" in previous ? previous.text : "";
    let type: "user_message" | "assistant_message" | "reasoning";
    if (update.sessionUpdate === "user_message_chunk") type = "user_message";
    else if (update.sessionUpdate === "agent_message_chunk") type = "assistant_message";
    else type = "reasoning";
    return this.put(replay, {
      type,
      id,
      text: text + (update.content.text ?? ""),
      ...(update.messageId && type !== "reasoning" ? { messageId: update.messageId } : {}),
    });
  }

  private put(replay: Replay, item: ProviderTimelineItem): ProviderTimelineItem {
    replay.items.set(item.id, item);
    return item;
  }
}

// Child projections use the same snapshot conversion for live updates and replay.
export class TraeTimelineAccumulator {
  private readonly bridge = new TraeHistoryReplayBridge();
  private readonly state: Replay;

  constructor(sessionId: string) {
    this.state = { requestId: 0, sessionId, items: new Map(), tools: new Map(), sequence: 0 };
  }

  accept(value: unknown): ProviderTimelineItem[] {
    const parsed = updateSchema.safeParse(value);
    if (!parsed.success) return [];
    const item = this.bridge.accept(this.state, parsed.data);
    return item ? [item] : [];
  }
}

export const historyReplayTransformer: AcpTransformer = {
  notification(notification, context) {
    if (notification.method !== HISTORY_METHOD) return null;
    const { item } = z.object({ item: z.json() }).parse(notification.params);
    const event = ProviderEventSchema.parse({
      type: "timeline.item",
      sessionId: context.sessionId,
      item,
    });
    if (event.type !== "timeline.item") throw new Error("Invalid TRAE history event");
    return { type: "timeline", item: event.item };
  },
};

function toolItem(
  snapshot: AcpToolCallSnapshot,
): Extract<ProviderTimelineItem, { type: "tool_call" }> {
  const input = snapshot.input;
  const fields = typeof input === "object" && input !== null && !Array.isArray(input) ? input : {};
  const isEdit = snapshot.kind === "edit" || snapshot.name?.toLowerCase().includes("edit") === true;
  const detail = isEdit
    ? {
        type: "edit" as const,
        filePath:
          typeof fields.filePath === "string" ? fields.filePath : (snapshot.locations[0] ?? ""),
        ...(typeof fields.oldString === "string" ? { oldString: fields.oldString } : {}),
        ...(typeof fields.newString === "string" ? { newString: fields.newString } : {}),
        ...(typeof fields.unifiedDiff === "string" ? { unifiedDiff: fields.unifiedDiff } : {}),
      }
    : { type: "unknown" as const, input, output: snapshot.output };
  const base = {
    type: "tool_call" as const,
    id: snapshot.id,
    callId: snapshot.id,
    name: snapshot.name ?? snapshot.title,
    detail,
  };
  if (snapshot.status === "failed")
    return { ...base, status: "failed", error: snapshot.output ?? { message: "Tool failed" } };
  const status = snapshot.status === "completed" ? "completed" : "running";
  return { ...base, status, error: null };
}
