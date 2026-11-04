import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { findSessionFile } from "./session-usage-file.js";

export interface ChildResult {
  turnId: string;
  text?: string;
  state: "completed" | "canceled" | "failed";
}

// ACP load currently replays the spawn but omits the child's transcript. Read
// only lifecycle/results from that explicitly referenced child's local rollout;
// never resume another writer or replay inherited prompts/system instructions.
export async function readChildResults(
  nativeId: string,
  parentNativeId: string,
  env: NodeJS.ProcessEnv,
): Promise<ChildResult[]> {
  const root = resolve(env.TRAECLI_HOME || join(env.TRAE_HOME || join(homedir(), ".trae"), "cli"));
  const path =
    (await findSessionFile(join(root, "sessions"), nativeId)) ??
    (await findSessionFile(join(root, "archived_sessions"), nativeId));
  if (!path) return [];
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let readError: Error | undefined;
  stream.on("error", (error) => {
    readError = error;
    lines.close();
  });
  let identified = false;
  const results = new Map<string, ChildResult>();
  try {
    for await (const line of lines) {
      const type = /"type"\s*:\s*"([^"]+)"/.exec(line.slice(0, 250))?.[1];
      if (type !== "session_meta" && type !== "event_msg") continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const p = record.payload;
      if (type === "session_meta") {
        if (
          p?.id !== nativeId ||
          p?.source?.subagent?.thread_spawn?.parent_thread_id !== parentNativeId
        )
          return [];
        identified = true;
      }
      if (!identified || type !== "event_msg" || typeof p?.turn_id !== "string") continue;
      if (p.type === "task_started")
        results.set(p.turn_id, { turnId: p.turn_id, state: "canceled" });
      if (p.type === "task_complete")
        results.set(p.turn_id, {
          turnId: p.turn_id,
          state: "completed",
          ...(typeof p.last_agent_message === "string" ? { text: p.last_agent_message } : {}),
        });
      if (p.type === "turn_aborted")
        results.set(p.turn_id, { turnId: p.turn_id, state: "canceled" });
    }
    if (readError) throw readError;
    return [...results.values()];
  } finally {
    lines.close();
    stream.destroy();
  }
}
