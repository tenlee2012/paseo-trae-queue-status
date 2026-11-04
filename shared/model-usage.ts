import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export function normalizeUsageModel(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/__max$/, "");
}

export const modelUsageSnapshotSchema = z.object({
  models: z.array(
    z.object({
      model: z.string(),
      todayTokens: z.number().int().nonnegative(),
      weekTokens: z.number().int().nonnegative(),
      todayCost: z.number().finite().nonnegative().nullable().optional(),
      weekCost: z.number().finite().nonnegative().nullable().optional(),
      todayCachedTokens: z.number().int().nonnegative().nullable().optional(),
      weekCachedTokens: z.number().int().nonnegative().nullable().optional(),
    }),
  ),
  todayStart: z.number(),
  weekStart: z.number(),
  timeZone: z.string(),
  refreshedAt: z.number(),
});

export type ModelUsageSnapshot = z.output<typeof modelUsageSnapshotSchema>;

export const getModelUsage = defineRpc({
  name: "models.usage",
  input: z.object({}),
  output: z.object({
    snapshot: modelUsageSnapshotSchema.nullable(),
    refreshError: z.string().nullable(),
  }),
});
