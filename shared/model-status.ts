import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const modelStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  loadPercent: z.number().nonnegative().nullable(),
  weeklyQuotaApplies: z.boolean(),
  weeklyQuotaRemainingPercent: z.number().min(0).max(100).nullable(),
});

export type ModelStatus = z.output<typeof modelStatusSchema>;

export const getModelStatus = defineRpc({
  name: "models.status",
  input: z.object({}),
  output: z.object({
    models: z.array(modelStatusSchema),
    refreshedAt: z.number().nullable(),
    refreshError: z.string().nullable(),
  }),
});
