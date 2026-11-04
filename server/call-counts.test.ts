import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TraeCallCounts } from "./call-counts.js";

const nativeId = "native-session";
const turnId = "native-turn";
const startedAt = Date.parse("2026-11-03T12:13:01Z");
let root: string;
let path: string;
let calls: TraeCallCounts;

function record(type: string, payload: object = {}, turn = turnId, thread = nativeId) {
  return (
    JSON.stringify({
      schema_version: 1,
      wall_time_unix_ms: startedAt,
      thread_id: thread,
      codex_turn_id: turn,
      payload: { type, ...payload },
    }) + "\n"
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "trae-call-counts-test-"));
  const directory = join(root, `trace-fixture-${nativeId}`);
  await mkdir(directory);
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({ schema_version: 1, root_thread_id: nativeId }),
  );
  path = join(directory, "trace.jsonl");
  await writeFile(path, "");
  calls = await TraeCallCounts.create({ TRAECLI_ROLLOUT_TRACE_ROOT: root });
});

afterEach(async () => {
  await calls.dispose();
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("native trace call counts", () => {
  it("aligns 10 model requests and 28 tools including exec wrappers and hidden nested calls", async () => {
    const records = [record("codex_turn_started")];
    for (let i = 0; i < 10; i++) {
      records.push(record("inference_started", { inference_call_id: `inference-${i}` }));
      records.push(record("inference_completed", { inference_call_id: `inference-${i}` }));
    }
    for (let i = 0; i < 9; i++) {
      records.push(
        record("code_cell_started", {
          model_visible_call_id: `exec-${i}`,
          source_js: "text('tools.fake() is not an invocation');",
        }),
      );
    }
    for (let i = 0; i < 19; i++) {
      const id = `code-mode-nested:exec-${i % 9}:tool-${i}`;
      records.push(
        record("tool_call_started", {
          tool_call_id: id,
          model_visible_call_id: null,
          kind: { type: "other", name: i === 18 ? "clock" : "exec_command" },
        }),
      );
      records.push(record("tool_call_runtime_started", { tool_call_id: id }));
      records.push(
        record("tool_call_ended", { tool_call_id: id, status: i === 0 ? "failed" : "completed" }),
      );
    }
    // Replayed dispatches, resumed code cells, and alternate representations of
    // the outer call must not inflate the count.
    records.push(
      records[1],
      records[21],
      record("tool_call_started", { tool_call_id: "outer-alias", model_visible_call_id: "exec-0" }),
    );
    records.push(
      record("inference_started", { inference_call_id: "child-request" }, turnId, "child-session"),
    );
    records.push(
      record("tool_call_started", { tool_call_id: "child-tool" }, turnId, "child-session"),
    );
    records.push(record("codex_turn_ended", { status: "completed" }));
    await writeFile(path, records.join(""));
    const [first, concurrent] = await Promise.all([calls.read(nativeId), calls.read(nativeId)]);
    expect(concurrent).toEqual(first);
    expect(first?.get(turnId)).toEqual({
      startedAt,
      complete: true,
      modelCallCount: 10,
      toolCallCount: 28,
    });
    expect((await calls.read(nativeId))?.get(turnId)?.toolCallCount).toBe(28);
  });

  it("counts model calls without Thinking text, tracks failures, and isolates adjacent turns", async () => {
    await writeFile(
      path,
      record("codex_turn_started") +
        record("inference_started", { inference_call_id: "one" }) +
        record("inference_cancelled", { inference_call_id: "one" }) +
        record("codex_turn_ended", { status: "aborted" }) +
        record("codex_turn_started", {}, "next") +
        record("inference_started", { inference_call_id: "two" }, "next") +
        record("tool_call_started", { tool_call_id: "direct-tool" }, "next") +
        record("tool_call_ended", { tool_call_id: "direct-tool", status: "failed" }, "next") +
        record("codex_turn_ended", {}, "next"),
    );
    const result = await calls.read(nativeId);
    expect(result?.get(turnId)).toMatchObject({
      modelCallCount: 1,
      toolCallCount: 0,
      complete: true,
    });
    expect(result?.get("next")).toMatchObject({
      modelCallCount: 1,
      toolCallCount: 1,
      complete: true,
    });
    calls.forget(nativeId, new Set([turnId]));
    expect((await calls.read(nativeId))?.has(turnId)).toBe(false);
    expect((await calls.read(nativeId))?.get("next")?.toolCallCount).toBe(1);
  });

  it("waits for a complete final record and never calls a partially flushed turn complete", async () => {
    const last = record("codex_turn_ended");
    await writeFile(
      path,
      record("codex_turn_started") +
        record("inference_started", { inference_call_id: "one" }) +
        last.slice(0, -4),
    );
    expect((await calls.read(nativeId))?.get(turnId)?.complete).toBe(false);
    await appendFile(path, last.slice(-4));
    expect((await calls.read(nativeId))?.get(turnId)).toMatchObject({
      complete: true,
      modelCallCount: 1,
      toolCallCount: 0,
    });
  });

  it.each(["missing", "identity", "version", "malformed", "missing-call-id", "truncate"])(
    "does not invent zero counts for %s traces",
    async (failure) => {
      await writeFile(
        path,
        record("codex_turn_started") + record("inference_started", { inference_call_id: "one" }),
      );
      if (failure === "missing") await rm(path);
      if (failure === "identity" || failure === "version")
        await writeFile(
          join(path, "..", "manifest.json"),
          JSON.stringify({
            schema_version: failure === "version" ? 2 : 1,
            root_thread_id: failure === "identity" ? "other" : nativeId,
          }),
        );
      if (failure === "malformed") await appendFile(path, "not JSON\n");
      if (failure === "missing-call-id") await appendFile(path, record("tool_call_started"));
      if (failure === "truncate") {
        await calls.read(nativeId);
        await writeFile(path, "");
      }
      expect(await calls.read(nativeId)).toBeNull();
    },
  );

  it("cleans only its owned temporary traces and keeps caller-configured traces intact", async () => {
    vi.useFakeTimers();
    const owned = await TraeCallCounts.create({});
    const ownedRoot = owned.env.TRAECLI_ROLLOUT_TRACE_ROOT!;
    const payloads = join(ownedRoot, "trace-owned", "payloads");
    await mkdir(payloads, { recursive: true });
    await writeFile(join(payloads, "1.json"), "private test payload");
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(async () =>
        expect(await stat(join(payloads, "1.json")).catch(() => null)).toBeNull(),
      );
      expect(await stat(payloads)).toBeDefined();
    } finally {
      await owned.dispose();
    }
    expect(await stat(ownedRoot).catch(() => null)).toBeNull();
    await calls.dispose();
    expect(await readFile(path, "utf8")).toBe("");
  });
});
