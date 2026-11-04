import { z } from "zod";

export const queueStatusKind = "trae-queue-status";
export const queueStatusPluginId = "trae-queue-status";

export const queueStatusSchema = z.object({
  message: z.string(),
  state: z.string().nullable(),
  position: z.number().nullable(),
  active: z.boolean(),
});
