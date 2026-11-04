import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const workspaceId = z.string().min(1).max(200);
const providerHandleId = z.string().min(1).max(4096);

export const workspaceImportEntrySchema = z.object({
  providerHandleId,
  title: z.string().nullable(),
  preview: z.string().nullable(),
  lastActivityAt: z.string(),
});
export type WorkspaceImportEntry = z.output<typeof workspaceImportEntrySchema>;

export const listWorkspaceImports = defineRpc({
  name: "sessions.list",
  input: z.object({
    workspaceId,
    query: z.string().max(200).default(""),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({
    workspaceId,
    directory: z.string(),
    entries: z.array(workspaceImportEntrySchema),
    filteredAlreadyImportedCount: z.number(),
    errors: z.array(z.string()),
  }),
});

export const importIntoWorkspace = defineRpc({
  name: "sessions.import",
  input: z.object({ workspaceId, providerHandleId }),
  output: z.object({ agentId: z.string(), workspaceId, cwd: z.string() }),
});
