import { createReadStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface TurnCallCounts {
  startedAt: number;
  complete: boolean;
  modelCallCount: number;
  toolCallCount: number;
}

interface Calls {
  startedAt?: number;
  complete: boolean;
  models: Set<string>;
  tools: Set<string>;
}

interface TraceFile {
  nativeId: string;
  offset: number;
  ino: number;
  turns: Map<string, Calls>;
}

// ACP omits code-mode exec wrappers and some nested tools. Count the native
// dispatch events instead of visible thoughts, tool titles, or JS source text.
// TRAE CLI 0.214.1 trace bundle schema 1, verified with a local fixture provider.
export class TraeCallCounts {
  private readonly files = new Map<string, TraceFile>();
  private readonly abort = new AbortController();
  private readonly pending = new Map<string, Promise<Map<string, TurnCallCounts> | null>>();
  private cleanup?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;

  private constructor(
    readonly env: NodeJS.ProcessEnv,
    private readonly root: string | null,
    private readonly owned: boolean,
  ) {
    if (owned) {
      // Native tracing also writes raw payloads. We never read those files and
      // discard them promptly; the private temporary bundle is removed on close.
      this.timer = setInterval(() => {
        this.cleanup ??= this.discardPayloads().finally(() => (this.cleanup = undefined));
      }, 1_000);
      this.timer.unref();
    }
  }

  static async create(env: NodeJS.ProcessEnv): Promise<TraeCallCounts> {
    if (env.TRAECLI_ROLLOUT_TRACE_ROOT)
      return new TraeCallCounts(env, resolve(env.TRAECLI_ROLLOUT_TRACE_ROOT), false);
    try {
      const root = await mkdtemp(join(tmpdir(), "paseo-trae-call-counts-"));
      return new TraeCallCounts({ ...env, TRAECLI_ROLLOUT_TRACE_ROOT: root }, root, true);
    } catch {
      // Missing optional diagnostics must never prevent a conversation.
      return new TraeCallCounts(env, null, false);
    }
  }

  read(nativeId: string): Promise<Map<string, TurnCallCounts> | null> {
    const pending = this.pending.get(nativeId);
    if (pending) return pending;
    const task = this.readSession(nativeId).catch(() => null);
    this.pending.set(nativeId, task);
    void task.finally(() => this.pending.delete(nativeId));
    return task;
  }

  forget(nativeId: string, turnIds: Set<string>): void {
    for (const file of this.files.values()) {
      if (file.nativeId !== nativeId) continue;
      for (const id of turnIds) file.turns.delete(id);
    }
  }

  async dispose(): Promise<void> {
    this.abort.abort();
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.pending.values(), this.cleanup]);
    this.files.clear();
    if (this.owned && this.root) await rm(this.root, { recursive: true, force: true });
  }

  private async readSession(nativeId: string): Promise<Map<string, TurnCallCounts> | null> {
    if (!this.root || this.abort.signal.aborted) return null;
    const bundles = (await readdir(this.root, { withFileTypes: true })).filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith("trace-") &&
        entry.name.endsWith(`-${nativeId}`),
    );
    const result = new Map<string, TurnCallCounts>();
    for (const bundle of bundles) {
      const directory = join(this.root, bundle.name);
      // oxlint-disable-next-line no-await-in-loop
      const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
      if (manifest.schema_version !== 1 || manifest.root_thread_id !== nativeId) continue;
      const path = join(directory, "trace.jsonl");
      // oxlint-disable-next-line no-await-in-loop
      const info = await stat(path);
      let file = this.files.get(path);
      if (!file) {
        file = { nativeId, offset: 0, ino: info.ino, turns: new Map() };
        this.files.set(path, file);
      }
      if (file.ino !== info.ino || info.size < file.offset) throw new Error("Call trace changed");
      if (info.size > file.offset) {
        // oxlint-disable-next-line no-await-in-loop
        await this.readFile(path, file, info.size, nativeId);
      }
      for (const [turnId, calls] of file.turns) {
        if (calls.startedAt === undefined) continue;
        // More than one trace claiming the same native turn is ambiguous.
        if (result.has(turnId)) return null;
        result.set(turnId, {
          startedAt: calls.startedAt,
          complete: calls.complete,
          modelCallCount: calls.models.size,
          toolCallCount: calls.tools.size,
        });
      }
    }
    return result.size ? result : null;
  }

  private async readFile(path: string, file: TraceFile, size: number, nativeId: string) {
    const stream = createReadStream(path, {
      start: file.offset,
      end: size - 1,
      signal: this.abort.signal,
    });
    let remainder = Buffer.alloc(0);
    for await (const chunk of stream) {
      const buffer = Buffer.concat([remainder, chunk]);
      let start = 0;
      let newline: number;
      while ((newline = buffer.indexOf(10, start)) !== -1) {
        const record = JSON.parse(buffer.toString("utf8", start, newline));
        if (record.schema_version !== 1) throw new Error("Unsupported call trace");
        if (record.thread_id === nativeId && typeof record.codex_turn_id === "string") {
          let calls = file.turns.get(record.codex_turn_id);
          if (!calls) {
            calls = { complete: false, models: new Set(), tools: new Set() };
            file.turns.set(record.codex_turn_id, calls);
          }
          const payload = record.payload;
          switch (payload?.type) {
            case "codex_turn_started":
              if (!Number.isSafeInteger(record.wall_time_unix_ms))
                throw new Error("Invalid call time");
              calls.startedAt ??= record.wall_time_unix_ms;
              break;
            case "codex_turn_ended":
              calls.complete = true;
              break;
            case "inference_started":
              calls.models.add(identity(payload.inference_call_id));
              break;
            case "tool_call_started":
              calls.tools.add(identity(payload.model_visible_call_id ?? payload.tool_call_id));
              break;
            case "code_cell_started":
              // exec is represented as a code cell rather than a tool dispatch.
              // Its model-visible call ID also deduplicates resumed/yielded cells.
              calls.tools.add(identity(payload.model_visible_call_id));
              break;
          }
        }
        file.offset += newline + 1 - start;
        start = newline + 1;
      }
      remainder = buffer.subarray(start);
      if (remainder.length > 4 * 1024 * 1024) throw new Error("Call trace record is too large");
    }
  }

  private async discardPayloads(): Promise<void> {
    try {
      const bundles = await readdir(this.root!, { withFileTypes: true });
      for (const bundle of bundles) {
        if (!bundle.isDirectory() || !bundle.name.startsWith("trace-")) continue;
        const directory = join(this.root!, bundle.name, "payloads");
        // oxlint-disable-next-line no-await-in-loop
        const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          // oxlint-disable-next-line no-await-in-loop
          await rm(join(directory, entry.name), { force: true });
        }
      }
    } catch {
      // The whole owned directory is still removed after the CLI has stopped.
    }
  }
}

function identity(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Missing native call identity");
  return value;
}
