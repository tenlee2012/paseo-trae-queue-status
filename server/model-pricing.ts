import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { normalizeUsageModel } from "../shared/model-usage.js";
import type { UsageEvent } from "./usage-rollout.js";

const PRICES_URL = "https://models.dev/api.json";
export const PRICE_CACHE_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const rate = z.number().finite().nonnegative();
const ratesSchema = z.object({
  input: rate,
  output: rate,
  cache_read: rate.optional(),
  cache_write: rate.optional(),
});
const costSchema = ratesSchema.extend({
  tiers: z
    .array(
      ratesSchema.partial().extend({
        tier: z.object({ type: z.literal("context"), size: z.number().int().nonnegative() }),
      }),
    )
    .optional(),
  context_over_200k: ratesSchema.partial().optional(),
});
const priceSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  canonical: z.string().optional(),
  cost: costSchema,
});
type ModelPrice = z.output<typeof priceSchema>;
const cacheSchema = z.object({
  version: z.literal(1),
  fetchedAt: z.number().finite().nonnegative(),
  prices: z.array(priceSchema).min(1),
});
type PriceCache = z.output<typeof cacheSchema>;

// TRAE uses the model family name; DeepSeek serves V4.1 Flash through this API
// ID. Keep the alias scoped to the official provider and read all rates from
// Models.dev, including after the provider updates its dated canonical model.
// https://api-docs.deepseek.com/quick_start/pricing/
const officialModelAliases = new Map([
  ["deepseek-v4.1-flash", "deepseek/deepseek-flash"],
  ["deepseek v4.1 flash", "deepseek/deepseek-flash"],
  ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-flash"],
]);

export interface ModelPricingSource {
  getCatalog(): Promise<ModelPriceCatalog>;
}

// Only explicit model IDs/names are matched. In particular, a gateway's cheap
// price must not win over the model lab's own price because of catalog order.
export class ModelPriceCatalog {
  private readonly aliases = new Map<string, ModelPrice[]>();
  private readonly qualified = new Map<string, ModelPrice>();

  constructor(prices: ModelPrice[] = []) {
    for (const price of prices) {
      this.qualified.set(normalizeUsageModel(`${price.provider}/${price.id}`), price);
      for (const key of new Set(
        [price.id, price.name, price.canonical]
          .filter((alias) => alias !== undefined)
          .map(normalizeUsageModel),
      )) {
        const candidates = this.aliases.get(key) ?? [];
        candidates.push(price);
        this.aliases.set(key, candidates);
      }
    }
  }

  cost(event: UsageEvent): number | null {
    if (event.tokens === 0) return 0;
    if (!event.model) return null;
    const model = normalizeUsageModel(event.model);
    const candidates = this.aliases.get(model) ?? [];
    const originals = candidates.filter(
      (price) =>
        price.canonical &&
        normalizeUsageModel(price.canonical).startsWith(`${price.provider.toLowerCase()}/`),
    );
    const exactOriginals = originals.filter(
      (candidate) => normalizeUsageModel(candidate.id) === model,
    );
    const price =
      this.qualified.get(model) ??
      (exactOriginals.length === 1 ? exactOriginals[0] : undefined) ??
      this.qualified.get(officialModelAliases.get(model) ?? "") ??
      (originals.length === 1 ? originals[0] : candidates.length === 1 ? candidates[0] : undefined);
    if (!price) return null;
    const rates = { ...price.cost };
    // Select a tier per request, using total input (including cached input),
    // never the accumulated turn/session/day total. Prefer explicit thresholds
    // over Models.dev's legacy context_over_200k field.
    if (price.cost.tiers?.length) {
      for (const tier of price.cost.tiers.toSorted((a, b) => a.tier.size - b.tier.size)) {
        if (event.inputTokens > tier.tier.size) Object.assign(rates, tier);
      }
    } else if (event.inputTokens > 200_000 && price.cost.context_over_200k) {
      Object.assign(rates, price.cost.context_over_200k);
    }
    const cached = event.inputTokens === 0 ? 0 : event.cachedTokens;
    // DeepSeek's automatic cache writes are ordinary cache-miss input, not a
    // separately priced operation. An absent creation counter is irrelevant
    // when writes and ordinary input have the same rate; reads remain required.
    // https://api-docs.deepseek.com/guides/kv_cache/
    const writeRate =
      rates.cache_write ?? (price.provider === "deepseek" ? rates.input : undefined);
    const created =
      event.inputTokens === 0
        ? 0
        : (event.cacheCreationTokens ?? (writeRate === rates.input ? 0 : null));
    if (cached === null || created === null || cached + created > event.inputTokens) return null;
    if (cached > 0 && rates.cache_read === undefined) return null;
    if (created > 0 && writeRate === undefined) return null;
    const cost =
      ((event.inputTokens - cached - created) * rates.input +
        cached * (rates.cache_read ?? 0) +
        created * (writeRate ?? 0) +
        event.outputTokens * rates.output) /
      1_000_000;
    return Number.isFinite(cost) ? cost : null;
  }
}

