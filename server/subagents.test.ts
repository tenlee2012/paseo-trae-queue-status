import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { ProviderEventSchema, type ProviderEvent } from "@getpaseo/plugin/server/provider";
import captured from "./fixtures/trae-subagents-0.214.1.json";
import { TraeSubagents } from "./subagents.js";
import { readChildResults } from "./subagent-history.js";

function fixture(enabled = true) {
  const events: ProviderEvent[] = [];
  const bridge = new TraeSubagents(enabled);
  bridge.setEmitter((event) => events.push(ProviderEventSchema.parse(event)));
  bridge.bind("parent", "native-1", "/fixture");
  return { bridge, events };
}
function frame(index: number, replacements: Record<string, string> = {}): AcpStreamMessage {
  let text = JSON.stringify(captured[index]);
  for (const [a, b] of Object.entries(replacements)) text = text.replaceAll(a, b);
  return JSON.parse(text);
}

describe("TRAE native subagents", () => {
  it("projects captured live child messages and completion into native Paseo sessions", () => {
    const { bridge, events } = fixture();
    for (let i = 0; i < captured.length; i++) expect(bridge.capture(frame(i))).toBe(true);
    const opened = events.find((event) => event.type === "session.opened")!;
    expect(opened).toMatchObject({
      parentSessionId: "parent",
      toolCallId: "spawn-fixture",
      title: "Review fixture",
      restoration: "parent",
      capabilities: [],
    });
    if (opened.type !== "session.opened") throw new Error("Missing child");
    expect(events.filter((event) => event.type === "session.opened")).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        sessionId: opened.sessionId,
        item: expect.objectContaining({ type: "assistant_message", text: "fixture done" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        sessionId: "parent",
        item: expect.objectContaining({
          detail: expect.objectContaining({ type: "sub_agent", childSessionId: opened.sessionId }),
        }),
      }),
    );
    expect(
      events.filter((event) => event.type === "session.turn").map((event) => event.state),
    ).toEqual(["started", "completed"]);
    expect(
      events
        .filter((event) => event.type === "timeline.item" && event.sessionId === "parent")
        .every((event) => event.type === "timeline.item" && event.item.type === "tool_call"),
    ).toBe(true);
  });

  it("does not complete background work when the spawn tool or parent prompt completes", () => {
    const { bridge, events } = fixture();
    bridge.capture(frame(0));
    bridge.capture(frame(1));
    bridge.finish("parent", "completed");
    expect(
      events.filter((event) => event.type === "session.turn").map((event) => event.state),
    ).toEqual(["started"]);
    bridge.capture(frame(2));
    bridge.capture(frame(3));
    expect(events.at(-1)).toMatchObject({ type: "session.turn", state: "completed" });
  });

  it("completes foreground children at the end of their parent turn", () => {
    const { bridge, events } = fixture();
    bridge.capture(frame(0, { '"runInBackground":true': '"runInBackground":false' }));
    bridge.finish("parent", "completed");
    expect(events.at(-1)).toMatchObject({ type: "session.turn", state: "completed" });
  });

  it("buffers history until the parent is bound and isolates simultaneous roots", () => {
    const events: ProviderEvent[] = [];
    const bridge = new TraeSubagents(true);
    bridge.setEmitter((event) => events.push(event));
    bridge.capture(frame(0));
    expect(events).toHaveLength(0);
    bridge.bind("one", "native-1", "/one");
    bridge.bind("two", "native-2", "/two");
    bridge.capture(frame(0, { "native-1": "native-2" }));
    const children = events.filter((event) => event.type === "session.opened");
    expect(children.map((child) => child.parentSessionId)).toEqual(["one", "two"]);
    expect(new Set(children.map((child) => child.sessionId)).size).toBe(2);
  });

  it("keeps nested children under their direct parent", () => {
    const { bridge, events } = fixture();
    bridge.capture(frame(0));
    const nested = frame(0, {
      '"child-1"': '"grandchild"',
      '"parentThreadId":"native-1"': '"parentThreadId":"child-1"',
      "spawn-fixture": "nested-spawn",
    });
    bridge.capture(nested);
    const children = events.filter((event) => event.type === "session.opened");
    expect(children[1].parentSessionId).toBe(children[0].sessionId);
  });

  it("recognizes nested control metadata inside a projected child and preserves background ancestry", () => {
    const { bridge, events } = fixture();
    const nested = JSON.parse(
      JSON.stringify(
        frame(0, {
          '"child-1"': '"grandchild"',
          '"parentThreadId":"native-1"': '"parentThreadId":"child-1"',
          "spawn-fixture": "nested-spawn",
          '"runInBackground":true': '"runInBackground":false',
        }),
      ),
    );
    nested.params._meta = captured[2].params._meta;
    bridge.capture(nested); // Out-of-order children wait for the direct parent.
    expect(events).toHaveLength(0);
    bridge.capture(frame(0));
    bridge.finish("parent", "completed");
    const children = events.filter((event) => event.type === "session.opened");
    expect(children).toHaveLength(2);
    expect(children[1].parentSessionId).toBe(children[0].sessionId);
    expect(
      events
        .filter((event) => event.type === "session.turn")
        .every((event) => event.state === "started"),
    ).toBe(true);
    bridge.capture(frame(3));
    expect(
      events.filter((event) => event.type === "session.turn" && event.state === "completed"),
    ).toHaveLength(2);
  });

  it.each(["failed", "canceled"] as const)(
    "settles and releases children when the parent is %s",
    (state) => {
      const { bridge, events } = fixture();
      bridge.capture(frame(0));
      bridge.finish("parent", state);
      bridge.release("parent");
      expect(
        events.filter((event) => event.type === "session.turn").map((event) => event.state),
      ).toEqual(["started", state]);
      expect(events.at(-1)?.type).toBe("session.closed");
    },
  );

  it("leaves unrelated or malformed metadata and non-negotiated hosts unchanged", () => {
    expect(fixture(false).bridge.capture(frame(0))).toBe(false);
    const { bridge, events } = fixture();
    expect(
      bridge.capture({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "native-1", update: { sessionUpdate: "agent_message_chunk" } },
      }),
    ).toBe(false);
    expect(bridge.capture(frame(0, { '"childThreadId":"child-1"': '"childThreadId":42' }))).toBe(
      false,
    );
    expect(events).toHaveLength(0);
  });

  it("restores child results from only the explicitly linked temporary rollout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trae-child-history-"));
    const env = { TRAECLI_HOME: directory };
    const path = join(directory, "sessions", "child-1.jsonl");
    const rows = [
      {
        type: "session_meta",
        payload: {
          id: "child-1",
          source: { subagent: { thread_spawn: { parent_thread_id: "native-1" } } },
        },
      },
      { type: "event_msg", payload: { type: "task_started", turn_id: "t" } },
      {
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "t", last_agent_message: "Saved child result" },
      },
    ];
    try {
      await mkdir(join(directory, "sessions"));
      await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      expect(await readChildResults("child-1", "other-parent", env)).toEqual([]);
      const events: ProviderEvent[] = [];
      const bridge = new TraeSubagents(true, env);
      bridge.setEmitter((event) => events.push(ProviderEventSchema.parse(event)));
      bridge.capture(frame(1));
      bridge.bind("parent", "native-1", "/fixture");
      await bridge.restore("parent");
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "timeline.item",
          item: expect.objectContaining({ text: "Saved child result" }),
        }),
      );
      expect(events.at(-1)).toMatchObject({ type: "session.turn", state: "completed" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
