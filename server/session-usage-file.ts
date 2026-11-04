import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { UsageRollout } from "./usage-rollout.js";

// One incremental reader per native session. No global daily-usage cache and no
// conversation writes: only the selected session's usage records are parsed.
export class SessionUsageFile {
  readonly rollout: UsageRollout;
  private readonly root: string;
  private path: string | null = null;
  private ino: number | null = null;
  private offset = 0;
  private anchor = Buffer.alloc(0);
  private identified = false;

  constructor(
    private readonly sessionId: string,
    env: NodeJS.ProcessEnv,
    private readonly signal: AbortSignal,
  ) {
    this.root = resolve(env.TRAECLI_HOME || join(env.TRAE_HOME || join(homedir(), ".trae"), "cli"));
    this.rollout = new UsageRollout(sessionId);
  }

  async read(since: number): Promise<boolean> {
    if (this.signal.aborted) return false;
    if (this.path) {
      try {
        await stat(this.path);
      } catch (error) {
        if (!isMissing(error)) throw error;
        this.path = null;
      }
    }
    if (!this.path) {
      for (const directory of ["sessions", "archived_sessions"]) {
        // Only index filenames; never read unrelated conversations.
        // oxlint-disable-next-line no-await-in-loop
        this.path = await findSessionFile(join(this.root, directory), this.sessionId);
        if (this.path) break;
      }
    }
    if (!this.path) return false;
    const info = await stat(this.path);
    if ((this.ino !== null && this.ino !== info.ino) || info.size < this.offset)
      throw new Error("Session usage file changed");
    if (this.anchor.length) {
      const handle = await open(this.path, "r");
      try {
        const bytes = Buffer.alloc(this.anchor.length);
        await handle.read(bytes, 0, bytes.length, this.offset - bytes.length);
        if (!bytes.equals(this.anchor)) throw new Error("Session usage file was rewritten");
      } finally {
        await handle.close();
      }
    }
    this.ino = info.ino;
    if (info.size === this.offset) return this.identified;
    const stream = createReadStream(this.path, {
      start: this.offset,
      end: info.size - 1,
      signal: this.signal,
    });
    let remainder = Buffer.alloc(0);
    for await (const chunk of stream) {
      const buffer = Buffer.concat([remainder, chunk]);
      let start = 0;
      let newline: number;
      while ((newline = buffer.indexOf(10, start)) !== -1) {
        const line = buffer.toString("utf8", start, newline);
        if (/"type"\s*:\s*"([^"]+)"/.exec(line.slice(0, 250))?.[1] === "session_meta") {
          const record = JSON.parse(line);
          if ((record.payload?.id ?? record.payload?.session_id) !== this.sessionId)
            throw new Error("Session usage identity mismatch");
          this.identified = true;
        }
        if (this.identified) this.rollout.consume(line, since);
        this.offset += newline + 1 - start;
        this.anchor = Buffer.from(buffer.subarray(Math.max(start, newline + 1 - 64), newline + 1));
        start = newline + 1;
      }
      // Leave a partly flushed JSONL record for the next read.
      remainder = buffer.subarray(start);
    }
    return this.identified;
  }
}

export async function findSessionFile(
  directory: string,
  sessionId: string,
): Promise<string | null> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isFile() &&
        (entry.name === `${sessionId}.jsonl` || entry.name.endsWith(`-${sessionId}.jsonl`))
      )
        return join(directory, entry.name);
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.endsWith(".artifacts")) continue;
      // oxlint-disable-next-line no-await-in-loop
      const path = await findSessionFile(join(directory, entry.name), sessionId);
      if (path) return path;
    }
    return null;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
