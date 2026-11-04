import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usageForModel } from "../client/model-usage.js";
import { modelUsageSnapshotSchema } from "../shared/model-usage.js";
import { TraeModelUsage, usagePeriods } from "./model-usage.js";
import { testPricing } from "./fixtures/model-prices.js";
import { ModelPriceCatalog } from "./model-pricing.js";

let directory: string;
let now: number;
let service: TraeModelUsage;

beforeEach(async () => {
  vi.stubEnv("TZ", "Asia/Shanghai");
  directory = await mkdtemp(join(tmpdir(), "trae-model-usage-"));
  await mkdir(join(directory, "sessions"));
  await mkdir(join(directory, "archived_sessions"));
  now = Date.parse("2026-10-28T12:00:00+08:00");
  service = new TraeModelUsage({ env: { TRAECLI_HOME: directory }, now: () => now, intervalMs: 0 });
});

afterEach(async () => {
  service.dispose();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const at = (time: string, type: string, payload: unknown) =>
  JSON.stringify({ timestamp: time, type, payload }) + "\n";
const meta = (id = "session-1") => at("2026-10-25T12:00:00+08:00", "session_meta", { id });
const context = (model: string) => at("2026-10-25T12:00:00+08:00", "turn_context", { model });
const tokenValues = (input: number, output: number, cached: number | null = input - 1) => ({
  input_tokens: input,
  output_tokens: output,
  total_tokens: input + output,
  ...(cached === null ? {} : { cached_input_tokens: cached }),
  reasoning_output_tokens: output - 1,
});

function request(
  time: string,
  input: number,
  output: number,
  totalInput: number,
  totalOutput: number,
  options: { id?: string; model?: string; thread?: string; cached?: number | null } = {},
) {
  const usage = tokenValues(input, output, options.cached);
  const total = tokenValues(totalInput, totalOutput);
  return (
    at(time, "token_usage_record", {
      thread_id: options.thread ?? "session-1",
      turn_id: "turn-1",
      response_id: options.id ?? "resp_3",
      usage,
      thread_token_usage: total,
    }) +
    at(time, "event_msg", {
      type: "token_count",
      info: { total_token_usage: total, last_token_usage: usage },
      context: { model: options.model ?? "Fixture-Model-B" },
    })
  );
}

async function save(name: string, contents: string) {
  const path = join(directory, name);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
  await utimes(path, new Date(now), new Date(now));
  return path;
}

describe("local model usage", () => {
  it("prices DeepSeek daily and weekly usage without a separate cache-creation counter", async () => {
    service.dispose();
    service = new TraeModelUsage({
      env: { TRAECLI_HOME: directory },
      now: () => now,
      intervalMs: 0,
      pricing: testPricing,
    });
    await save(
      "sessions/deepseek.jsonl",
      meta() +
        context("DeepSeek-V4.1-Flash") +
        request("2026-10-27T12:00:00+08:00", 100_000, 10_000, 100_000, 10_000, {
          model: "DeepSeek-V4.1-Flash",
          cached: 80_000,
        }) +
        request("2026-10-28T10:00:00+08:00", 200_000, 20_000, 300_000, 30_000, {
          model: "deepseek-v4.1-flash__max",
          cached: 160_000,
        }),
    );
    const result = await service.getStatus();
    expect(result.refreshError).toBeNull();
    expect(result.snapshot!.models).toHaveLength(1);
    const usage = result.snapshot!.models[0];
    expect(usage).toMatchObject({
      model: "deepseek-v4.1-flash",
      todayTokens: 220_000,
      weekTokens: 330_000,
    });
    expect(usage.todayCost).toBeCloseTo(0.01848, 8);
    expect(usage.weekCost).toBeCloseTo(0.02772, 8);
  });
  it("sums request costs across day/week boundaries before and after price refreshes", async () => {
    service.dispose();
    const pricing = { getCatalog: vi.fn(testPricing.getCatalog) };
    service = new TraeModelUsage({
      env: { TRAECLI_HOME: directory },
      now: () => now,
      intervalMs: 0,
      pricing,
    });
    const priced = (time: string, response: string) =>
      at(time, "token_usage_record", {
        thread_id: "session-1",
        response_id: response,
        turn_id: "turn-1",
        usage: { ...tokenValues(200_000, 10_000, 100_000), cache_creation_input_tokens: 0 },
        thread_token_usage: tokenValues(200_000, 10_000),
      });
    const history =
      meta() +
      context("fixture-model-a__max") +
      priced("2026-10-27T12:00:00+08:00", "yesterday") +
      priced("2026-10-28T10:00:00+08:00", "today-1") +
      priced("2026-10-28T11:00:00+08:00", "today-2");
    await save("sessions/priced.jsonl", history);
    await save("archived_sessions/copy.jsonl", history);
    const result = (await service.getStatus()).snapshot!.models[0];
    expect(result.todayTokens).toBe(420_000);
    expect(result.weekTokens).toBe(630_000);
    expect(result.todayCost).toBeCloseTo(0.62);
    expect(result.weekCost).toBeCloseTo(0.93);
    // Reprice existing records even without a file append when the catalog changes.
    const changed = new ModelPriceCatalog();
    vi.spyOn(changed, "cost").mockReturnValue(1);
    pricing.getCatalog.mockResolvedValueOnce(changed);
    expect((await service.getStatus()).snapshot!.models[0]).toMatchObject({
      todayCost: 2,
      weekCost: 3,
    });
    await save(
      "sessions/priced.jsonl",
      history + context("unknown") + priced("2026-10-28T11:30:00+08:00", "unknown"),
    );
    const unknown = (await service.getStatus()).snapshot!.models.find(
      (row) => row.model === "unknown",
    )!;
    expect(unknown.todayTokens).toBe(210_000);
    expect(unknown.todayCost).toBeNull();
  });
  it("does not reassign the previous request when switching models re-emits its cumulative usage", async () => {
    const path = await save(
      "sessions/model-switch.jsonl",
      meta() +
        context("Fixture-Model-B") +
        request("2026-10-28T09:00:00+08:00", 181000, 923, 181000, 923),
    );
    await service.getStatus();
    await appendFile(
      path,
      at("2026-10-28T10:00:00+08:00", "event_msg", {
        type: "token_count",
        info: { total_token_usage: tokenValues(181000, 923) },
        context: { model: "Fixture-Model-A" },
      }) +
        context("Fixture-Model-A") +
        request("2026-10-28T10:01:00+08:00", 200, 20, 181200, 943, { model: "Fixture-Model-A" }),
    );
    await utimes(path, new Date(now), new Date(now));
    expect((await service.getStatus()).snapshot?.models).toEqual([
      {
        model: "fixture-model-b",
        todayTokens: 181923,
        weekTokens: 181923,
        todayCost: null,
        weekCost: null,
        todayCachedTokens: 180999,
        weekCachedTokens: 180999,
      },
      {
        model: "fixture-model-a",
        todayTokens: 220,
        weekTokens: 220,
        todayCost: null,
        weekCost: null,
        todayCachedTokens: 199,
        weekCachedTokens: 199,
      },
    ]);
    const fresh = new TraeModelUsage({ env: { TRAECLI_HOME: directory }, now: () => now });
    try {
      expect((await fresh.getStatus()).snapshot?.models).toEqual(
        (await service.getStatus()).snapshot?.models,
      );
    } finally {
      fresh.dispose();
    }
  });

  it("counts input plus output, including caches, across day/week boundaries and model switches", async () => {
    await save(
      "sessions/old-session.jsonl",
      meta() +
        context("fixture-model-b__max") +
        request("2026-10-25T23:59:59+08:00", 1000, 100, 1000, 100) +
        request("2026-10-26T00:00:00+08:00", 200, 20, 1200, 120) +
        request("2026-10-27T23:59:59+08:00", 300, 30, 1500, 150) +
        request("2026-10-28T00:00:00+08:00", 400, 40, 1900, 190) +
        context("Fixture-Model-A") +
        request("2026-10-28T09:00:00+08:00", 500, 50, 2400, 240, { model: "Fixture-Model-A" }),
    );
    const result = await service.getStatus();
    expect(result.refreshError).toBeNull();
    expect(modelUsageSnapshotSchema.parse(result.snapshot).models).toEqual([
      {
        model: "fixture-model-b",
        todayTokens: 440,
        weekTokens: 990,
        todayCost: null,
        weekCost: null,
        todayCachedTokens: 399,
        weekCachedTokens: 897,
      },
      {
        model: "fixture-model-a",
        todayTokens: 550,
        weekTokens: 550,
        todayCost: null,
        weekCost: null,
        todayCachedTokens: 499,
        weekCachedTokens: 499,
      },
    ]);
    expect(result.snapshot).toMatchObject({
      todayStart: Date.parse("2026-10-28T00:00:00+08:00"),
      weekStart: Date.parse("2026-10-26T00:00:00+08:00"),
      timeZone: "Asia/Shanghai",
    });
  });

  it("deduplicates archive copies, excludes inherited fork usage and counts child requests", async () => {
    const history =
      meta() + context("Fixture-Model-B") + request("2026-10-28T10:00:00+08:00", 100, 10, 100, 10);
    await save("sessions/original.jsonl", history);
    await save("archived_sessions/copy.jsonl", history);
    await save(
      "sessions/child.jsonl",
      meta("child") +
        context("Fixture-Model-B") +
        request("2026-10-28T10:00:00+08:00", 100, 10, 100, 10) +
        request("2026-10-28T11:00:00+08:00", 200, 20, 300, 30, { thread: "child" }),
    );
    expect((await service.getStatus()).snapshot?.models).toEqual([
      {
        model: "fixture-model-b",
        todayTokens: 330,
        weekTokens: 330,
        todayCost: null,
        weekCost: null,
        todayCachedTokens: 298,
        weekCachedTokens: 298,
      },
    ]);
  });

  it("reads appended records once, waits for complete lines and detects rewritten logs", async () => {
    const path = await save(
      "sessions/incremental.jsonl",
      meta() + context("Fixture-Model-B") + request("2026-10-28T09:00:00+08:00", 100, 10, 100, 10),
    );
    expect((await service.getStatus()).snapshot?.models[0].todayTokens).toBe(110);
    const next = request("2026-10-28T10:00:00+08:00", 200, 20, 300, 30);
    await appendFile(path, next.slice(0, 100));
    await utimes(path, new Date(now), new Date(now));
    expect((await service.getStatus()).snapshot?.models[0].todayTokens).toBe(110);
    await appendFile(path, next.slice(100));
    await utimes(path, new Date(now + 1), new Date(now + 1));
    expect((await service.getStatus()).snapshot?.models[0].todayTokens).toBe(330);
    expect((await service.getStatus()).snapshot?.models[0].todayTokens).toBe(330);
    expect((await service.getStatus()).snapshot?.models[0].todayCachedTokens).toBe(298);
    await save(
      "sessions/incremental.jsonl",
      meta() +
        context("Fixture-Model-A") +
        request("2026-10-28T10:00:00+08:00", 900, 90, 900, 90, { model: "Fixture-Model-A" }),
    );
    expect((await service.getStatus()).snapshot?.models).toEqual([
      {
        model: "fixture-model-a",
        todayTokens: 990,
        weekTokens: 990,
        todayCost: null,
        weekCost: null,
        todayCachedTokens: 899,
        weekCachedTokens: 899,
      },
    ]);
    await rename(path, join(directory, "archived_sessions", "moved.jsonl"));
    expect((await service.getStatus()).snapshot?.models[0].todayTokens).toBe(990);
    await rm(join(directory, "archived_sessions", "moved.jsonl"));
    expect((await service.getStatus()).snapshot?.models).toEqual([]);
  });

  it("uses cumulative deltas for legacy records without double counting status updates", async () => {
    const count = (time: string, input: number, output: number) =>
      at(time, "event_msg", {
        type: "token_count",
        info: { total_token_usage: tokenValues(input, output) },
      });
    await save(
      "sessions/legacy.jsonl",
      meta() +
        context("Fixture-Model-B") +
        count("2026-10-25T23:00:00+08:00", 1000, 100) +
        count("2026-10-27T23:00:00+08:00", 1200, 120) +
        count("2026-10-28T09:00:00+08:00", 1500, 150) +
        count("2026-10-28T09:30:00+08:00", 1500, 150) +
        at("2026-10-28T10:00:00+08:00", "event_msg", { type: "token_count", info: null }),
    );
    expect((await service.getStatus()).snapshot?.models).toEqual([
      {
        model: "fixture-model-b",
        todayTokens: 330,
        weekTokens: 550,
        todayCost: null,
        weekCost: null,
        todayCachedTokens: 300,
        weekCachedTokens: 500,
      },
    ]);
  });

  it("keeps missing cache data unknown for only the affected period", async () => {
    await save(
      "sessions/missing-cache.jsonl",
      meta() +
        context("Fixture-Model-B") +
        request("2026-10-27T10:00:00+08:00", 100, 10, 100, 10, { cached: null }) +
        request("2026-10-28T10:00:00+08:00", 200, 20, 300, 30, { cached: 0 }),
    );
    const result = await service.getStatus();
    expect(result.refreshError).toBeNull();
    expect(result.snapshot?.models).toEqual([
      {
        model: "fixture-model-b",
        todayTokens: 220,
        weekTokens: 330,
        todayCost: null,
        weekCost: null,
        todayCachedTokens: 0,
        weekCachedTokens: null,
      },
    ]);
  });

  it("does not infer legacy cached deltas from an unknown baseline", async () => {
    const count = (time: string, input: number, output: number, cached: number | null) =>
      at(time, "event_msg", {
        type: "token_count",
        info: { total_token_usage: tokenValues(input, output, cached) },
      });
    await save(
      "sessions/legacy-missing-cache.jsonl",
      meta() +
        context("Fixture-Model-B") +
        count("2026-10-27T10:00:00+08:00", 100, 10, null) +
        count("2026-10-28T10:00:00+08:00", 200, 20, 150),
    );
    expect((await service.getStatus()).snapshot?.models[0]).toEqual({
      model: "fixture-model-b",
      todayTokens: 110,
      weekTokens: 220,
      todayCost: null,
      weekCost: null,
      todayCachedTokens: null,
      weekCachedTokens: null,
    });
  });

  it.each([-1, 101, 1.5])("rejects invalid cached token counts: %s", async (cached) => {
    await save(
      "sessions/invalid-cache.jsonl",
      meta() +
        context("Fixture-Model-B") +
        request("2026-10-28T10:00:00+08:00", 100, 10, 100, 10, { cached }),
    );
    expect(await service.getStatus()).toMatchObject({
      snapshot: null,
      refreshError: expect.any(String),
    });
  });

  it("retains a last good snapshot on invalid usage and clears it after the day changes", async () => {
    const good =
      meta() + context("Fixture-Model-B") + request("2026-10-28T10:00:00+08:00", 100, 10, 100, 10);
    await save("sessions/invalid.jsonl", good);
    const result = await service.getStatus();
    await save(
      "sessions/invalid.jsonl",
      good + at("2026-10-28T11:00:00+08:00", "token_usage_record", { usage: { input_tokens: -1 } }),
    );
    expect(await service.getStatus()).toMatchObject({
      snapshot: result.snapshot,
      refreshError: expect.any(String),
    });
    now = Date.parse("2026-10-29T12:00:00+08:00");
    expect(await service.getStatus()).toMatchObject({
      snapshot: null,
      refreshError: expect.any(String),
    });
    await save("sessions/invalid.jsonl", good);
    expect((await service.getStatus()).snapshot?.models[0]).toEqual({
      model: "fixture-model-b",
      todayTokens: 0,
      weekTokens: 110,
      todayCost: 0,
      weekCost: null,
      todayCachedTokens: 0,
      weekCachedTokens: 99,
    });
  });

  it("expires cached totals at midnight and Monday even inside the refresh interval", async () => {
    service.dispose();
    service = new TraeModelUsage({ env: { TRAECLI_HOME: directory }, now: () => now });
    now = Date.parse("2026-11-01T23:59:59+08:00");
    await save(
      "sessions/sunday.jsonl",
      meta() + context("Fixture-Model-B") + request("2026-11-01T23:59:00+08:00", 100, 10, 100, 10),
    );
    const first = service.getStatus();
    expect(service.getStatus()).toBe(first);
    expect((await first).snapshot?.models[0].todayTokens).toBe(110);
    now += 2000;
    expect((await service.getStatus()).snapshot).toMatchObject({
      models: [],
      todayStart: Date.parse("2026-11-02T00:00:00+08:00"),
      weekStart: Date.parse("2026-11-02T00:00:00+08:00"),
    });
  });

  it("reports unavailable data instead of zero when records cannot be attributed or the home is missing", async () => {
    await save(
      "sessions/no-model.jsonl",
      meta() +
        at("2026-10-28T10:00:00+08:00", "token_usage_record", {
          usage: tokenValues(100, 10),
          thread_token_usage: tokenValues(100, 10),
        }),
    );
    expect(await service.getStatus()).toMatchObject({
      snapshot: null,
      refreshError: expect.any(String),
    });
    await rm(directory, { recursive: true });
    expect(await service.getStatus()).toMatchObject({
      snapshot: null,
      refreshError: expect.any(String),
    });
  });

  it("respects TRAE_HOME, excludes artifacts and shows zero only for models absent from a successful scan", async () => {
    await save(
      "cli/sessions/session.jsonl",
      meta() + context("fixture-model-b__max") + request("2026-10-28T10:00:00+08:00", 100, 10, 100, 10),
    );
    await save("cli/sessions/session.artifacts/secret.jsonl", "{invalid json}\n");
    const custom = new TraeModelUsage({ env: { TRAE_HOME: directory }, now: () => now });
    try {
      const snapshot = modelUsageSnapshotSchema.parse((await custom.getStatus()).snapshot);
      expect(usageForModel(snapshot, { id: "fixture-model-b__max", name: "Fixture-Model-B" })).toEqual({
        todayTokens: 110,
        weekTokens: 110,
        todayCost: null,
        weekCost: null,
        todayCachedTokens: 99,
        weekCachedTokens: 99,
      });
      expect(usageForModel(snapshot, { id: "unused", name: "Unused" })).toEqual({
        todayTokens: 0,
        weekTokens: 0,
        todayCost: 0,
        weekCost: 0,
        todayCachedTokens: 0,
        weekCachedTokens: 0,
      });
      expect(
        await readFile(join(directory, "cli/sessions/session.artifacts/secret.jsonl"), "utf8"),
      ).toBe("{invalid json}\n");
    } finally {
      custom.dispose();
    }
  });

  it("uses calendar boundaries across daylight saving time", () => {
    vi.stubEnv("TZ", "America/New_York");
    const periods = usagePeriods(Date.parse("2026-11-01T18:00:00-05:00"));
    expect(periods).toEqual({
      todayStart: Date.parse("2026-11-01T00:00:00-04:00"),
      weekStart: Date.parse("2026-10-26T00:00:00-04:00"),
      timeZone: "America/New_York",
    });
  });
});
