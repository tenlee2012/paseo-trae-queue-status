import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

export const turnUsageKind = "trae-turn-usage";
export const turnUsageSchema = z.object({
  state: z.enum(["pending", "ready", "unavailable"]),
  outcome: z.enum(["completed", "failed", "canceled"]),
  cost: z.number().finite().nonnegative().nullable().optional(),
  source: z
    .object({
      sessionId: z.string().min(1),
      turnIds: z.array(z.string().min(1)).min(1).max(64),
    })
    .optional(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  cacheCreationInputTokens: z.number().int().nonnegative().nullable().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().nullable().optional(),
  reasoningCount: z.number().int().nonnegative().nullable().optional(),
  modelCallCount: z.number().int().nonnegative().nullable().optional(),
  toolCallCount: z.number().int().nonnegative().nullable().optional(),
});

export type TurnUsageData = z.output<typeof turnUsageSchema>;

export const getTurnCost = defineRpc({
  name: "turns.cost",
  input: z.object({
    agentId: z.string().min(1),
    timestamp: z.number().finite().nonnegative(),
    usage: turnUsageSchema,
  }),
  output: z.object({ cost: z.number().finite().nonnegative().nullable() }),
});
