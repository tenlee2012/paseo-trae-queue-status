import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addCosts,
  ModelPriceCatalog,
  ModelsDevPricing,
  parseModelPrices,
  PRICE_CACHE_MS,
} from "./model-pricing.js";
import { modelPrices, testPrices } from "./fixtures/model-prices.js";
import type { UsageEvent } from "./usage-rollout.js";

const event = (extra: Partial<UsageEvent> = {}): UsageEvent => ({
  key: "one",
  timestamp: 0,
  model: "Fixture-Model-A__max",
  turnId: "turn",
  inputTokens: 100_000,
  outputTokens: 10_000,
  tokens: 110_000,
  cachedTokens: 80_000,
  cacheCreationTokens: 15_000,
  reasoningTokens: 8_000,
  ...extra,
});

describe("Models.dev costs", () => {
  it.each([
    ["DeepSeek-V4.1-Flash", 0.00924],
    ["deepseek-v4.1-flash__max", 0.00924],
    ["DeepSeek V4.1 Flash", 0.00924],
    ["deepseek/deepseek-v4.1-flash", 0.00924],
    ["deepseek-flash", 0.00924],
    ["DeepSeek-V4-Flash", 0.00924],
    ["DeepSeek-V4-Pro", 0.03476],
    ["deepseek-v4-pro__max", 0.03476],
  ])(
    "resolves %s to official rates despite dated canonical IDs and reseller collisions",
    (model, expected) => {
      const catalog = new ModelPriceCatalog(
        parseModelPrices({
          reseller: {
            models: Object.fromEntries(
              ["deepseek-flash", "deepseek-v4.1-flash", "deepseek-v4-flash", "deepseek-v4-pro"].map(
                (id) => [
                  id,
                  {
                    name: id,
                    canonical_model_id: `deepseek/${id}`,
                    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
                  },
                ],
              ),
            ),
          },
          ...modelPrices,
        }),
      );
      expect(catalog.cost(event({ model }))).toBeCloseTo(expected, 8);
    },
  );

  it.each([0, 15_000, null])(
    "bills DeepSeek cache creation as ordinary input when the counter is %s",
    (cacheCreationTokens) => {
      expect(
        testPrices.cost(event({ model: "deepseek-v4.1-flash", cacheCreationTokens })),
      ).toBeCloseTo(0.00924, 8);
      expect(
        testPrices.cost(
          event({ model: "deepseek-v4.1-flash", cacheCreationTokens, cachedTokens: null }),
        ),
      ).toBeNull();
    },
  );

  it("keeps explicit write prices and provider choices, and never guesses other model versions", () => {
    const response = structuredClone(modelPrices);
    Object.assign(response.deepseek.models["deepseek-flash"].cost, { cache_write: 2 });
    const catalog = new ModelPriceCatalog(
      parseModelPrices({
        ...response,
        reseller: {
          models: {
            "deepseek-v4.1-flash": {
              canonical_model_id: "deepseek/deepseek-v4.1-flash",
              cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 3 },
            },
          },
        },
      }),
    );
    expect(catalog.cost(event({ model: "deepseek-v4.1-flash" }))).toBeCloseTo(0.03699, 8);
    expect(catalog.cost(event({ model: "reseller/deepseek-v4.1-flash" }))).toBeCloseTo(0.078, 8);
    expect(catalog.cost(event({ model: "deepseek-v9-flash" }))).toBeNull();
    expect(
      catalog.cost(
        event({ model: "deepseek-v4.1-flash", cachedTokens: 100_000, cacheCreationTokens: 1 }),
      ),
    ).toBeNull();
    expect(testPrices.cost(event({ model: "fixture-model-a", cacheCreationTokens: null }))).toBeNull();
  });

  it("prefers a dedicated official model entry over its compatibility alias", () => {
    const catalog = new ModelPriceCatalog(
      parseModelPrices({
        deepseek: {
          models: {
            ...modelPrices.deepseek.models,
            "deepseek-v4.1-flash": {
              canonical_model_id: "deepseek/deepseek-v4.1-flash",
              cost: { input: 0.3, output: 1.2, cache_read: 0.006 },
            },
          },
        },
      }),
    );
    expect(catalog.cost(event({ model: "deepseek-v4.1-flash" }))).toBeCloseTo(0.01848, 8);
  });

  it("prices ordinary input, reads, writes and output once, without adding reasoning", () => {
    expect(testPrices.cost(event())).toBeCloseTo(0.1555);
    expect(testPrices.cost(event({ model: "openai/fixture-model-a" }))).toBeCloseTo(0.1555);
    expect(testPrices.cost(event({ model: "Fixture Model A" }))).toBeCloseTo(0.1555);
    expect(testPrices.cost(event({ reasoningTokens: null }))).toBeCloseTo(0.1555);
    const sameAlias = structuredClone(modelPrices);
    sameAlias.openai.models["fixture-model-a"].name = "Fixture-Model-A";
    expect(new ModelPriceCatalog(parseModelPrices(sameAlias)).cost(event())).toBeCloseTo(0.1555);
  });

  it("uses explicit context thresholds including cache tokens, not the legacy 200k label", () => {
    const request = (inputTokens: number) =>
      event({
        inputTokens,
        tokens: inputTokens + 10_000,
        cachedTokens: inputTokens - 20_000,
        cacheCreationTokens: 15_000,
      });
    expect(testPrices.cost(request(272_000))).toBeCloseTo(0.1727);
    expect(testPrices.cost(request(272_001))).toBeCloseTo(0.2954002);
    const legacy = new ModelPriceCatalog(
      parseModelPrices({
        legacy: {
          models: {
            legacy: { cost: { input: 1, output: 2, context_over_200k: { input: 3, output: 4 } } },
          },
        },
      }),
    );
    expect(
      legacy.cost(
        event({ model: "legacy", inputTokens: 200_001, cachedTokens: 0, cacheCreationTokens: 0 }),
      ),
    ).toBeCloseTo(0.640003);
  });

  it("prefers a model's canonical provider and preserves explicit provider selection", () => {
    const catalog = new ModelPriceCatalog(
      parseModelPrices({
        cheap: {
          models: {
            "fixture-model-a": {
              name: "Fixture Model A",
              canonical_model_id: "openai/fixture-model-a",
              cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            },
          },
        },
        ...modelPrices,
      }),
    );
    expect(catalog.cost(event())).toBeCloseTo(0.1555);
    expect(catalog.cost(event({ model: "cheap/fixture-model-a" }))).toBe(0);
    const ambiguous = new ModelPriceCatalog(
      parseModelPrices({
        a: { models: { m: { cost: { input: 1, output: 1 } } } },
        b: { models: { m: { cost: { input: 2, output: 2 } } } },
      }),
    );
    expect(ambiguous.cost(event({ model: "m" }))).toBeNull();
  });

  it.each([
    { model: "unknown" },
    { model: null },
    { cachedTokens: null },
    { cacheCreationTokens: null },
    { cachedTokens: 100_000, cacheCreationTokens: 1 },
  ])("does not present incomplete billing data as a known cost: %j", (extra) => {
    expect(testPrices.cost(event(extra))).toBeNull();
    expect(addCosts(1, testPrices.cost(event(extra)))).toBeNull();
  });

  it("distinguishes missing prices from explicit free rates and zero usage", () => {
    const catalog = new ModelPriceCatalog(
      parseModelPrices({
        p: {
          models: {
            free: { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
            uncached: { cost: { input: 1, output: 2 } },
            invalid: { cost: { input: -1, output: 2 } },
          },
        },
      }),
    );
    expect(catalog.cost(event({ model: "free" }))).toBe(0);
    expect(catalog.cost(event({ model: "uncached" }))).toBeNull();
    expect(catalog.cost(event({ model: "invalid" }))).toBeNull();
    expect(catalog.cost(event({ tokens: 0, inputTokens: 0, outputTokens: 0 }))).toBe(0);
    expect(() => parseModelPrices({})).toThrow();
  });
});

