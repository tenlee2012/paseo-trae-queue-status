import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const sessionUsageSchema = z.object({
  tokens: z.number().int().nonnegative().nullable(),
  cost: z.number().finite().nonnegative().nullable().optional(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  cacheCreationInputTokens: z.number().int().nonnegative().nullable(),
  reasoningOutputTokens: z.number().int().nonnegative().nullable(),
  refreshError: z.string().nullable(),
});

export type SessionUsageSnapshot = z.output<typeof sessionUsageSchema>;

export const emptySessionUsage: SessionUsageSnapshot = {
  tokens: null,
  cost: null,
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  cacheCreationInputTokens: null,
  reasoningOutputTokens: null,
  refreshError: null,
};

export const getSessionUsage = defineRpc({
  name: "sessions.usage",
  input: z.object({ agentId: z.string().min(1) }),
  output: sessionUsageSchema,
});
