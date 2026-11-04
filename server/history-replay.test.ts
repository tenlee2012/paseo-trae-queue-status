import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { ProviderEventSchema } from "@getpaseo/plugin/server/provider";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TraeHistoryReplayBridge } from "./history-replay.js";

function replay(updates: unknown[]) {
  const bridge = new TraeHistoryReplayBridge();
  bridge.outgoing({ jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: "s" } });
  for (const update of updates)
    bridge.incoming({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s", update },
    });
  return bridge.incoming({ jsonrpc: "2.0", id: 1, result: {} }).flatMap((message) => {
    if (!("method" in message)) return [];
    // Match the SDK's in-process boundary; serializing first would hide undefined fields.
    const { item } = z.object({ item: z.json() }).parse(message.params);
    const event = ProviderEventSchema.parse({ type: "timeline.item", sessionId: "s", item });
    return event.type === "timeline.item" ? [event.item] : [];
  });
}

function chunk(sessionUpdate: string, text: string, messageId?: string) {
  return { sessionUpdate, content: { type: "text", text }, ...(messageId ? { messageId } : {}) };
}

describe("TRAE history replay", () => {
  it("separates user, reasoning and reply sharing an ID while accumulating each kind", () => {
    const rows = replay([
      chunk("user_message_chunk", "QUESTION", "shared"),
      chunk("agent_thought_chunk", "THOUGHT", "shared"),
      chunk("agent_message_chunk", "ANSWER", "shared"),
      chunk("agent_thought_chunk", " MORE", "shared"),
      chunk("agent_message_chunk", " MORE", "shared"),
    ]);
    expect(rows).toEqual([
      {
        type: "user_message",
        id: '["user_message_chunk","shared"]',
        messageId: "shared",
        text: "QUESTION",
      },
      { type: "reasoning", id: '["agent_thought_chunk","shared"]', text: "THOUGHT MORE" },
      {
        type: "assistant_message",
        id: '["agent_message_chunk","shared"]',
        messageId: "shared",
        text: "ANSWER MORE",
      },
    ]);
  });

  it("keeps anonymous boundaries and explicit IDs distinct from generated IDs", () => {
    const rows = replay([
      chunk("agent_message_chunk", "first"),
      chunk("agent_message_chunk", " chunk"),
      chunk("agent_message_chunk", "explicit", "trae-history:s:1"),
      chunk("agent_message_chunk", "second"),
      chunk("agent_thought_chunk", "thinking"),
      chunk("agent_message_chunk", "third"),
    ]);
    expect(rows.map((row) => "text" in row && row.text)).toEqual([
      "first chunk",
      "explicit",
      "second",
      "thinking",
      "third",
    ]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(5);
  });

  it.each([{}, { oldString: "" }, { newString: "new" }, { unifiedDiff: "@@ diff" }])(
    "replays edit tools with partial input %j as valid JSON",
    (fields) => {
      expect(
        replay([
          {
            sessionUpdate: "tool_call",
            toolCallId: "edit",
            kind: "edit",
            rawInput: fields,
            locations: [{ path: "a.ts" }],
          },
          { sessionUpdate: "tool_call_update", toolCallId: "edit", status: "completed" },
        ]),
      ).toEqual([
        {
          type: "tool_call",
          id: "edit",
          callId: "edit",
          name: "Tool call",
          status: "completed",
          error: null,
          detail: { type: "edit", filePath: "a.ts", ...fields },
        },
      ]);
    },
  );

  it("drops buffered history when loading fails", () => {
    const bridge = new TraeHistoryReplayBridge();
    bridge.outgoing({ jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: "s" } });
    bridge.incoming({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s", update: chunk("agent_message_chunk", "discard") },
    });
    const failure: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "Failed" },
    };
    expect(bridge.incoming(failure)).toEqual([failure]);
  });
});
