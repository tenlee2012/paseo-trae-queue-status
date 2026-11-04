import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RpcOutput } from "@getpaseo/plugin";
import type { getModelUsage, ModelUsageSnapshot } from "../shared/model-usage.js";
import { UsageRollout, usageModel } from "./usage-rollout.js";
import { addCosts, emptyPriceCatalog, type ModelPricingSource } from "./model-pricing.js";

interface CachedFile {
  ino: number;
  size: number;
  mtimeMs: number;
  offset: number;
  anchor: Buffer;
  rollout: UsageRollout;
}

interface UsageOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  intervalMs?: number;
  pricing?: ModelPricingSource;
}

export function usagePeriods(now: number) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const week = new Date(today);
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
  return {
    todayStart: today.getTime(),
    weekStart: week.getTime(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export class TraeModelUsage {
  private readonly root: string;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly pricing?: ModelPricingSource;
  private files = new Map<string, CachedFile>();
  private snapshot: ModelUsageSnapshot | null = null;
  private pending: Promise<RpcOutput<typeof getModelUsage>> | null = null;
  private abort = new AbortController();

  constructor(options: UsageOptions = {}) {
    const env = options.env ?? process.env;
    this.root = resolve(
      env.TRAECLI_HOME || join(env.TRAE_HOME || join(options.home ?? homedir(), ".trae"), "cli"),
    );
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 30_000;
    this.pricing = options.pricing;
  }

  getStatus(): Promise<RpcOutput<typeof getModelUsage>> {
    if (this.pending) return this.pending;
    const now = this.now();
    const periods = usagePeriods(now);
    if (
      this.snapshot &&
      this.snapshot.todayStart === periods.todayStart &&
      this.snapshot.weekStart === periods.weekStart &&
      now - this.snapshot.refreshedAt < this.intervalMs
    ) {
      return Promise.resolve({ snapshot: this.snapshot, refreshError: null });
    }
    this.pending = this.read(now).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  dispose(): void {
    this.abort.abort();
    this.files.clear();
  }

  private async read(now: number): Promise<RpcOutput<typeof getModelUsage>> {
    const periods = usagePeriods(now);
    try {
      this.assertOpen();
      // A missing CLI home is not evidence of zero usage.
      await stat(this.root);
      const paths = [
        ...(await rolloutPaths(join(this.root, "sessions"))),
        ...(await rolloutPaths(join(this.root, "archived_sessions"))),
      ];
      const present = new Set(paths);
      for (const path of this.files.keys()) if (!present.has(path)) this.files.delete(path);
      let index = 0;
      // Limit filesystem concurrency on hosts with many saved sessions.
      const reads = await Promise.allSettled(
        Array.from({ length: 8 }, async () => {
          while (index < paths.length) {
            this.assertOpen();
            const path = paths[index++];
            try {
              // Each of the eight workers reads one file at a time.
              // oxlint-disable-next-line no-await-in-loop
              await this.readFile(path, periods.weekStart);
            } catch (error) {
              if (isMissing(error))
                this.files.delete(path); // Archived/deleted during scan.
              else throw error;
            }
          }
        }),
      );
      const failure = reads.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      const prices = (await this.pricing?.getCatalog()) ?? emptyPriceCatalog;
      this.assertOpen();
      const models = new Map<string, ModelUsageSnapshot["models"][number]>();
      const seen = new Set<string>();
      for (const file of this.files.values()) {
        file.rollout.prune(periods.weekStart);
        for (const event of file.rollout.events.values()) {
          if (event.timestamp < periods.weekStart || event.timestamp > now || seen.has(event.key))
            continue;
          seen.add(event.key);
          const model = usageModel(event);
          const usage = models.get(model) ?? {
            model,
            todayTokens: 0,
            weekTokens: 0,
            todayCost: 0,
            weekCost: 0,
            todayCachedTokens: 0,
            weekCachedTokens: 0,
          };
          usage.weekTokens += event.tokens;
          const cost = prices.cost(event);
          usage.weekCost = addCosts(usage.weekCost, cost);
          usage.weekCachedTokens =
            usage.weekCachedTokens != null && event.cachedTokens !== null
              ? usage.weekCachedTokens + event.cachedTokens
              : null;
          if (event.timestamp >= periods.todayStart) {
            usage.todayTokens += event.tokens;
            usage.todayCost = addCosts(usage.todayCost, cost);
            usage.todayCachedTokens =
              usage.todayCachedTokens != null && event.cachedTokens !== null
                ? usage.todayCachedTokens + event.cachedTokens
                : null;
          }
          models.set(model, usage);
        }
      }
      this.snapshot = { models: [...models.values()], ...periods, refreshedAt: now };
      return { snapshot: this.snapshot, refreshError: null };
    } catch {
      // Do not expose host paths or conversation contents through an error.
      const snapshot =
        this.snapshot?.todayStart === periods.todayStart &&
        this.snapshot?.weekStart === periods.weekStart
          ? this.snapshot
          : null;
      return {
        snapshot,
        refreshError: "本机用量读取失败，请检查 TRAE CLI 会话记录是否可读且包含完整用量数据。",
      };
    }
  }

  private assertOpen(): void {
    if (this.abort.signal.aborted) throw new Error("Usage service is closed");
  }

  private async readFile(path: string, since: number): Promise<void> {
    const info = await stat(path);
    if (info.mtimeMs < since) {
      this.files.delete(path);
      return;
    }
    const previous = this.files.get(path);
    if (
      previous?.size === info.size &&
      previous.mtimeMs === info.mtimeMs &&
      previous.ino === info.ino
    )
      return;
    let append = previous && previous.ino === info.ino && info.size > previous.size;
    if (append && previous) {
      const handle = await open(path, "r");
      try {
        const bytes = Buffer.alloc(previous.anchor.length);
        await handle.read(bytes, 0, bytes.length, previous.offset - bytes.length);
        append = bytes.equals(previous.anchor);
      } finally {
        await handle.close();
      }
    }
    const file: CachedFile =
      append && previous
        ? { ...previous, rollout: previous.rollout.clone() }
        : {
            ino: info.ino,
            size: 0,
            mtimeMs: 0,
            offset: 0,
            anchor: Buffer.alloc(0),
            rollout: new UsageRollout(path),
          };
    if (info.size > file.offset) {
      const stream = createReadStream(path, {
        start: file.offset,
        end: info.size - 1,
        signal: this.abort.signal,
      });
      let remainder = Buffer.alloc(0);
      for await (const chunk of stream) {
        const buffer = Buffer.concat([remainder, chunk]);
        let start = 0;
        let newline: number;
        while ((newline = buffer.indexOf(10, start)) !== -1) {
          file.rollout.consume(buffer.toString("utf8", start, newline), since);
          file.offset += newline + 1 - start;
          file.anchor = Buffer.from(
            buffer.subarray(Math.max(start, newline + 1 - 64), newline + 1),
          );
          start = newline + 1;
        }
        // The last line may still be being written. Re-read it on the next scan.
        remainder = buffer.subarray(start);
      }
    }
    this.files.set(path, { ...file, size: info.size, mtimeMs: info.mtimeMs });
  }
}

async function rolloutPaths(directory: string): Promise<string[]> {
  try {
    const paths: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.name.endsWith(".artifacts")) {
        // Keep directory traversal bounded as well as file reads.
        // oxlint-disable-next-line no-await-in-loop
        paths.push(...(await rolloutPaths(path)));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(path);
    }
    return paths;
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
