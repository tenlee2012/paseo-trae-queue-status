import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ProviderEvent, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { readChildResults } from "./subagent-history.js";
import { TraeTimelineAccumulator } from "./history-replay.js";

const metaSchema = z.object({
  type: z.enum(["subagent_control", "subagent_child"]),
  parentThreadId: z.string().min(1),
  childThreadId: z.string().min(1),
  parentToolCallId: z.string().min(1),
  childTurnId: z.string().optional(),
  action: z.string().optional(),
  agentNickname: z.string().optional(),
  agentRole: z.string().optional(),
});
const paramsSchema = z.object({
  sessionId: z.string(),
  update: z.looseObject({ sessionUpdate: z.string() }),
  _meta: z.looseObject({ traex: z.unknown().optional() }).optional(),
});
type Params = z.infer<typeof paramsSchema>;
type Meta = z.infer<typeof metaSchema>;
type TurnState = Extract<ProviderEvent, { type: "session.turn" }>["state"];
interface Child {
  id: string;
  nativeId: string;
  parentId: string;
  parentNativeId: string;
  toolCallId: string;
  title: string;
  description?: string;
  background: boolean;
  timeline: TraeTimelineAccumulator;
  turnId?: string;
  active: boolean;
  sequence: number;
  closed: boolean;
  startedControls: Set<string>;
}
interface Root {
  id: string;
  nativeId: string;
  deferred: Array<{ params: Params; meta: Meta }>;
  cwd: string;
  children: Map<string, Child>;
  controls: TraeTimelineAccumulator;
}

// TRAE 0.214.1-alpha.2 sends projected child updates on the root ACP session.
// Consume their metadata BEFORE the standard ACP/history adapters discard it.
// Children belong to the parent runtime; opening them must never resume a second
// CLI writer against the native child thread.
export class TraeSubagents {
  private roots = new Map<string, Root>();
  private pending = new Map<string, Array<{ params: Params; meta: Meta }>>();
  private emit: (event: ProviderEvent) => void = () => {};