describe("24-hour price cache", () => {
  let directory: string;
  let cachePath: string;
  let now: number;
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  let pricing: ModelsDevPricing;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "trae-model-pricing-"));
    cachePath = join(directory, "cache.json");
    now = 1_800_000_000_000;
    fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(modelPrices)));
    pricing = new ModelsDevPricing({ fetch: fetcher, cachePath, now: () => now });
  });
  afterEach(async () => {
    pricing.dispose();
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });

  it("shares concurrent reads, persists across restarts, and refreshes at 24 hours", async () => {
    const [first, concurrent] = await Promise.all([pricing.getCatalog(), pricing.getCatalog()]);
    expect(first).toBe(concurrent);
    expect(first.cost(event())).toBeCloseTo(0.1555);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("https://models.dev/api.json");
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty("body");
    const persisted = JSON.parse(await readFile(cachePath, "utf8"));
    expect(persisted.fetchedAt).toBe(now);
    pricing.dispose();
    pricing = new ModelsDevPricing({ fetch: fetcher, cachePath, now: () => now });
    now += PRICE_CACHE_MS - 1;
    expect((await pricing.getCatalog()).cost(event())).toBeCloseTo(0.1555);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now++;
    const changed = structuredClone(modelPrices);
    changed.openai.models["fixture-model-a"].cost.output = 20;
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(changed)));
    expect((await pricing.getCatalog()).cost(event())).toBeCloseTo(0.2555);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retains stale prices on failure, coalesces retries and recovers", async () => {
    const first = await pricing.getCatalog();
    now += PRICE_CACHE_MS;
    fetcher.mockRejectedValueOnce(new Error("offline"));
    expect(await pricing.getCatalog()).toBe(first);
    expect(await pricing.getCatalog()).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(2);
    now += 5 * 60 * 1000;
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(modelPrices)));
    expect((await pricing.getCatalog()).cost(event())).toBeCloseTo(0.1555);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(["corrupt", "future"])(
    "ignores a %s cache and handles upstream failure without hiding usage",
    async (kind) => {
      await writeFile(
        cachePath,
        kind === "corrupt"
          ? "{"
          : JSON.stringify({
              version: 1,
              fetchedAt: now + PRICE_CACHE_MS,
              prices: parseModelPrices(modelPrices),
            }),
      );
      fetcher.mockResolvedValueOnce(new Response("offline", { status: 503 }));
      expect((await pricing.getCatalog()).cost(event())).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("aborts requests on timeout and disposal", async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    fetcher.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
          started();
        }),
    );
    const pending = pricing.getCatalog();
    await fetching;
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).cost(event())).toBeNull();
    expect(fetcher.mock.calls[0][1]!.signal!.aborted).toBe(true);
    pricing.dispose();
    await pricing.getCatalog();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
