import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { turnUsageKind, turnUsageSchema } from "../shared/turn-usage.js";
import { TraeTurnUsage } from "./turn-usage.js";
import type { TurnCallCounts } from "./call-counts.js";
import { testPrices, testPricing } from "./fixtures/model-prices.js";

const nativeId = "00000000-0000-4000-8000-000000000001";
let root: string;
let path: string;
let now: number;
let usage: TraeTurnUsage;
let events: ProviderEvent[];
let callSnapshots: Map<string, TurnCallCounts>;

const record = (type: string, payload: unknown, time = now) =>
  JSON.stringify({ timestamp: new Date(time).toISOString(), type, payload }) + "\n";
const counts = (input: number, output: number, cached: number | null = input / 2) => ({
  input_tokens: input,
  output_tokens: output,
  ...(cached === null ? {} : { cached_input_tokens: cached }),
  reasoning_output_tokens: output,
  total_tokens: input + output,
});
const context = (turnId: string, time = now) =>
  record("turn_context", { turn_id: turnId, model: "test-model" }, time);
function request(
  turnId: string,
  input = 100,
  output = 10,
  options: {
    time?: number;
    response?: string;
    thread?: string;
    cached?: number | null;
    details?: { cache_creation_input_tokens?: number; reasoning_output_tokens?: number };
  } = {},
) {
  return record(
    "token_usage_record",
    {
      thread_id: options.thread ?? nativeId,
      turn_id: turnId,
      response_id: options.response ?? "response-1",
      usage: { ...counts(input, output, options.cached), ...options.details },
      thread_token_usage: counts(1000 + input, 100 + output),
    },
    options.time,
  );
}