  constructor(
    private readonly enabled: boolean,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  setEmitter(emit: (event: ProviderEvent) => void): void {
    this.emit = emit;
  }

  capture(message: AcpStreamMessage): boolean {
    if (
      !this.enabled ||
      !("method" in message) ||
      "id" in message ||
      message.method !== "session/update"
    )
      return false;
    const parsed = paramsSchema.safeParse(message.params);
    if (!parsed.success) return false;
    const params = parsed.data;
    const control = metaSchema.safeParse(record(params.update._meta).traex);
    const meta =
      control.success && control.data.type === "subagent_control"
        ? control
        : metaSchema.safeParse(params._meta?.traex);
    if (
      !meta.success ||
      meta.data.childThreadId === meta.data.parentThreadId ||
      meta.data.childThreadId === params.sessionId
    )
      return false;
    const root = this.roots.get(params.sessionId);
    if (root) this.accept(root, params, meta.data);
    else {
      const queue = this.pending.get(params.sessionId) ?? [];
      queue.push({ params, meta: meta.data });
      this.pending.set(params.sessionId, queue);
    }
    return true;
  }

  bind(id: string, nativeId: string, cwd: string): void {
    if (!this.enabled || this.roots.has(nativeId)) return;
    const root: Root = {
      id,
      nativeId,
      deferred: [],
      cwd,
      children: new Map(),
      controls: new TraeTimelineAccumulator(id),
    };
    this.roots.set(nativeId, root);
    const pending = this.pending.get(nativeId) ?? [];
    this.pending.delete(nativeId);
    for (const { params, meta } of pending) this.accept(root, params, meta);
  }

  finish(id: string, state: TurnState): void {
    for (const root of this.roots.values()) {
      if (root.id !== id) continue;
      for (const child of root.children.values()) {
        if (child.parentId !== root.id) continue;
        // A finished parent prompt does not finish a background child.
        if (!child.background || state === "failed" || state === "canceled") this.end(child, state);
      }
    }
  }

  async restore(id: string): Promise<void> {
    const root = [...this.roots.values()].find((candidate) => candidate.id === id);
    if (root) {
      await Promise.all(
        [...root.children.values()].map(async (child) => {
          const results = await readChildResults(
            child.nativeId,
            child.parentNativeId,
            this.env,
          ).catch(() => []);
          if (![...this.roots.values()].includes(root)) return;
          for (const result of results) {
            if (result.text)
              this.item(child.id, {
                type: "assistant_message",
                id: `result:${result.turnId}`,
                text: result.text,
              });
          }
          this.end(child, results.at(-1)?.state ?? "canceled");
        }),
      );
    }
  }

  closeChild(id: string): boolean {
    for (const root of this.roots.values()) {
      const child = [...root.children.values()].find((candidate) => candidate.id === id);
      if (!child) continue;
      this.end(child, "canceled");
      child.closed = true;
      this.emit({ type: "session.closed", sessionId: id });
      return true;
    }
    return false;
  }

  release(id: string): void {
    for (const [nativeId, root] of this.roots) {
      if (root.id !== id) continue;
      for (const child of [...root.children.values()].toReversed()) {
        this.end(child, "canceled");
        this.emit({ type: "session.closed", sessionId: child.id });
      }
      this.roots.delete(nativeId);
      this.pending.delete(nativeId);
    }
  }

  discard(nativeId: string): void {
    this.pending.delete(nativeId);
  }

  clear(): void {
    this.roots.clear();
    this.pending.clear();
  }

  private accept(root: Root, params: Params, meta: Meta): void {
    if (meta.parentThreadId !== root.nativeId && !root.children.has(meta.parentThreadId)) {
      root.deferred.push({ params, meta });
      return;
    }
    const input = record(params.update.rawInput);
    const output = record(params.update.rawOutput);
    let child = root.children.get(meta.childThreadId);
    if (!child) {
      const parentId = root.children.get(meta.parentThreadId)?.id ?? root.id;
      const id = JSON.stringify([root.id, "trae-subagent", meta.childThreadId]);
      child = {
        id,
        nativeId: meta.childThreadId,
        parentId,
        parentNativeId: meta.parentThreadId,
        toolCallId: meta.parentToolCallId,
        title: meta.agentNickname ?? meta.agentRole ?? "TRAE subagent",
        description: string(input.prompt),
        background: input.runInBackground === true,
        timeline: new TraeTimelineAccumulator(id),
        active: false,
        sequence: 0,
        closed: false,
        startedControls: new Set(),
      };
      root.children.set(meta.childThreadId, child);
      this.emit({
        type: "session.opened",
        sessionId: id,
        parentSessionId: parentId,
        toolCallId: child.toolCallId,
        capabilities: [],
        restoration: "parent",
        cwd: root.cwd,
        title: child.title,
        ...(child.description ? { description: child.description } : {}),
      });
      if (child.description)
        this.item(id, { type: "user_message", id: "task", text: child.description });
      this.emit({ type: "session.ready", sessionId: id });
      const deferred = root.deferred;
      root.deferred = [];
      for (const entry of deferred) this.accept(root, entry.params, entry.meta);
    }
    if (child.closed) return;
    if (typeof input.runInBackground === "boolean") child.background = input.runInBackground;
    if (meta.type === "subagent_child") {
      if (output.type === "subagent_completion") {
        this.end(child, terminalState(output.status) ?? "failed");
        return;
      }
      this.start(child, meta.childTurnId);
      for (const item of child.timeline.accept(params.update)) this.item(child.id, item);
      return;
    }

    // The spawn tool completes as soon as the child is accepted. Its completed
    // status says nothing about whether the child has finished its work.
    if (
      meta.action === "spawn_agent" ||
      meta.action === "resume_agent" ||
      meta.action === "send_input"
    ) {
      const key = String(params.update.toolCallId);
      if (!child.startedControls.has(key)) {
        child.startedControls.add(key);
        this.start(child);
      }
    }
    const controls = root.children.get(meta.parentThreadId)?.timeline ?? root.controls;
    for (const item of controls.accept(params.update)) {
      if (item.type !== "tool_call") continue;
      this.item(child.parentId, {
        ...item,
        detail: {
          type: "sub_agent",
          childSessionId: child.id,
          ...(meta.agentRole ? { subAgentType: meta.agentRole } : {}),
          description: child.description ?? child.title,
          log: contentText(params.update.content),
        },
      });
    }
    for (const [nativeId, value] of Object.entries(record(input.agentsStates))) {
      const target = root.children.get(nativeId);
      if (!target) continue;
      const state = record(value);
      const terminal = terminalState(state.status);
      if (terminal) {
        const text = string(state.message);
        if (text)
          this.item(target.id, {
            type: "assistant_message",
            id: `result:${params.update.toolCallId}`,
            text,
          });
        this.end(target, terminal);
      }
    }
  }

  private start(child: Child, nativeTurnId?: string): void {
    if (child.active) return;
    child.turnId = nativeTurnId ?? `subagent:${child.nativeId}:${++child.sequence}`;
    child.active = true;
    this.emit({
      type: "session.turn",
      sessionId: child.id,
      turnId: child.turnId,
      state: "started",
    });
  }

  private end(child: Child, state: TurnState): void {
    if (!child.active || !child.turnId || state === "started") return;
    child.active = false;
    this.emit({ type: "session.turn", sessionId: child.id, turnId: child.turnId, state });
    for (const root of this.roots.values()) {
      for (const descendant of root.children.values()) {
        if (descendant.parentId === child.id && (!descendant.background || state !== "completed"))
          this.end(descendant, state);
      }
    }
  }

  private item(sessionId: string, item: ProviderTimelineItem): void {
    this.emit({ type: "timeline.item", sessionId, item });
  }
}

function terminalState(status: unknown): TurnState | undefined {
  if (status === "completed") return "completed";
  if (
    status === "errored" ||
    status === "failed" ||
    status === "notFound" ||
    status === "not_found"
  )
    return "failed";
  if (
    status === "interrupted" ||
    status === "shutdown" ||
    status === "canceled" ||
    status === "cancelled"
  )
    return "canceled";
  return undefined;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function contentText(value: unknown): string {
  return Array.isArray(value)
    ? value
        .map((part) => string(record(record(part).content).text) ?? "")
        .filter(Boolean)
        .join("\n")
    : "";
}
