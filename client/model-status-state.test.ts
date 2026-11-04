import { describe, expect, it } from "vitest";
import type { ModelStatus } from "../shared/model-status.js";
import type { ModelUsageSnapshot } from "../shared/model-usage.js";
import {
  defaultModelStatusPanelState,
  modelSortDirection,
  modelStatusPanelStateSchema,
  selectModels,
  toggleModelSort,
  type ModelStatusPanelState,
} from "./model-status-state.js";

const models: ModelStatus[] = [
  {
    id: "alder",
    name: "Alder",
    loadPercent: 20,
    weeklyQuotaApplies: true,
    weeklyQuotaRemainingPercent: 30,
  },
  {
    id: "birch",
    name: "Birch",
    loadPercent: 100,
    weeklyQuotaApplies: true,
    weeklyQuotaRemainingPercent: 0,
  },
  {
    id: "cedar",
    name: "Cedar",
    loadPercent: 75,
    weeklyQuotaApplies: true,
    weeklyQuotaRemainingPercent: 90,
  },
  {
    id: "unknown",
    name: "Unknown",
    loadPercent: null,
    weeklyQuotaApplies: false,
    weeklyQuotaRemainingPercent: null,
  },
];
const usage: ModelUsageSnapshot = {
  models: [
    { model: "alder", todayTokens: 11, weekTokens: 901 },
    { model: "birch", todayTokens: 80, weekTokens: 101 },
    { model: "cedar", todayTokens: 31, weekTokens: 401 },
  ],
  todayStart: 0,
  weekStart: 0,
  timeZone: "Asia/Shanghai",
  refreshedAt: 0,
};
const cases: {
  sort: ModelStatusPanelState["sort"];
  asc: string[];
  desc: string[];
  legacy: "asc" | "desc";
}[] = [
  {
    sort: "name",
    asc: ["alder", "birch", "cedar", "unknown"],
    desc: ["unknown", "cedar", "birch", "alder"],
    legacy: "asc",
  },
  {
    sort: "load",
    asc: ["alder", "cedar", "birch", "unknown"],
    desc: ["birch", "cedar", "alder", "unknown"],
    legacy: "asc",
  },
  {
    sort: "quota",
    asc: ["birch", "alder", "cedar", "unknown"],
    desc: ["cedar", "alder", "birch", "unknown"],
    legacy: "desc",
  },

  {
    sort: "today",
    asc: ["unknown", "alder", "cedar", "birch"],
    desc: ["birch", "cedar", "alder", "unknown"],
    legacy: "desc",
  },
  {
    sort: "week",
    asc: ["unknown", "birch", "cedar", "alder"],
    desc: ["alder", "cedar", "birch", "unknown"],
    legacy: "desc",
  },
];
const ids = (state: ModelStatusPanelState, snapshot: ModelUsageSnapshot | null = usage) =>
  selectModels(models, state, snapshot).map((model) => model.id);

describe("model table sorting", () => {
  for (const item of cases) {
    it.each(["asc", "desc"] as const)(
      `sorts ${item.sort} %s with unknown metrics last`,
      (sortDirection) => {
        expect(ids({ ...defaultModelStatusPanelState, sort: item.sort, sortDirection })).toEqual(
          item[sortDirection],
        );
        expect(models.map((model) => model.id)).toEqual(["alder", "birch", "cedar", "unknown"]);
      },
    );

    it(`restores legacy ${item.sort} settings without resetting search or filter`, () => {
      const saved = modelStatusPanelStateSchema.parse({
        query: "",
        filter: "all",
        sort: item.sort,
      });
      expect(modelSortDirection(saved)).toBe(item.legacy);
      expect(ids(saved)).toEqual(item[item.legacy]);
    });
  }

  it("toggles the selected column and preserves other tab settings when changing columns", () => {
    const before = { ...defaultModelStatusPanelState, query: "cedar", filter: "quota" as const };
    const descending = toggleModelSort(before, "load");
    expect(descending.sortDirection).toBe("desc");
    expect(toggleModelSort(descending, "load").sortDirection).toBe("asc");
    expect(toggleModelSort(descending, "today")).toEqual({
      ...before,
      sort: "today",
      sortDirection: "desc",
    });
    expect(toggleModelSort(descending, "name")).toEqual({
      ...before,
      sort: "name",
      sortDirection: "asc",
    });
    expect(before.sortDirection).toBe("asc");
    expect(ids(descending)).toEqual(["cedar"]);
  });

  it("compares exact usage counts and combines Standard and Max records", () => {
    const snapshot = {
      ...usage,
      models: [
        { model: "alder", todayTokens: 600, weekTokens: 600 },
        { model: "alder__max", todayTokens: 402, weekTokens: 402 },
        { model: "birch", todayTokens: 1001, weekTokens: 1001 },
      ],
    };
    expect(
      ids({ ...defaultModelStatusPanelState, sort: "today", sortDirection: "desc" }, snapshot),
    ).toEqual(["alder", "birch", "cedar", "unknown"]);
  });

  it("keeps metric ties in a stable name and ID order in both directions", () => {
    const tied = [
      { ...models[0]!, id: "b", name: "Same" },
      { ...models[0]!, id: "a", name: "Same" },
      { ...models[3]!, id: "missing", name: "First alphabetically" },
    ];
    for (const sortDirection of ["asc", "desc"] as const) {
      expect(
        selectModels(tied, { ...defaultModelStatusPanelState, sortDirection }).map(
          (model) => model.id,
        ),
      ).toEqual(["a", "b", "missing"]);
    }
  });

  it("retains filtering and handles unavailable usage in either direction", () => {
    for (const sortDirection of ["asc", "desc"] as const) {
      expect(ids({ ...defaultModelStatusPanelState, sort: "today", sortDirection }, null)).toEqual([
        "alder",
        "birch",
        "cedar",
        "unknown",
      ]);
      expect(ids({ ...defaultModelStatusPanelState, filter: "busy", sortDirection })).toEqual([
        "birch",
      ]);
      expect(
        ids({ ...defaultModelStatusPanelState, filter: "quota", sortDirection }),
      ).not.toContain("unknown");
    }
  });
});
