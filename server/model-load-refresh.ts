import { execCommand } from "@getpaseo/plugin/server";
import type { ProviderModel } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import type { RpcOutput } from "@getpaseo/plugin";
import type { getModelStatus, ModelStatus } from "../shared/model-status.js";
import { modelStatusLabel, parseModelStatus } from "./model-status.js";

const modelsSchema = z.array(
  z.object({
    config_name: z.string().optional(),
    name: z.string(),
    _meta: z.unknown().optional(),
  }),
);

interface ModelLoadRefreshOptions {
  command: string | (() => string);
  args?: string[];
  env: NodeJS.ProcessEnv;
  intervalMs?: number;
}

export class TraeModelLoadRefresh {
  private readonly listeners = new Set<() => void>();
  private labels = new Map<string, string>();
  private statuses: ModelStatus[] = [];
  private startupModels: string[] = [];
  private signature = "";
  private refreshedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<boolean> | null = null;
  private abort: AbortController | null = null;
  private readonly intervalMs: number;
  private disposed = false;

  constructor(private readonly options: ModelLoadRefreshOptions) {
    this.intervalMs = options.intervalMs ?? 30_000;
  }

  apply(models: readonly ProviderModel[]): readonly ProviderModel[] {
    return models.map((model) => {
      const label = this.labels.get(model.id);
      return label === undefined ? model : { ...model, label };
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.schedule();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size !== 0) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.abort?.abort();
    };
  }

  refresh(): Promise<boolean> {
    if (this.disposed) return Promise.reject(new Error("Model status service is closed"));
    if (this.pending) return this.pending;
    if (this.refreshedAt !== null && Date.now() - this.refreshedAt < this.intervalMs) {
      return Promise.resolve(false);
    }
    this.abort = new AbortController();
    this.pending = this.read(this.abort.signal).finally(() => {
      this.pending = null;
      this.abort = null;
    });
    return this.pending;
  }

  async getStatus(): Promise<RpcOutput<typeof getModelStatus>> {
    let refreshError: string | null = null;
    try {
      await this.refresh();
    } catch {
      // Keep the last good snapshot. CLI stderr can contain host-local details;
      // the panel only needs to know whether it is displaying stale data.
      refreshError = "模型状态读取失败，请检查 daemon 上的 TRAE CLI 登录和连接后重试。";
    }
    return {
      models: this.statuses.map((model) => ({ ...model })),
      refreshedAt: this.refreshedAt,
      refreshError,
    };
  }

  async fallbackModel(unavailableModel: string): Promise<string | undefined> {
    await this.refresh();
    return this.startupModels.find((id) => id !== unavailableModel);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
  }

  private async read(signal: AbortSignal): Promise<boolean> {
    const command =
      typeof this.options.command === "string" ? this.options.command : this.options.command();
    const cli = await execCommand(command, this.options.args ?? ["models", "--json"], {
      env: this.options.env,
      signal,
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (signal.aborted) throw new Error("TRAE model status read aborted");
    const models = modelsSchema.parse(JSON.parse(cli.stdout));
    this.startupModels = models.flatMap((model) => {
      const id = model.config_name?.trim();
      const status = parseModelStatus(id ?? model.name, model.name, model._meta);
      return id && status.weeklyQuotaRemainingPercent !== 0 ? [id] : [];
    });
    // Quota-depleted rows omit config_name. Their names can still exactly match
    // an existing ACP model ID; apply() only updates models ACP already exposes.
    const labels = new Map<string, string>();
    const statuses = new Map<string, ModelStatus>();
    for (const model of models) {
      const id = model.config_name ?? model.name;
      labels.set(id, modelStatusLabel(model.name, model._meta));
      statuses.set(id, parseModelStatus(id, model.name, model._meta));
    }
    const signature = JSON.stringify(
      [...labels].toSorted(([left], [right]) => left.localeCompare(right)),
    );
    this.refreshedAt = Date.now();
    this.statuses = [...statuses.values()];
    if (signature === this.signature) return false;
    this.labels = labels;
    this.signature = signature;
    for (const listener of this.listeners) listener();
    return true;
  }

  private schedule(): void {
    const remaining =
      this.refreshedAt === null ? 0 : this.intervalMs - (Date.now() - this.refreshedAt);
    const delay = remaining > 0 ? remaining : this.intervalMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh()
        .catch((error: unknown) => {
          if (this.listeners.size) console.warn("TRAE model load refresh failed", error);
        })
        .finally(() => {
          if (this.listeners.size) this.schedule();
        });
    }, delay);
    this.timer.unref();
  }
}
