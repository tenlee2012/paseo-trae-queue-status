import type { ModelStatus } from "../shared/model-status.js";
import { normalizeUsageModel, type ModelUsageSnapshot } from "../shared/model-usage.js";

const tokenFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});
const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});

interface ModelUsageTotals {
  todayTokens: number;
  weekTokens: number;
  todayCost: number | null;
  weekCost: number | null;
  todayCachedTokens: number | null;
  weekCachedTokens: number | null;
}

export function formatTokens(tokens: number): string {
  return tokenFormatter.format(tokens);
}

export function formatCost(cost: number | null | undefined): string {
  return `$${cost == null ? "—" : formatTokens(cost)}`;
}

export function formatTokenCost(tokens: number, cost: number | null | undefined): string {
  return `${formatTokens(tokens)} | ${formatCost(cost)}`;
}

export function formatUsageBreakdown(tokens: number, cachedTokens: number | null): string {
  if (cachedTokens === null) return "缓存明细未提供";
  const percent = percentFormatter.format(tokens > 0 ? cachedTokens / tokens : 0);
  return `缓存 ${formatTokens(cachedTokens)}，新增 ${formatTokens(tokens - cachedTokens)}，缓存 ${percent}`;
}

export function usageForModel(
  snapshot: ModelUsageSnapshot,
  model: Pick<ModelStatus, "id" | "name">,
) {
  const aliases = new Set([normalizeUsageModel(model.id), normalizeUsageModel(model.name)]);
  return snapshot.models.reduce<ModelUsageTotals>(
    (total, usage) =>
      aliases.has(normalizeUsageModel(usage.model))
        ? {
            todayTokens: total.todayTokens + usage.todayTokens,
            weekTokens: total.weekTokens + usage.weekTokens,
            todayCost:
              total.todayCost !== null && usage.todayCost != null
                ? total.todayCost + usage.todayCost
                : null,
            weekCost:
              total.weekCost !== null && usage.weekCost != null
                ? total.weekCost + usage.weekCost
                : null,
            todayCachedTokens:
              total.todayCachedTokens !== null && usage.todayCachedTokens != null
                ? total.todayCachedTokens + usage.todayCachedTokens
                : null,
            weekCachedTokens:
              total.weekCachedTokens !== null && usage.weekCachedTokens != null
                ? total.weekCachedTokens + usage.weekCachedTokens
                : null,
          }
        : total,
    {
      todayTokens: 0,
      weekTokens: 0,
      todayCost: 0,
      weekCost: 0,
      todayCachedTokens: 0,
      weekCachedTokens: 0,
    },
  );
}
