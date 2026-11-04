import type { PaseoApi } from "@getpaseo/client";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySessionUsage } from "../shared/session-usage.js";
import { SessionUsageFile } from "./session-usage-file.js";
import { TraeSessionUsage } from "./session-usage.js";
import { testPrices, testPricing } from "./fixtures/model-prices.js";
import { emptyPriceCatalog } from "./model-pricing.js";
import type { TurnUsageData } from "../shared/turn-usage.js";

const id = "00000000-0000-4000-8000-000000000001";
const at = (type: string, payload: unknown, timestamp = "2025-01-01T00:00:00Z") =>
  JSON.stringify({ timestamp, type, payload }) + "\n";
const meta = (sessionId = id) => at("session_meta", { id: sessionId });
const counts = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  cached_input_tokens: input / 2,
  cache_creation_input_tokens: 0,
  reasoning_output_tokens: output,
});
const request = (input: number, output: number, response = "one", thread = id, details = {}) =>
  at("token_usage_record", {
    thread_id: thread,
    turn_id: "native-turn",
    response_id: response,
    usage: { ...counts(input, output), ...details },
    thread_token_usage: counts(input * 10, output * 10),
  });
let root: string;
let path: string;
let service: TraeSessionUsage;
let now: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "trae-session-usage-"));
  await mkdir(join(root, "sessions"));
  path = join(root, "sessions", `rollout-test-${id}.jsonl`);
  now = Date.parse("2026-11-03T12:00:00Z");
  service = new TraeSessionUsage({ env: { TRAECLI_HOME: root }, intervalMs: 0, now: () => now });
});
afterEach(async () => {
  service.dispose();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function agent(extra = {}) {
  const refresh = vi.fn().mockResolvedValue({
    agent: {
      provider: "traecli-queue",
      archivedAt: null,
      persistence: {
        sessionId: `plugin:${JSON.stringify({ version: 2, data: { sessionId: id, workspaceCwd: "/repo" } })}`,
      },
      ...extra,
    },
  });
  const ref = vi.fn().mockReturnValue({ refresh });
  return { paseo: { agents: { ref } } as unknown as PaseoApi, refresh, ref };
}
const read = (paseo: PaseoApi) => service.getStatus(paseo, { agentId: "paseo-agent" });
const snapshot = (input: number, output: number) => ({
  tokens: input + output,
  cost: input + output === 0 ? 0 : null,
  inputTokens: input,
  outputTokens: output,
  cachedInputTokens: input / 2,
  cacheCreationInputTokens: 0,
  reasoningOutputTokens: output,
  refreshError: null,
});

describe("session lifetime token usage", () => {
  it("prices DeepSeek session totals and recovers an existing turn's missing cost", async () => {
    service.dispose();
    service = new TraeSessionUsage({
      env: { TRAECLI_HOME: root },
      intervalMs: 0,
      pricing: testPricing,
    });
    await writeFile(
      path,
      meta() +
        at("turn_context", { model: "DeepSeek-V4.1-Flash" }) +
        request(100_000, 10_000, "one", id, {
          cached_input_tokens: 80_000,
          cache_creation_input_tokens: undefined,
        }),
    );
    const { paseo } = agent();
    expect((await read(paseo)).cost).toBeCloseTo(0.00924, 8);
    const usage: TurnUsageData = {
      state: "ready",
      outcome: "completed",
      cost: null,
      inputTokens: 100_000,
      outputTokens: 10_000,
      cachedInputTokens: 80_000,
      cacheCreationInputTokens: null,
      reasoningOutputTokens: 10_000,
    };
    expect(
      (await service.getTurnCost(paseo, { agentId: "paseo-agent", timestamp: now, usage })).cost,
    ).toBeCloseTo(0.00924, 8);
  });
  it("recovers an old turn's cost after prices become available, independently of the session total", async () => {
    service.dispose();
    let available = false;
    service = new TraeSessionUsage({
      env: { TRAECLI_HOME: root },
      intervalMs: 0,
      pricing: { getCatalog: async () => (available ? testPrices : emptyPriceCatalog) },
    });
    const history =
      meta() +
      at("turn_context", { model: "fixture-model-a" }) +
      request(200_000, 10_000, "one") +
      request(200_000, 10_000, "two") +
      at("turn_context", { model: "test-model" }) +
      request(100_000, 10_000, "three", id, { cache_creation_input_tokens: 20_000 }).replace(
        '"turn_id":"native-turn"',
        '"turn_id":"later-turn"',
      );
    await writeFile(path, history);
    const { paseo } = agent();
    const oldRow: TurnUsageData = {
      state: "ready",
      outcome: "completed",
      cost: null,
      inputTokens: 400_000,
      outputTokens: 20_000,
      cachedInputTokens: 200_000,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 20_000,
    };
    const input = { agentId: "paseo-agent", timestamp: now, usage: oldRow };
    expect(await service.getTurnCost(paseo, input)).toEqual({ cost: null });
    available = true;
    expect((await read(paseo)).cost).toBeCloseTo(0.95);
    expect((await service.getTurnCost(paseo, input)).cost).toBeCloseTo(0.62);
    // Persisted row values and native history remain untouched.
    expect(oldRow.cost).toBeNull();
    expect(await readFile(path, "utf8")).toBe(history);
    service.dispose();
    service = new TraeSessionUsage({ env: { TRAECLI_HOME: root }, pricing: testPricing });
    expect((await service.getTurnCost(paseo, input)).cost).toBeCloseTo(0.62);
  });

  it("cannot use a client source to read another session or bypass provider checks", async () => {
    const fileRead = vi.spyOn(SessionUsageFile.prototype, "read");
    const input = {
      agentId: "paseo-agent",
      timestamp: now,
      usage: {
        state: "ready" as const,
        outcome: "completed" as const,
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 50,
        source: { sessionId: "../other-session", turnIds: ["native-turn"] },
      },
    };
    expect(await service.getTurnCost(agent({ provider: "codex" }).paseo, input)).toEqual({
      cost: null,
    });
    expect(fileRead).not.toHaveBeenCalled();
    await writeFile(path, meta() + request(100, 10));
    expect(await service.getTurnCost(agent().paseo, input)).toEqual({ cost: null });
    await appendFile(path, at("token_usage_record", { usage: { input_tokens: -1 } }));
    expect(
      await service.getTurnCost(agent().paseo, {
        ...input,
        usage: { ...input.usage, source: undefined },
      }),
    ).toEqual({ cost: null });
  });
  it("sums costs across models and retains tokens when a request cannot be priced", async () => {
    service.dispose();
    service = new TraeSessionUsage({
      env: { TRAECLI_HOME: root },
      intervalMs: 0,
      pricing: testPricing,
    });
    await writeFile(
      path,
      meta() +
        at("turn_context", { model: "Fixture-Model-A__max" }) +
        request(200_000, 10_000, "one") +
        request(200_000, 10_000, "two") +
        at("turn_context", { model: "test-model" }) +
        request(100_000, 10_000, "three", id, { cache_creation_input_tokens: 20_000 }),
    );
    const { paseo } = agent();
    const result = await read(paseo);
    expect(result.tokens).toBe(530_000);
    expect(result.cost).toBeCloseTo(0.95);
    await appendFile(path, at("turn_context", { model: "unpriced" }) + request(100, 10, "four"));
    expect(await read(paseo)).toMatchObject({ tokens: 530_110, cost: null });
  });
  it("restores all history, counts input plus output once, and isolates child threads", async () => {
    const first = request(1000, 100);
    await writeFile(
      path,
      meta() +
        first +
        first +
        request(500, 50, "two") +
        request(8000, 800, "child", "child-thread") +
        at("event_msg", { type: "token_count", info: { total_token_usage: counts(1500, 150) } }),
    );
    const { paseo, ref } = agent();
    expect(await read(paseo)).toEqual(snapshot(1500, 150));
    expect(ref).toHaveBeenCalledWith("paseo-agent");
    await appendFile(path, request(200, 20, "three"));
    expect(await read(paseo)).toEqual(snapshot(1700, 170));
  });

  it("uses legacy cumulative counters without counting repeated reports twice", async () => {
    const cumulative = (input: number, output: number) =>
      at("event_msg", { type: "token_count", info: { total_token_usage: counts(input, output) } });
    await writeFile(path, meta() + cumulative(1000, 100) + cumulative(1000, 100));
    const { paseo } = agent();
    expect((await read(paseo)).tokens).toBe(1100);
    await appendFile(path, cumulative(1500, 150));
    expect(await read(paseo)).toEqual(snapshot(1500, 150));
  });

  it("preserves cache creation and reasoning as subsets without adding them to the total", async () => {
    const first = request(1000, 100, "one", id, {
      cache_creation_input_tokens: 200,
      reasoning_output_tokens: 36,
    });
    await writeFile(
      path,
      meta() +
        first +
        first +
        request(500, 50, "two", id, {
          cache_creation_input_tokens: 100,
          reasoning_output_tokens: 24,
        }),
    );
    expect(await read(agent().paseo)).toEqual({
      ...snapshot(1500, 150),
      cacheCreationInputTokens: 300,
      reasoningOutputTokens: 60,
    });
  });

  it("does not expose partial details as a complete lifetime breakdown", async () => {
    await writeFile(
      path,
      meta() +
        request(100, 10) +
        request(200, 20, "two", id, {
          cached_input_tokens: undefined,
          cache_creation_input_tokens: undefined,
          reasoning_output_tokens: undefined,
        }),
    );
    expect(await read(agent().paseo)).toEqual({
      ...snapshot(300, 30),
      cachedInputTokens: null,
      cacheCreationInputTokens: null,
      reasoningOutputTokens: null,
    });
  });

  it("keeps totals reliable when optional details are invalid or legacy baselines are missing", async () => {
    const cumulative = (usage: unknown) =>
      at("event_msg", { type: "token_count", info: { total_token_usage: usage } });
    await writeFile(
      path,
      meta() + cumulative({ input_tokens: 100, output_tokens: 10 }) + cumulative(counts(200, 20)),
    );
    const { paseo } = agent();
    expect(await read(paseo)).toEqual({
      ...snapshot(200, 20),
      cachedInputTokens: null,
      cacheCreationInputTokens: null,
      reasoningOutputTokens: null,
    });
    service.dispose();
    service = new TraeSessionUsage({ env: { TRAECLI_HOME: root }, intervalMs: 0 });
    await writeFile(
      path,
      meta() +
        request(100, 10, "one", id, {
          cache_creation_input_tokens: 101,
          reasoning_output_tokens: -1,
        }),
    );
    expect(await read(paseo)).toEqual({
      ...snapshot(100, 10),
      cacheCreationInputTokens: null,
      reasoningOutputTokens: null,
    });
  });

  it("resolves raw runtime IDs when a persistence handle is not available yet", async () => {
    await writeFile(path, meta() + request(100, 10));
    const { paseo } = agent({ persistence: null, runtimeInfo: { sessionId: id } });
    expect((await read(paseo)).tokens).toBe(110);
  });

  it.each([{ provider: "codex" }, { archivedAt: "2026-11-03" }])(
    "does not read another provider or archived card: %j",
    async (extra) => {
      const fileRead = vi.spyOn(SessionUsageFile.prototype, "read");
      const { paseo } = agent(extra);
      expect((await read(paseo)).tokens).toBeNull();
      expect(fileRead).not.toHaveBeenCalled();
    },
  );

  it("keeps an unopened session unavailable without manufacturing zero", async () => {
    const { paseo, refresh } = agent({ persistence: null, runtimeInfo: null });
    expect(await read(paseo)).toEqual(emptySessionUsage);
    refresh.mockResolvedValue(null);
    expect((await read(paseo)).tokens).toBeNull();
  });

  it("distinguishes missing usage from an explicit zero-token record", async () => {
    const { paseo } = agent();
    expect((await read(paseo)).tokens).toBeNull();
    await writeFile(path, meta());
    expect((await read(paseo)).tokens).toBeNull();
    await appendFile(path, request(0, 0));
    expect(await read(paseo)).toEqual(snapshot(0, 0));
  });

  it("waits for the remainder of a partially flushed record", async () => {
    const line = request(100, 10);
    await writeFile(path, meta() + line.slice(0, -10));
    const { paseo } = agent();
    expect((await read(paseo)).tokens).toBeNull();
    await appendFile(path, line.slice(-10));
    expect((await read(paseo)).tokens).toBe(110);
  });

  it("coalesces file reads and applies only a short cache", async () => {
    service.dispose();
    service = new TraeSessionUsage({
      env: { TRAECLI_HOME: root },
      intervalMs: 1000,
      now: () => now,
    });
    await writeFile(path, meta() + request(100, 10));
    const fileRead = vi.spyOn(SessionUsageFile.prototype, "read");
    const { paseo } = agent();
    const results = await Promise.all([read(paseo), read(paseo)]);
    expect(results.map((result) => result.tokens)).toEqual([110, 110]);
    expect(fileRead).toHaveBeenCalledOnce();
    await appendFile(path, request(200, 20, "two"));
    expect((await read(paseo)).tokens).toBe(110);
    now += 1001;
    expect((await read(paseo)).tokens).toBe(330);
    expect(fileRead).toHaveBeenCalledTimes(2);
  });

  it("recovers after a corrupt or replaced file without returning partial or stale totals", async () => {
    await writeFile(path, meta() + request(100, 10));
    const { paseo } = agent();
    expect((await read(paseo)).tokens).toBe(110);
    await appendFile(path, at("token_usage_record", { usage: { input_tokens: -1 } }));
    const failed = await read(paseo);
    expect(failed).toMatchObject({ tokens: null, refreshError: expect.any(String) });
    expect(JSON.stringify(failed)).not.toContain(root);
    await writeFile(path, meta() + request(200, 20));
    expect((await read(paseo)).tokens).toBe(220);
  });

  it("rejects a mismatched native session identity", async () => {
    await writeFile(path, meta("somebody-else") + request(100, 10));
    expect((await read(agent().paseo)).tokens).toBeNull();
  });

  it("follows archived records and supports TRAE_HOME", async () => {
    service.dispose();
    service = new TraeSessionUsage({ env: { TRAE_HOME: root }, intervalMs: 0 });
    await mkdir(join(root, "cli", "archived_sessions"), { recursive: true });
    await writeFile(path, meta() + request(100, 10));
    await rename(path, join(root, "cli", "archived_sessions", `-${id}.jsonl`));
    expect((await read(agent().paseo)).tokens).toBe(110);
  });

  it("isolates different agents and stops reading after disposal", async () => {
    const other = "00000000-0000-4000-8000-000000000002";
    await writeFile(path, meta() + request(100, 10));
    await writeFile(
      join(root, "sessions", `${other}.jsonl`),
      meta(other) + request(500, 50, "one", other),
    );
    const first = agent();
    const second = agent({ persistence: { sessionId: other } });
    expect((await read(first.paseo)).tokens).toBe(110);
    expect((await read(second.paseo)).tokens).toBe(550);
    service.dispose();
    first.ref.mockClear();
    expect((await read(first.paseo)).tokens).toBeNull();
    expect(first.ref).not.toHaveBeenCalled();
  });
});