beforeEach(async () => {
  vi.useFakeTimers();
  root = await mkdtemp(join(tmpdir(), "trae-turn-usage-"));
  await mkdir(join(root, "sessions", "2026", "11", "03"), { recursive: true });
  path = join(root, "sessions", "2026", "11", "03", `rollout-test-${nativeId}.jsonl`);
  now = Date.parse("2026-11-03T12:00:00Z");
  await writeFile(path, record("session_meta", { id: nativeId }, now - 10000));
  events = [];
  callSnapshots = new Map();
  usage = new TraeTurnUsage((event) => events.push(event), {
    env: { TRAECLI_HOME: root },
    now: () => now,
    retryMs: 100,
    timeoutMs: 1000,
    callCounts: { read: async () => callSnapshots },
  });
  usage.bind("paseo", nativeId);
});
afterEach(async () => {
  usage.dispose();
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

async function start(id = "paseo-turn-1") {
  await usage.prepare("paseo");
  usage.observe({ type: "session.turn", sessionId: "paseo", turnId: id, state: "started" });
}
async function end(id = "paseo-turn-1", state: "completed" | "failed" | "canceled" = "completed") {
  now += 50;
  usage.observe({ type: "session.turn", sessionId: "paseo", turnId: id, state });
  await usage.prepare("paseo");
}
function rows(id = "paseo-turn-1", sessionId = "paseo") {
  return events
    .filter(
      (event) =>
        event.type === "timeline.item" &&
        event.sessionId === sessionId &&
        event.item.type === "plugin" &&
        event.item.kind === turnUsageKind &&
        event.item.id === `${turnUsageKind}:${id}`,
    )
    .map((event) => {
      if (event.type !== "timeline.item" || event.item.type !== "plugin") throw new Error();
      return turnUsageSchema.parse(event.item.data);
    });
}

function thought(id: string, text = "Thinking", sessionId = "paseo") {
  usage.observe({ type: "timeline.item", sessionId, item: { type: "reasoning", id, text } });
}
function tool(
  callId: string,
  status: "running" | "completed" | "failed" | "canceled" = "running",
  sessionId = "paseo",
  id = callId,
) {
  const base = {
    type: "tool_call" as const,
    id,
    callId,
    name: "Read",
    detail: { type: "unknown" as const, input: null, output: null },
  };
  usage.observe({
    type: "timeline.item",
    sessionId,
    item:
      status === "failed"
        ? { ...base, status, error: "test failure" }
        : { ...base, status, error: null },
  });
}

describe("per-turn usage", () => {
  it("includes delayed usage records while a cold price fetch crosses the retry deadline", async () => {
    usage.dispose();
    let resolvePrices!: (prices: typeof testPrices) => void;
    const pricing = {
      getCatalog: vi.fn(
        () =>
          new Promise<typeof testPrices>((resolve) => {
            resolvePrices = resolve;
          }),
      ),
    };
    usage = new TraeTurnUsage((event) => events.push(event), {
      env: { TRAECLI_HOME: root },
      now: () => now,
      timeoutMs: 1000,
      pricing,
    });
    usage.bind("paseo", nativeId);
    await start();
    expect(pricing.getCatalog).not.toHaveBeenCalled();
    const delayed =
      context("native") +
      request("native", 100_000, 10_000, { details: { cache_creation_input_tokens: 20_000 } });
    now += 50;
    usage.observe({
      type: "session.turn",
      sessionId: "paseo",
      turnId: "paseo-turn-1",
      state: "completed",
    });
    await appendFile(path, delayed);
    now += 2000;
    resolvePrices(testPrices);
    await usage.prepare("paseo");
    expect(rows().at(-1)).toMatchObject({
      state: "ready",
      inputTokens: 100_000,
      outputTokens: 10_000,
    });
    expect(rows().at(-1)!.cost).toBeCloseTo(0.33);
  });
  it("prices every model request before accumulating turn totals and preserves unknown costs", async () => {
    usage.dispose();
    usage = new TraeTurnUsage((event) => events.push(event), {
      env: { TRAECLI_HOME: root },
      now: () => now,
      pricing: testPricing,
    });
    usage.bind("paseo", nativeId);
    await start();
    await appendFile(
      path,
      record("turn_context", { turn_id: "native", model: "Fixture-Model-A__max" }) +
        request("native", 200_000, 10_000, { details: { cache_creation_input_tokens: 0 } }) +
        request("native", 200_000, 10_000, {
          response: "two",
          details: { cache_creation_input_tokens: 0 },
        }) +
        context("native") +
        request("native", 100_000, 10_000, {
          response: "three",
          details: { cache_creation_input_tokens: 20_000 },
        }),
    );
    await end();
    expect(rows().at(-1)).toMatchObject({
      state: "ready",
      inputTokens: 500_000,
      outputTokens: 30_000,
    });
    expect(rows().at(-1)!.cost).toBeCloseTo(0.95);
    await appendFile(
      path,
      record("turn_context", { turn_id: "native", model: "unpriced" }) +
        request("native", 100, 10, { response: "four" }),
    );
    await usage.prepare("paseo");
    expect(rows().at(-1)).toMatchObject({ inputTokens: 500_100, cost: null });
  });
  it("sums all requests once, includes cached input, and does not add reasoning twice", async () => {
    const old = request("old-native-turn", 500, 50, { time: now - 1000 });
    await appendFile(path, context("old-native-turn", now - 2000) + old);
    await start();
    const first = request("native-turn-1", 1000, 100);
    await appendFile(
      path,
      context("native-turn-1") +
        first +
        first +
        request("native-turn-1", 200, 20, { response: "response-2" }) +
        request("child-turn", 9999, 9999, { thread: "child-thread" }) +
        record("event_msg", {
          type: "token_count",
          info: { total_token_usage: counts(2200, 220) },
        }),
    );
    await end();
    expect(rows().at(-1)).toEqual({
      state: "ready",
      outcome: "completed",
      cost: null,
      source: { sessionId: nativeId, turnIds: ["native-turn-1"] },
      inputTokens: 1200,
      outputTokens: 120,
      cachedInputTokens: 600,
      cacheCreationInputTokens: null,
      reasoningOutputTokens: 120,
      modelCallCount: null,
      toolCallCount: null,
    });
    const length = rows().length;
    await usage.prepare("paseo");
    expect(rows()).toHaveLength(length);
    expect(await readFile(path, "utf8")).toContain(old);
  });

  it("sums per-turn cache creation and reasoning without adding either to the total", async () => {
    await start();
    const first = request("native-turn-1", 100, 10, {
      details: { cache_creation_input_tokens: 0, reasoning_output_tokens: 1 },
    });
    await appendFile(
      path,
      context("native-turn-1") +
        first +
        first +
        request("native-turn-1", 200, 20, {
          response: "second",
          details: { cache_creation_input_tokens: 10, reasoning_output_tokens: 2 },
        }),
    );
    await end();
    expect(rows().at(-1)).toMatchObject({
      inputTokens: 300,
      outputTokens: 30,
      cachedInputTokens: 150,
      cacheCreationInputTokens: 10,
      reasoningOutputTokens: 3,
    });
  });

  it.each(["cache_creation_input_tokens", "reasoning_output_tokens"] as const)(
    "does not turn partially missing %s into a zero or a partial total",
    async (field) => {
      await start();
      const details: { cache_creation_input_tokens?: number; reasoning_output_tokens?: number } = {
        cache_creation_input_tokens: 10,
        reasoning_output_tokens: 2,
      };
      delete details[field];
      await appendFile(
        path,
        context("native-turn-1") +
          request("native-turn-1", 100, 10, {
            details: { cache_creation_input_tokens: 0, reasoning_output_tokens: 1 },
          }) +
          request("native-turn-1", 200, 20, {
            response: "second",
            details: {
              ...details,
              ...(field === "reasoning_output_tokens"
                ? { reasoning_output_tokens: undefined }
                : {}),
            },
          }),
      );
      await end();
      expect(rows().at(-1)).toMatchObject({
        inputTokens: 300,
        outputTokens: 30,
        cacheCreationInputTokens: field === "cache_creation_input_tokens" ? null : 10,
        reasoningOutputTokens: field === "reasoning_output_tokens" ? null : 3,
      });
    },
  );

  it("does not mistake visible thoughts and ACP tools for complete trace call counts", async () => {
    await start();
    thought("thought-one", " ");
    thought("thought-one", "First chunk");
    thought("thought-one", "First chunk and continuation");
    thought("thought-two", "First chunk");
    tool("call-one");
    tool("call-one", "completed");
    tool("call-one", "completed", "paseo", "alternate-render-id");
    tool("call-two", "failed");
    tool("call-three", "canceled");
    thought("child-thought", "Child", "other-session");
    tool("child-call", "running", "other-session");
    await appendFile(path, context("native-turn-1") + request("native-turn-1"));
    await end();
    expect(rows().at(-1)).toMatchObject({
      state: "ready",
      modelCallCount: null,
      toolCallCount: null,
    });
    const published = rows().length;
    await usage.prepare("paseo");
    expect(rows()).toHaveLength(published);
    expect(JSON.stringify(rows())).not.toContain("First chunk");
  });

  it("ignores restored history, keeps adjacent turns separate, and ignores late prior updates", async () => {
    thought("restored");
    tool("restored");
    await start();
    callSnapshots.set("native-turn-1", {
      startedAt: now,
      complete: true,
      modelCallCount: 3,
      toolCallCount: 5,
    });
    thought("one");
    tool("one");
    await end();
    thought("idle-thought");
    tool("idle-call");
    await start("paseo-turn-2");
    callSnapshots.set("native-turn-2", {
      startedAt: now,
      complete: true,
      modelCallCount: 2,
      toolCallCount: 4,
    });
    thought("one", "late update");
    tool("one", "completed");
    thought("two");
    tool("two");
    await end("paseo-turn-2");
    expect(rows().at(-1)).toMatchObject({ modelCallCount: 3, toolCallCount: 5 });
    expect(rows("paseo-turn-2").at(-1)).toMatchObject({ modelCallCount: 2, toolCallCount: 4 });
  });

  it("preserves authoritative call counts when token records are missing or unreadable", async () => {
    await start();
    callSnapshots.set("native-turn-1", {
      startedAt: now,
      complete: true,
      modelCallCount: 2,
      toolCallCount: 1,
    });
    thought("one");
    tool("one");
    await appendFile(path, record("token_usage_record", { usage: { input_tokens: -1 } }));
    await end();
    now += 1001;
    await usage.prepare("paseo");
    expect(rows().at(-1)).toMatchObject({
      state: "unavailable",
      inputTokens: null,
      modelCallCount: 2,
      toolCallCount: 1,
    });
  });

  it("publishes 10 model and 28 tool calls after the final native trace flush, not 4 thoughts and 18 visible tools", async () => {
    await start();
    const calls = { startedAt: now, complete: false, modelCallCount: 10, toolCallCount: 28 };
    callSnapshots.set("native-turn-1", calls);
    for (let i = 0; i < 4; i++) thought(`thought-${i}`);
    for (let i = 0; i < 18; i++) tool(`tool-${i}`);
    await appendFile(path, context("native-turn-1") + request("native-turn-1", 696898, 9221));
    await end();
    expect(rows().at(-1)).toMatchObject({
      state: "ready",
      modelCallCount: null,
      toolCallCount: null,
    });
    calls.complete = true;
    await usage.prepare("paseo");
    expect(rows().at(-1)).toMatchObject({
      inputTokens: 696898,
      outputTokens: 9221,
      modelCallCount: 10,
      toolCallCount: 28,
    });
    expect(
      new Set(
        events
          .filter((event) => event.type === "timeline.item" && event.item.type === "plugin")
          .map((event) => (event.type === "timeline.item" ? event.item.id : "")),
      ).size,
    ).toBe(1);
  });

  it("keeps delayed records on their original native turn when another turn has started", async () => {
    await start();
    const firstStarted = now;
    await appendFile(path, context("native-turn-1"));
    await end();
    expect(rows().at(-1)?.state).toBe("pending");
    now += 100;
    await start("paseo-turn-2");
    await appendFile(
      path,
      context("native-turn-2") +
        request("native-turn-2", 200, 20) +
        request("native-turn-1", 100, 10, { time: firstStarted }),
    );
    await end("paseo-turn-2");
    expect(rows().at(-1)).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    expect(rows("paseo-turn-2").at(-1)).toMatchObject({ inputTokens: 200, outputTokens: 20 });
  });

  it("handles a fully delayed rollout without confusing native and Paseo IDs", async () => {
    await rm(path);
    await start();
    const firstStarted = now;
    await end();
    now += 100;
    await start("paseo-turn-2");
    const secondStarted = now;
    await end("paseo-turn-2");
    await writeFile(
      path,
      record("session_meta", { id: nativeId }) +
        context("native-turn-1", firstStarted) +
        request("native-turn-1", 100, 10, { time: firstStarted }) +
        context("native-turn-2", secondStarted) +
        request("native-turn-2", 200, 20, { time: secondStarted }),
    );
    await usage.prepare("paseo");
    expect(rows().at(-1)?.inputTokens).toBe(100);
    expect(rows("paseo-turn-2").at(-1)?.inputTokens).toBe(200);
  });

  it("does not count the next turn twice when it starts in the same millisecond as completion", async () => {
    await start();
    const firstStarted = now;
    await end();
    await start("paseo-turn-2");
    const secondStarted = now;
    await appendFile(
      path,
      context("native-turn-1", firstStarted) +
        request("native-turn-1", 100, 10, { time: firstStarted }) +
        context("native-turn-2", secondStarted) +
        request("native-turn-2", 200, 20, { time: secondStarted }),
    );
    await end("paseo-turn-2");
    expect(rows().at(-1)?.inputTokens).toBe(100);
    expect(rows("paseo-turn-2").at(-1)?.inputTokens).toBe(200);
  });

  it("takes deltas from legacy cumulative counters and excludes the restored-session baseline", async () => {
    const tokenCount = (input: number, output: number, time = now) =>
      record(
        "event_msg",
        { type: "token_count", info: { total_token_usage: counts(input, output) } },
        time,
      );
    await appendFile(path, tokenCount(1000, 100, now - 1000));
    await start();
    await appendFile(
      path,
      context("native-turn-1") + tokenCount(1200, 120) + tokenCount(1200, 120),
    );
    await end();
    expect(rows().at(-1)).toMatchObject({
      inputTokens: 200,
      outputTokens: 20,
      cachedInputTokens: 100,
    });
  });

  it("waits for a complete JSONL line and updates the same row after a delayed flush", async () => {
    await start();
    const line = request("native-turn-1");
    await appendFile(path, context("native-turn-1") + line.slice(0, -8));
    await end();
    expect(rows().at(-1)?.state).toBe("pending");
    await appendFile(path, line.slice(-8));
    await usage.prepare("paseo");
    expect(rows().map((row) => row.state)).toEqual(["pending", "ready"]);
  });

  it("continues updating partial totals while the last request flushes", async () => {
    await start();
    await appendFile(path, context("native-turn-1") + request("native-turn-1"));
    await end();
    await appendFile(path, request("native-turn-1", 200, 20, { response: "last", cached: null }));
    await usage.prepare("paseo");
    expect(rows().at(-1)).toMatchObject({
      inputTokens: 300,
      outputTokens: 30,
      cachedInputTokens: null,
    });
  });

  it("automatically reads delayed usage without another prompt or manual refresh", async () => {
    await start();
    await appendFile(path, context("native-turn-1"));
    await end();
    await appendFile(path, request("native-turn-1"));
    await vi.waitFor(() => expect(rows().at(-1)?.state).toBe("ready"));
    expect(rows().at(-1)?.inputTokens).toBe(100);
  });

  it.each(["failed", "canceled"] as const)(
    "shows consumed tokens after a %s turn",
    async (outcome) => {
      await start();
      callSnapshots.set("native-turn-1", {
        startedAt: now,
        complete: true,
        modelCallCount: 1,
        toolCallCount: 1,
      });
      thought("thought");
      tool("tool");
      await appendFile(
        path,
        record("event_msg", { type: "task_started", turn_id: "native-turn-1" }) +
          request("native-turn-1"),
      );
      await end("paseo-turn-1", outcome);
      expect(rows().at(-1)).toMatchObject({
        state: "ready",
        outcome,
        inputTokens: 100,
        modelCallCount: 1,
        toolCallCount: 1,
      });
    },
  );

  it("does not present missing records as zero and stops retrying after the deadline", async () => {
    await start();
    await end();
    now += 1001;
    await usage.prepare("paseo");
    expect(rows().at(-1)).toMatchObject({ state: "unavailable", inputTokens: null });
    await vi.advanceTimersByTimeAsync(100);
    await usage.prepare("paseo");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["identity", "malformed", "truncate", "rewrite"])(
    "fails closed for %s errors",
    async (error) => {
      if (error === "identity")
        await writeFile(path, record("session_meta", { id: "another-session" }));
      await start();
      if (error === "malformed")
        await appendFile(path, record("token_usage_record", { usage: { input_tokens: -1 } }));
      if (error === "truncate") await writeFile(path, "");
      if (error === "rewrite") {
        const contents = await readFile(path, "utf8");
        await writeFile(path, contents.replace(nativeId, "00000000-0000-4000-8000-000000000002"));
      }
      await end();
      now += 1001;
      await usage.prepare("paseo");
      expect(rows().at(-1)).toMatchObject({ state: "unavailable", inputTokens: null });
      expect(JSON.stringify(events)).not.toContain(path);
    },
  );

  it("follows an archived file and skips unrelated sessions and artifact directories", async () => {
    await mkdir(join(root, "sessions", "secret.artifacts"));
    await writeFile(join(root, "sessions", "other.jsonl"), "not JSON\n");
    await writeFile(join(root, "sessions", "secret.artifacts", `-${nativeId}.jsonl`), "not JSON\n");
    await start();
    await appendFile(path, context("native-turn-1") + request("native-turn-1"));
    await mkdir(join(root, "archived_sessions"));
    await rename(path, join(root, "archived_sessions", `-${nativeId}.jsonl`));
    await end();
    expect(rows().at(-1)?.state).toBe("ready");
  });

  it("isolates simultaneous sessions and cancels pending work when the provider closes", async () => {
    const otherId = "00000000-0000-4000-8000-000000000002";
    await writeFile(
      join(root, "sessions", `${otherId}.jsonl`),
      record("session_meta", { id: otherId }),
    );
    usage.bind("other", otherId);
    await usage.prepare("other");
    usage.observe({
      type: "session.turn",
      sessionId: "other",
      turnId: "other-turn",
      state: "started",
    });
    await start();
    await appendFile(path, context("native-turn-1") + request("native-turn-1"));
    await end();
    usage.observe({
      type: "session.turn",
      sessionId: "other",
      turnId: "other-turn",
      state: "completed",
    });
    await usage.prepare("other");
    expect(rows().at(-1)?.inputTokens).toBe(100);
    expect(rows("other-turn", "other").at(-1)?.inputTokens).toBeNull();
    usage.dispose();
    const count = events.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(events).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });
});
