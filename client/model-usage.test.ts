import { describe, expect, it } from "vitest";
import type { ModelUsageSnapshot } from "../shared/model-usage.js";
import { formatCost, formatTokenCost, formatUsageBreakdown, usageForModel } from "./model-usage.js";

describe("model usage breakdown", () => {
  it.each([
    [48_200_000, 45_600_000, "缓存 45.6M，新增 2.6M，缓存 94.6%"],
    [0, 0, "缓存 0，新增 0，缓存 0%"],
    [100, 0, "缓存 0，新增 100，缓存 0%"],
    [100, 100, "缓存 100，新增 0，缓存 100%"],
    [100, null, "缓存明细未提供"],
  ])("formats %s total and %s cached tokens", (total, cached, expected) => {
    expect(formatUsageBreakdown(total, cached)).toBe(expected);
  });

  it("combines cache counts for model aliases before calculating the percentage", () => {
    const snapshot: ModelUsageSnapshot = {
      models: [
        {
          model: "alder",
          todayTokens: 200,
          weekTokens: 400,
          todayCachedTokens: 100,
          weekCachedTokens: 200,
        },
        {
          model: "alder__max",
          todayTokens: 800,
          weekTokens: 1600,
          todayCachedTokens: 700,
          weekCachedTokens: 1400,
        },
      ],
      todayStart: 0,
      weekStart: 0,
      timeZone: "UTC",
      refreshedAt: 0,
    };
    const model = { id: "alder__max", name: "Alder" };
    const usage = usageForModel(snapshot, model);
    expect(usage).toEqual({
      todayTokens: 1000,
      weekTokens: 2000,
      todayCost: null,
      weekCost: null,
      todayCachedTokens: 800,
      weekCachedTokens: 1600,
    });
    expect(formatUsageBreakdown(usage.todayTokens, usage.todayCachedTokens)).toBe(
      "缓存 800，新增 200，缓存 80%",
    );
    delete snapshot.models[1].weekCachedTokens;
    expect(usageForModel(snapshot, model).weekCachedTokens).toBeNull();
    snapshot.models[0].todayCost = 12.2;
    snapshot.models[1].todayCost = 38;
    expect(usageForModel(snapshot, model).todayCost).toBe(50.2);
    delete snapshot.models[1].todayCost;
    expect(usageForModel(snapshot, model).todayCost).toBeNull();
  });

  it.each([
    [728_410, 50.2, "728.41K | $50.2"],
    [1_234_567, 1_234.567, "1.23M | $1.23K"],
    [0, 0, "0 | $0"],
    [100, null, "100 | $—"],
    [100, undefined, "100 | $—"],
    [100, 0.005, "100 | $0.01"],
  ])("uses the token formatter for cost: %s, %s", (tokens, cost, expected) => {
    expect(formatTokenCost(tokens, cost)).toBe(expected);
    expect(formatCost(cost)).toBe(expected.split(" | ")[1]);
  });
});
