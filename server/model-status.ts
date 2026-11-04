import { z } from "zod";
import type { ModelStatus } from "../shared/model-status.js";

const loadMetadataSchema = z.object({
  trae: z.object({
    load: z.object({ percent: z.number().nonnegative() }),
  }),
});

const quotaMetadataSchema = z.object({
  trae: z.object({
    weeklyQuota: z.object({
      applies: z.literal(true),
      isDepleted: z.boolean().optional(),
      remainingPercent: z.number().min(0).max(100).optional(),
      usedPercent: z.number().min(0).max(100).optional(),
    }),
  }),
});

export function modelStatusLabel(name: string, metadata: unknown): string {
  const status = parseModelStatus(name, name, metadata);
  let label = name;
  if (status.loadPercent !== null) {
    const percent = status.loadPercent;
    const indicator = percent > 150 ? "🔴" : percent >= 100 ? "🟡" : "🟢";
    label += ` ${indicator} ${percent}%`;
  }
  if (status.weeklyQuotaRemainingPercent !== null)
    label += ` · 周剩余 ${status.weeklyQuotaRemainingPercent}%`;
  return label;
}

export function parseModelStatus(
  id: string,
  name: string,
  metadata: unknown,
): ModelStatus {
  const load = loadMetadataSchema.safeParse(metadata);
  const parsed = quotaMetadataSchema.safeParse(metadata);
  return {
    id,
    name,
    loadPercent: load.success ? load.data.trae.load.percent : null,
    weeklyQuotaApplies: parsed.success,
    weeklyQuotaRemainingPercent: parsed.success
      ? quotaRemaining(parsed.data.trae.weeklyQuota)
      : null,
  };
}

function quotaRemaining(
  quota: z.output<typeof quotaMetadataSchema>["trae"]["weeklyQuota"],
): number | null {
  let remaining = quota.remainingPercent;
  if (quota.isDepleted) remaining = 0;
  else if (remaining === undefined && quota.usedPercent !== undefined) {
    remaining = Math.round((100 - quota.usedPercent) * 100) / 100;
  }
  return remaining ?? null;
}
