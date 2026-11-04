import { z } from "zod";
import type { ModelStatus } from "../shared/model-status.js";
import type { ModelUsageSnapshot } from "../shared/model-usage.js";
import { usageForModel } from "./model-usage.js";

export const modelStatusPanelStateSchema = z.object({
  query: z.string().max(200),
  filter: z.enum(["all", "busy", "quota"]),
  sort: z.enum(["name", "load", "quota", "today", "week"]),
  // Older tabs only stored the column. Keep their original sort direction.
  sortDirection: z.enum(["asc", "desc"]).optional(),
});

export type ModelStatusPanelState = z.output<typeof modelStatusPanelStateSchema>;

export const defaultModelStatusPanelState: ModelStatusPanelState = {
  query: "",
  filter: "all",
  sort: "load",
  sortDirection: "asc",
};

export function modelSortDirection(state: ModelStatusPanelState): "asc" | "desc" {
  return state.sortDirection ?? (state.sort === "name" || state.sort === "load" ? "asc" : "desc");
}

export function toggleModelSort(
  state: ModelStatusPanelState,
  sort: ModelStatusPanelState["sort"],
): ModelStatusPanelState {
  return {
    ...state,
    sort,
    sortDirection:
      state.sort === sort
        ? modelSortDirection(state) === "asc"
          ? "desc"
          : "asc"
        : modelSortDirection({ ...state, sort, sortDirection: undefined }),
  };
}

function compareMetric(
  left: number | null | undefined,
  right: number | null | undefined,
  direction: "asc" | "desc",
) {
  // Unknown values stay last in either direction, rather than becoming zero.
  if (left == null) return right == null ? 0 : 1;
  if (right == null) return -1;
  return (left - right) * (direction === "asc" ? 1 : -1);
}

export function selectModels(
  models: readonly ModelStatus[],
  state: ModelStatusPanelState,
  usageSnapshot?: ModelUsageSnapshot | null,
): ModelStatus[] {
  const query = state.query.trim().toLowerCase();
  const direction = modelSortDirection(state);
  const usage = new Map(
    usageSnapshot
      ? models.map((model) => [model.id, usageForModel(usageSnapshot, model)] as const)
      : [],
  );
  return (
    models
      .filter((model) => {
        if (!`${model.name}\n${model.id}`.toLowerCase().includes(query)) return false;
        if (state.filter === "busy") return model.loadPercent !== null && model.loadPercent >= 100;
        if (state.filter === "quota") return model.weeklyQuotaApplies;
        return true;
      })
      // filter creates a new array; sort keeps the input intact and supports mobile Hermes.
      // oxlint-disable-next-line unicorn/no-array-sort
      .sort((left, right) => {
        const name = left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
        if (state.sort === "name") return name * (direction === "asc" ? 1 : -1);
        if (state.sort === "load")
          return compareMetric(left.loadPercent, right.loadPercent, direction) || name;
        if (state.sort === "quota")
          return (
            compareMetric(
              left.weeklyQuotaRemainingPercent,
              right.weeklyQuotaRemainingPercent,
              direction,
            ) || name
          );
        if (state.sort === "today" || state.sort === "week") {
          const key = state.sort === "today" ? "todayTokens" : "weekTokens";
          return (
            compareMetric(usage.get(left.id)?.[key], usage.get(right.id)?.[key], direction) || name
          );
        }
        return name;
      })
  );
}