export const emptyPriceCatalog = new ModelPriceCatalog();

export function addCosts(left: number | null | undefined, right: number | null): number | null {
  if (left == null || right === null) return null;
  const sum = left + right;
  return Number.isFinite(sum) ? sum : null;
}

export function parseModelPrices(value: unknown): ModelPrice[] {
  const providers = z.record(z.string(), z.unknown()).parse(value);
  const prices: ModelPrice[] = [];
  for (const [provider, data] of Object.entries(providers)) {
    const entry = z.object({ models: z.record(z.string(), z.unknown()) }).safeParse(data);
    if (!entry.success) continue;
    for (const [id, modelData] of Object.entries(entry.data.models)) {
      const model = z
        .object({
          id: z.string().optional(),
          name: z.string().optional(),
          canonical_model_id: z.string().optional(),
          cost: costSchema,
        })
        .safeParse(modelData);
      if (!model.success) continue;
      prices.push({
        provider,
        id: model.data.id ?? id,
        name: model.data.name ?? id,
        canonical: model.data.canonical_model_id,
        cost: model.data.cost,
      });
    }
  }
  if (!prices.length) throw new Error("No valid model prices");
  return prices;
}

interface PricingOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  cachePath?: string | null;
}

// Shared by all usage readers. Persist only public pricing, never session data.
// Refresh lazily after 24 hours, coalesce concurrent reads, and retain the last
// good catalog if the upstream is unavailable. Failed attempts retry after 5m.
export class ModelsDevPricing implements ModelPricingSource {
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly cachePath: string | null;
  private readonly abort = new AbortController();
  private loaded = false;
  private fetchedAt = -Infinity;
  private retryAt = -Infinity;
  private catalog = emptyPriceCatalog;
  private pending?: Promise<ModelPriceCatalog>;

  constructor(options: PricingOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.cachePath =
      options.cachePath === undefined
        ? join(
            process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
            "paseo-trae-queue-status",
            "models-dev-prices.json",
          )
        : options.cachePath;
  }

  getCatalog(): Promise<ModelPriceCatalog> {
    if (this.abort.signal.aborted) return Promise.resolve(this.catalog);
    if (this.pending) return this.pending;
    this.pending = this.refresh().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  dispose(): void {
    this.abort.abort();
  }

  private async refresh(): Promise<ModelPriceCatalog> {
    if (!this.loaded) {
      this.loaded = true;
      if (this.cachePath) {
        try {
          const cached = cacheSchema.parse(JSON.parse(await readFile(this.cachePath, "utf8")));
          if (cached.fetchedAt <= this.now()) this.accept(cached);
        } catch {
          /* A missing/corrupt cache is replaced after a successful fetch. */
        }
      }
    }
    if (
      this.abort.signal.aborted ||
      this.now() < this.retryAt ||
      (this.now() >= this.fetchedAt && this.now() - this.fetchedAt < PRICE_CACHE_MS)
    )
      return this.catalog;
    const request = new AbortController();
    const cancel = () => request.abort();
    this.abort.signal.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(cancel, 10_000);
    timeout.unref();
    try {
      const response = await this.fetch(PRICES_URL, {
        signal: request.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Price request failed");
      const prices = parseModelPrices(await response.json());
      if (this.abort.signal.aborted) return this.catalog;
      const cached: PriceCache = { version: 1, fetchedAt: this.now(), prices };
      this.accept(cached);
      await this.persist(cached);
    } catch {
      this.retryAt = this.now() + RETRY_MS;
    } finally {
      clearTimeout(timeout);
      this.abort.signal.removeEventListener("abort", cancel);
    }
    return this.catalog;
  }

  private accept(cached: PriceCache): void {
    this.catalog = new ModelPriceCatalog(cached.prices);
    this.fetchedAt = cached.fetchedAt;
    this.retryAt = -Infinity;
  }

  private async persist(cached: PriceCache): Promise<void> {
    if (!this.cachePath) return;
    const temporary = `${this.cachePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.cachePath), { recursive: true });
      await writeFile(temporary, JSON.stringify(cached), { mode: 0o600 });
      await rename(temporary, this.cachePath);
    } catch {
      // A read-only cache directory must not discard a valid in-memory catalog.
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
