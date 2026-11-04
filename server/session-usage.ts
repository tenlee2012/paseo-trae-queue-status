import type { PaseoApi } from "@getpaseo/client";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { emptySessionUsage, type SessionUsageSnapshot } from "../shared/session-usage.js";
import { nativeSessionIdFromHandle } from "./session-persistence.js";
import { SessionUsageFile } from "./session-usage-file.js";
import { addCosts, emptyPriceCatalog, type ModelPricingSource } from "./model-pricing.js";
import type { getTurnCost } from "../shared/turn-usage.js";
import { findTurnCostEvents } from "./turn-cost.js";

interface CachedSession {
  abort: AbortController;
  file: SessionUsageFile;
  pending?: Promise<SessionUsageSnapshot>;
  snapshot?: SessionUsageSnapshot;
  readAt: number;
}

interface SessionUsageOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  intervalMs?: number;
  maxSessions?: number;
  pricing?: ModelPricingSource;
}

const unavailable = (): SessionUsageSnapshot => ({
  ...emptySessionUsage,
  refreshError: "本机会话用量读取失败或未提供，请检查 TRAE CLI 会话记录。",
});

// Restore lifetime usage from the selected native session, independent of the
// current day/week and of the provider's short-lived per-turn trackers.
export class TraeSessionUsage {
  private readonly sessions = new Map<string, CachedSession>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly maxSessions: number;
  private readonly pricing?: ModelPricingSource;
  private disposed = false;

  constructor(options: SessionUsageOptions = {}) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 1_000;
    this.maxSessions = Math.max(1, options.maxSessions ?? 64);
    this.pricing = options.pricing;
  }

  async getStatus(paseo: PaseoApi, input: { agentId: string }): Promise<SessionUsageSnapshot> {
    if (this.disposed) return unavailable();
    try {
      const sessionId = await this.resolveSessionId(paseo, input.agentId);
      if (!sessionId) return { ...emptySessionUsage };
      return await this.read(sessionId);
    } catch {
      return unavailable();
    }
  }

  async getTurnCost(
    paseo: PaseoApi,
    input: RpcInput<typeof getTurnCost>,
  ): Promise<RpcOutput<typeof getTurnCost>> {
    const unavailableCost = { cost: null };
    if (this.disposed || input.usage.state !== "ready") return unavailableCost;
    try {
      const sessionId = await this.resolveSessionId(paseo, input.agentId);
      if (!sessionId) return unavailableCost;
      const snapshot = await this.read(sessionId);
      const session = this.sessions.get(sessionId);
      if (snapshot.refreshError || !session || session.abort.signal.aborted) return unavailableCost;
      const events = findTurnCostEvents(
        session.file.rollout,
        sessionId,
        input.usage,
        input.timestamp,
      );
      if (!events) return unavailableCost;
      const prices = (await this.pricing?.getCatalog()) ?? emptyPriceCatalog;
      if (session.abort.signal.aborted) return unavailableCost;
      return {
        cost: events.reduce<number | null>((cost, event) => addCosts(cost, prices.cost(event)), 0),
      };
    } catch {
      return unavailableCost;
    }
  }

  private async resolveSessionId(paseo: PaseoApi, agentId: string): Promise<string | undefined> {
    // Resolve paths from the daemon's agent, never a client-supplied native ID.
    const result = await paseo.agents.ref(agentId).refresh();
    const agent = result?.agent;
    if (!agent || agent.provider !== "traecli-queue" || agent.archivedAt)
      throw new Error("Session unavailable");
    return (
      nativeSessionIdFromHandle(agent.persistence?.sessionId) ??
      nativeSessionIdFromHandle(agent.runtimeInfo?.sessionId)
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const session of this.sessions.values()) session.abort.abort();
    this.sessions.clear();
  }

  private read(sessionId: string): Promise<SessionUsageSnapshot> {
    if (this.disposed) return Promise.resolve(unavailable());
    let session = this.sessions.get(sessionId);
    if (!session) {
      while (this.sessions.size >= this.maxSessions) {
        const oldest = this.sessions.keys().next().value!;
        this.sessions.get(oldest)!.abort.abort();
        this.sessions.delete(oldest);
      }
      const abort = new AbortController();
      session = {
        abort,
        file: new SessionUsageFile(sessionId, this.env, abort.signal),
        readAt: -Infinity,
      };
    }
    // Keep recently viewed sessions; cached readers are bounded even when a
    // client visits many archived conversations over a long daemon lifetime.
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, session);
    if (session.pending) return session.pending;
    if (session.snapshot && this.now() - session.readAt < this.intervalMs)
      return Promise.resolve(session.snapshot);
    const cached = session;
    cached.pending = this.readFile(sessionId, cached).finally(() => {
      cached.pending = undefined;
    });
    return cached.pending;
  }

  private async readFile(sessionId: string, session: CachedSession): Promise<SessionUsageSnapshot> {
    try {
      if (!(await session.file.read(0)) || session.abort.signal.aborted) return unavailable();
      const prices = (await this.pricing?.getCatalog()) ?? emptyPriceCatalog;
      if (session.abort.signal.aborted) return unavailable();
      const snapshot: SessionUsageSnapshot = {
        tokens: 0,
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
        refreshError: null,
      };
      for (const event of session.file.rollout.events.values()) {
        snapshot.tokens = addTokens(snapshot.tokens, event.tokens);
        snapshot.cost = addCosts(snapshot.cost, prices.cost(event));
        snapshot.inputTokens = addTokens(snapshot.inputTokens, event.inputTokens);
        snapshot.outputTokens = addTokens(snapshot.outputTokens, event.outputTokens);
        snapshot.cachedInputTokens = addTokens(snapshot.cachedInputTokens, event.cachedTokens);
        snapshot.cacheCreationInputTokens = addTokens(
          snapshot.cacheCreationInputTokens,
          event.cacheCreationTokens,
        );
        snapshot.reasoningOutputTokens = addTokens(
          snapshot.reasoningOutputTokens,
          event.reasoningTokens,
        );
      }
      // A readable history without any usage records is not evidence of zero.
      session.snapshot = session.file.rollout.events.size ? snapshot : { ...emptySessionUsage };
      session.readAt = this.now();
      return session.snapshot;
    } catch {
      // A replaced/rewritten file may become readable again. Rebuild its reader
      // on the next query, rather than retaining partial or stale totals.
      session.abort.abort();
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
      return unavailable();
    }
  }
}

function addTokens(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new Error("Invalid session token total");
  return sum;
}
