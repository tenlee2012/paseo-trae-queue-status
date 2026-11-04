import type { AcpStreamMessage, AcpTransformer } from "@getpaseo/plugin/server/acp";
import { z } from "zod";
import { queueStatusKind, queueStatusPluginId, queueStatusSchema } from "../shared/queue-status.js";

export const QUEUE_STATUS_VENDOR_METHOD = "paseo/trae-queue-status";

const jsonObjectSchema = z.record(z.string(), z.unknown());

const queueStatusUpdateSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.literal("session/update"),
    params: z
      .object({
        sessionId: z.string(),
        update: z
          .object({
            sessionUpdate: z.literal("session_info_update"),
            _meta: z
              .object({
                trae: z
                  .object({
                    queueStatus: jsonObjectSchema,
                  })
                  .passthrough(),
              })
              .passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const queueStatusVendorParamsSchema = z.object({
  sessionId: z.string(),
  queueStatus: jsonObjectSchema,
});

export function toQueueStatusVendorNotification(
  message: AcpStreamMessage,
): AcpStreamMessage | null {
  const parsed = queueStatusUpdateSchema.safeParse(message);
  if (!parsed.success) return null;
  return {
    jsonrpc: "2.0",
    method: QUEUE_STATUS_VENDOR_METHOD,
    params: {
      sessionId: parsed.data.params.sessionId,
      queueStatus: parsed.data.params.update._meta.trae.queueStatus,
    },
  };
}

interface ActiveQueueItem {
  id: string;
  signature: string;
}

export function createQueueStatusTransformer(): AcpTransformer {
  const activeItems = new Map<string, ActiveQueueItem>();
  let sequence = 0;
  return {
    notification(notification, context) {
      if (notification.method !== QUEUE_STATUS_VENDOR_METHOD) return null;
      if (isProbeSession(context.sessionId)) return null;
      const parsed = queueStatusVendorParamsSchema.safeParse(notification.params);
      if (!parsed.success) return null;

      const data = queueStatusData(parsed.data.queueStatus);
      const signature = JSON.stringify(data);
      let activeItem = activeItems.get(context.sessionId);
      if (!activeItem) {
        sequence += 1;
        activeItem = {
          id: `${queueStatusKind}:${context.sessionId}:${sequence}`,
          signature: "",
        };
        activeItems.set(context.sessionId, activeItem);
      }
      if (activeItem.signature === signature) return null;
      activeItem.signature = signature;

      const update = {
        type: "timeline" as const,
        item: {
          type: "plugin" as const,
          id: activeItem.id,
          pluginId: queueStatusPluginId,
          kind: queueStatusKind,
          version: 1,
          data,
        },
      };
      if (!data.active) activeItems.delete(context.sessionId);
      return update;
    },
  };
}

export const queueStatusTransformer = createQueueStatusTransformer();

function isProbeSession(sessionId: string): boolean {
  return sessionId === "capability-probe" || sessionId === "catalog" || sessionId === "sessions";
}

export function formatQueueStatus(queueStatus: Record<string, unknown>): string {
  const message = readString(queueStatus, "message");
  const state = readString(queueStatus, "state") ?? readString(queueStatus, "status");
  const position = readNumber(queueStatus, "position") ?? readNumber(queueStatus, "queuePosition");

  let summary = message ?? formatQueueState(state);
  if (position !== null && !summary.includes(String(position))) {
    summary = `${summary} · 当前第 ${position} 位`;
  }
  return summary;
}

function queueStatusData(queueStatus: Record<string, unknown>) {
  const state = readString(queueStatus, "state") ?? readString(queueStatus, "status");
  return queueStatusSchema.parse({
    message: formatQueueStatus(queueStatus),
    state,
    position: readNumber(queueStatus, "position") ?? readNumber(queueStatus, "queuePosition"),
    active: !isTerminalQueueState(state),
  });
}

function isTerminalQueueState(state: string | null): boolean {
  if (!state) return false;
  return [
    "ready",
    "dequeued",
    "generating",
    "running",
    "idle",
    "completed",
    "complete",
    "finished",
    "queue_end",
    "ended",
  ].includes(normalizeQueueState(state));
}

function formatQueueState(state: string | null): string {
  if (!state) return "模型排队状态已更新";
  switch (normalizeQueueState(state)) {
    case "queued":
    case "waiting":
    case "model_queue":
    case "awaiting_model":
    case "queue_begin":
    case "request_wait_in_queue":
      return "模型排队中";
    case "ready":
    case "dequeued":
    case "generating":
    case "running":
      return "排队结束 · 模型正在生成";
    case "idle":
    case "completed":
    case "complete":
    case "finished":
    case "queue_end":
    case "ended":
      return "模型排队结束";
    default:
      return `模型队列状态：${state}`;
  }
}

function normalizeQueueState(state: string): string {
  return state.trim().toLowerCase().replaceAll("-", "_");
}

function readString(value: Record<string, unknown>, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function readNumber(value: Record<string, unknown>, key: string): number | null {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}
