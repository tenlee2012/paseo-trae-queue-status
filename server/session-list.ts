import { basename } from "node:path";
import type { ProviderInput, ProviderSessionSummary } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { cleanTraePrompt, isInternalTraeSession } from "./prompt-text.js";
import { TraeSessionPreviews } from "./session-previews.js";
import { canonicalSessionCwd, workspaceSessionPersistence } from "./session-persistence.js";

const pageSchema = z.object({
  sessions: z.array(
    z.object({
      sessionId: z.string().min(1),
      cwd: z.string(),
      title: z.string().nullish(),
      updatedAt: z.string().nullish(),
    }),
  ),
  nextCursor: z.string().nullish(),
});
type NativeRequest = (method: string, params: unknown) => Promise<unknown>;

export async function listTraeSessions(
  request: NativeRequest,
  input: Extract<ProviderInput, { type: "sessions" }>,
  env?: NodeJS.ProcessEnv,
): Promise<ProviderSessionSummary[]> {
  const previews = new TraeSessionPreviews(env);
  const cwd = input.cwd ? await canonicalSessionCwd(input.cwd) : undefined;
  const query = input.query?.trim().toLowerCase();
  const sessions: ProviderSessionSummary[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  const deadline = Date.now() + 60_000;
  let cursor: string | undefined;
  do {
    if (Date.now() > deadline) throw new Error("TRAE session listing timed out; narrow the search");
    // Paseo's built-in "This workspace" tab uses cwd as a source filter.
    // Match canonical directories before previews, search and the result limit;
    // keep reading pages when a page only contains other directories.
    // oxlint-disable-next-line no-await-in-loop
    const page = pageSchema.parse(await request("session/list", { cursor }));
    for (const session of page.sessions) {
      if (ids.has(session.sessionId)) continue;
      ids.add(session.sessionId);
      const title = session.title ? cleanTraePrompt(session.title) : undefined;
      if (title && isInternalTraeSession(title)) continue;
      // oxlint-disable-next-line no-await-in-loop
      const sourceCwd = await canonicalSessionCwd(session.cwd);
      if (cwd !== undefined && sourceCwd !== cwd) continue;
      // oxlint-disable-next-line no-await-in-loop
      const preview = (await previews.read(session.sessionId))?.slice(0, 1000);
      if (preview && isInternalTraeSession(preview)) continue;
      if (
        query &&
        ![title, preview, basename(session.cwd.replaceAll("\\", "/"))].some((value) =>
          value?.toLowerCase().includes(query),
        )
      )
        continue;
      sessions.push({
        persistence: workspaceSessionPersistence(
          { version: 1, data: { sessionId: session.sessionId } },
          cwd ?? sourceCwd,
        ),
        cwd: input.cwd ?? session.cwd,
        title: title || undefined,
        description: preview,
        updatedAt: session.updatedAt ?? undefined,
      });
      if (input.limit && sessions.length >= input.limit) return sessions;
    }
    cursor = page.nextCursor || undefined;
    if (cursor && cursors.has(cursor))
      throw new Error("TRAE CLI returned a repeated session cursor");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return sessions;
}
