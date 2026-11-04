import type { AcpVendorUpdate } from "@getpaseo/plugin/server/acp";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import {
  createQueueStatusTransformer,
  formatQueueStatus,
  QUEUE_STATUS_VENDOR_METHOD,
  toQueueStatusVendorNotification,
} from "./queue-status.js";

describe("TRAE queue status", () => {
  it("extracts queue status metadata from a session info update", () => {
    expect(
      toQueueStatusVendorNotification({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "native-1",
          update: {
            sessionUpdate: "session_info_update",
            _meta: {
              trae: {
                queueStatus: {
                  state: "queued",
                  position: 7,
                  message: "模型请求正在排队",
                },
              },
            },
          },
        },
      }),
    ).toEqual({
      jsonrpc: "2.0",
      method: QUEUE_STATUS_VENDOR_METHOD,
      params: {
        sessionId: "native-1",
        queueStatus: {
          state: "queued",
          position: 7,
          message: "模型请求正在排队",
        },
      },
    });
  });

  it("ignores unrelated and malformed updates", () => {
    expect(
      toQueueStatusVendorNotification({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "native-1",
          update: { sessionUpdate: "session_info_update", title: "Agent" },
        },
      }),
    ).toBeNull();
    expect(
      toQueueStatusVendorNotification({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "native-1",
          update: {
            sessionUpdate: "session_info_update",
            _meta: { trae: { queueStatus: "not-an-object" } },
          },
        },
      }),
    ).toBeNull();
  });

  it("formats queue position and terminal states", () => {
    expect(formatQueueStatus({ state: "queued", position: 3 })).toBe("模型排队中 · 当前第 3 位");
    expect(formatQueueStatus({ state: "generating" })).toBe("排队结束 · 模型正在生成");
    expect(formatQueueStatus({ state: "completed" })).toBe("模型排队结束");
  });

  it("uses the backend message without duplicating its position", () => {
    expect(
      formatQueueStatus({
        state: "queued",
        position: 12,
        message: "Too many requests. Queue position: 12",
      }),
    ).toBe("Too many requests. Queue position: 12");
  });

  it("maps updates to one Paseo plugin timeline item per queue cycle", () => {
    const transformer = createQueueStatusTransformer();
    const transformed = transformer.notification?.(
      {
        method: QUEUE_STATUS_VENDOR_METHOD,
        params: {
          sessionId: "native-1",
          queueStatus: {
            turn_id: "turn-1",
            state: "queued",
            position: 2,
          },
        },
      },
      { sessionId: "paseo-1" },
    );

    expect(transformed).toEqual({
      type: "timeline",
      item: {
        type: "plugin",
        id: "trae-queue-status:paseo-1:1",
        pluginId: "trae-queue-status",
        kind: "trae-queue-status",
        version: 1,
        data: {
          message: "模型排队中 · 当前第 2 位",
          state: "queued",
          position: 2,
          active: true,
        },
      },
    });
  });

  it("deduplicates unchanged updates and reuses the item until the queue ends", () => {
    const transformer = createQueueStatusTransformer();
    const first = transformQueue(transformer, { state: "queued", position: 12 });
    expect(transformQueue(transformer, { state: "queued", position: 12 })).toBeNull();
    const changed = transformQueue(transformer, { state: "queued", position: 11 });
    const completed = transformQueue(transformer, { state: "generating" });
    const nextCycle = transformQueue(transformer, { state: "queued", position: 20 });

    expect(itemId(changed)).toBe(itemId(first));
    expect(itemId(completed)).toBe(itemId(first));
    expect(itemId(nextCycle)).not.toBe(itemId(first));
  });

  it("does not publish timeline items during provider probes", () => {
    expect(
      createQueueStatusTransformer().notification?.(
        {
          method: QUEUE_STATUS_VENDOR_METHOD,
          params: {
            sessionId: "native-probe",
            queueStatus: { state: "queued", position: 9 },
          },
        },
        { sessionId: "catalog" },
      ),
    ).toBeNull();
  });
});

function transformQueue(
  transformer: ReturnType<typeof createQueueStatusTransformer>,
  queueStatus: JsonValue,
) {
  return transformer.notification?.(
    {
      method: QUEUE_STATUS_VENDOR_METHOD,
      params: { sessionId: "native-1", queueStatus },
    },
    { sessionId: "paseo-1" },
  );
}

function itemId(update: ReturnType<typeof transformQueue>): string | undefined {
  if (!update || !isSingleUpdate(update) || update.type !== "timeline") return undefined;
  return update.item.id;
}

function isSingleUpdate(
  update: AcpVendorUpdate | readonly AcpVendorUpdate[],
): update is AcpVendorUpdate {
  return !Array.isArray(update);
}
