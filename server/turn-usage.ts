import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { queueStatusPluginId } from "../shared/queue-status.js";
import { turnUsageKind, type TurnUsageData } from "../shared/turn-usage.js";
import { SessionUsageFile } from "./session-usage-file.js";
import type { UsageRollout } from "./usage-rollout.js";
import type { TraeCallCounts, TurnCallCounts } from "./call-counts.js";
import {
  addCosts,
  emptyPriceCatalog,
  type ModelPriceCatalog,
  type ModelPricingSource,
} from "./model-pricing.js";

interface Baseline {
  knownTurns: Set<string>;
  knownKeys: Set<string>;
  failed: boolean;
}

interface Turn extends Baseline {
  id: string;
  startedAt: number;
  endedAt?: number;
  deadline?: number;
  outcome?: TurnUsageData["outcome"];
  signature?: string;
  nativeTurns: Set<string>;
  calls?: Pick<TurnCallCounts, "modelCallCount" | "toolCallCount">;
}

interface Session {
  nativeId: string;
  abort: AbortController;
  file: SessionUsageFile;
  turns: Map<string, Turn>;
  claimedTurns: Set<string>;
  prepared?: Baseline;
  pending?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  readError: boolean;
}

interface TurnUsageOptions {
  env?: NodeJS.ProcessEnv;
  callCounts?: Pick<TraeCallCounts, "read"> & Partial<Pick<TraeCallCounts, "forget">>;
  now?: () => number;
  retryMs?: number;
  timeoutMs?: number;
  pricing?: ModelPricingSource;
}

// Paseo's turn IDs are synthetic ACP IDs. Match native IDs from the selected
// rollout and its request timestamps, never by ID equality or global totals.
export class TraeTurnUsage {
  private readonly sessions = new Map<string, Session>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly retryMs: number;
  private readonly timeoutMs: number;
  private readonly callCounts?: TurnUsageOptions["callCounts"];
  private readonly pricing?: ModelPricingSource;

  constructor(
    private readonly emit: (event: ProviderEvent) => void,
    options: TurnUsageOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.retryMs = options.retryMs ?? 250;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.callCounts = options.callCounts;
    this.pricing = options.pricing;
  }

  bind(sessionId: string, nativeId: string): void {
    if (this.sessions.get(sessionId)?.nativeId === nativeId) return;
    this.release(sessionId);
    const abort = new AbortController();
    this.sessions.set(sessionId, {
      nativeId,
      abort,
      file: new SessionUsageFile(nativeId, this.env, abort.signal),
      turns: new Map(),
      claimedTurns: new Set(),
      readError: false,
    });
  }

  // Called before forwarding a new prompt, so old records and cumulative legacy
  // counters are observed before the model can start. Steering skips this step.
  async prepare(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await this.refresh(sessionId, session);
    session.prepared = {
      knownTurns: new Set(session.file.rollout.turns.keys()),
      knownKeys: new Set(session.file.rollout.events.keys()),
      failed: session.readError,
    };
  }

  observe(event: ProviderEvent): void {
    if (event.type === "session.closed") {
      this.release(event.sessionId);
      return;
    }
    if (event.type !== "session.turn") return;
    const session = this.sessions.get(event.sessionId);
    if (!session) {
      if (event.state !== "started")
        this.publish(event.sessionId, event.turnId, {
          state: "unavailable",
          outcome: event.state,
          cost: null,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          cacheCreationInputTokens: null,
          reasoningOutputTokens: null,
          modelCallCount: null,
          toolCallCount: null,
        });
      return;
    }
    if (event.state === "started") {
      if (session.turns.has(event.turnId)) return;
      session.turns.set(event.turnId, {
        id: event.turnId,
        startedAt: this.now(),
        ...(session.prepared ?? { knownTurns: new Set(), knownKeys: new Set(), failed: true }),
        nativeTurns: new Set(),
      });
      session.prepared = undefined;
      return;
    }
    const turn = session.turns.get(event.turnId);
    if (!turn || turn.outcome) return;
    turn.endedAt = this.now();
    turn.deadline = turn.endedAt + this.timeoutMs;
    turn.outcome = event.state;
    this.update(event.sessionId, turn, null, false);
    void this.refresh(event.sessionId, session);
  }

  release(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.abort.abort();
    if (session.timer) clearTimeout(session.timer);
    this.sessions.delete(sessionId);
  }

  dispose(): void {
    for (const id of this.sessions.keys()) this.release(id);
  }

  private refresh(sessionId: string, session: Session): Promise<void> {
    if (session.pending) return session.pending;
    session.pending = this.readAndUpdate(sessionId, session).finally(() => {
      session.pending = undefined;
      if (session.abort.signal.aborted || session.timer) return;
      if (![...session.turns.values()].some((turn) => turn.outcome)) return;
      session.timer = setTimeout(() => {
        session.timer = undefined;
        void this.refresh(sessionId, session);
      }, this.retryMs);
      session.timer.unref();
    });
    return session.pending;
  }

  private async readAndUpdate(sessionId: string, session: Session): Promise<void> {
    // Only completed turns need prices; the initial pre-prompt baseline does not.
    // Read the rollout AFTER fetching so records arriving during a slow download
    // are included even if the turn's retry deadline has elapsed by then.
    const prices = [...session.turns.values()].some((turn) => turn.outcome)
      ? ((await this.pricing?.getCatalog()) ?? emptyPriceCatalog)
      : emptyPriceCatalog;
    if (session.abort.signal.aborted) return;
    const since = Math.min(
      this.now(),
      ...[...session.turns.values()].map((turn) => turn.startedAt),
    );
    try {
      await session.file.read(since);
      session.readError = false;
    } catch {
      // Never expose conversation contents, local paths, or malformed records.
      session.readError = true;
    }
    if (session.abort.signal.aborted) return;
    const calls = await this.callCounts?.read(session.nativeId).catch(() => null);
    if (session.abort.signal.aborted) return;
    assignNativeTurns(session, calls);
    for (const turn of session.turns.values()) {
      if (!turn.outcome) continue;
      const native = turn.nativeTurns.size === 1 ? calls?.get([...turn.nativeTurns][0]) : undefined;
      turn.calls = native?.complete ? native : undefined;
      const expired = this.now() >= turn.deadline!;
      const totals =
        turn.failed || session.readError
          ? null
          : totalsForTurn(turn, session.file.rollout, session.turns, prices);
      this.update(sessionId, turn, totals, expired, session.nativeId);
      if (expired) {
        session.turns.delete(turn.id);
        this.callCounts?.forget?.(session.nativeId, turn.nativeTurns);
      }
    }
    const retainSince = Math.min(
      this.now(),
      ...[...session.turns.values()].map((turn) => turn.startedAt),
    );
    session.file.rollout.prune(retainSince);
  }

  private update(
    sessionId: string,
    turn: Turn,
    totals: Pick<
      TurnUsageData,
      | "inputTokens"
      | "cost"
      | "outputTokens"
      | "cachedInputTokens"
      | "cacheCreationInputTokens"
      | "reasoningOutputTokens"
    > | null,
    expired: boolean,
    nativeId?: string,
  ): void {
    const data: TurnUsageData = {
      state: totals ? "ready" : expired ? "unavailable" : "pending",
      outcome: turn.outcome!,
      cost: totals?.cost ?? null,
      ...(totals && nativeId && turn.nativeTurns.size
        ? {
            source: { sessionId: nativeId, turnIds: [...turn.nativeTurns] },
          }
        : {}),
      inputTokens: totals?.inputTokens ?? null,
      outputTokens: totals?.outputTokens ?? null,
      cachedInputTokens: totals?.cachedInputTokens ?? null,
      cacheCreationInputTokens: totals?.cacheCreationInputTokens ?? null,
      reasoningOutputTokens: totals?.reasoningOutputTokens ?? null,
      modelCallCount: turn.calls?.modelCallCount ?? null,
      toolCallCount: turn.calls?.toolCallCount ?? null,
    };
    const signature = JSON.stringify(data);
    if (turn.signature === signature) return;
    turn.signature = signature;
    this.publish(sessionId, turn.id, data);
  }

  private publish(sessionId: string, turnId: string, data: TurnUsageData): void {
    this.emit({
      type: "timeline.item",
      sessionId,
      item: {
        type: "plugin",
        id: `${turnUsageKind}:${turnId}`,
        pluginId: queueStatusPluginId,
        kind: turnUsageKind,
        version: 1,
        data,
      },
    });
  }
}

function assignNativeTurns(session: Session, calls?: Map<string, TurnCallCounts> | null): void {
  const nativeTurns = new Map(session.file.rollout.turns);
  for (const [id, turn] of calls ?? []) nativeTurns.set(id, turn.startedAt);
  for (const [id, timestamp] of nativeTurns) {
    if (session.claimedTurns.has(id)) continue;
    const candidates = [...session.turns.values()].filter(
      (turn) =>
        turn.nativeTurns.size === 0 &&
        !turn.knownTurns.has(id) &&
        timestamp >= turn.startedAt &&
        (turn.endedAt === undefined || timestamp <= turn.endedAt),
    );
    // One ACP session/prompt creates one native turn. Ambiguous timestamps must
    // not attribute the same native request to two adjacent Paseo turns.
    if (candidates.length !== 1) continue;
    candidates[0].nativeTurns.add(id);
    session.claimedTurns.add(id);
  }
}

function totalsForTurn(
  turn: Turn,
  rollout: UsageRollout,
  turns: Map<string, Turn>,
  prices: ModelPriceCatalog,
) {
  const withinTurn = (timestamp: number) =>
    timestamp >= turn.startedAt && timestamp <= turn.endedAt!;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens: number | null = 0;
  let cacheCreationInputTokens: number | null = 0;
  let reasoningOutputTokens: number | null = 0;
  let count = 0;
  let cost: number | null = 0;
  for (const event of rollout.events.values()) {
    if (turn.knownKeys.has(event.key)) continue;
    if (event.turnId) {
      if (!turn.nativeTurns.has(event.turnId)) continue;
    } else {
      if (!withinTurn(event.timestamp)) continue;
      if (
        [...turns.values()].some(
          (other) =>
            other !== turn &&
            !other.knownKeys.has(event.key) &&
            event.timestamp >= other.startedAt &&
            (other.endedAt === undefined || event.timestamp <= other.endedAt),
        )
      )
        return null;
    }
    count++;
    cost = addCosts(cost, prices.cost(event));
    inputTokens += event.inputTokens;
    outputTokens += event.outputTokens;
    cachedInputTokens =
      cachedInputTokens !== null && event.cachedTokens !== null
        ? cachedInputTokens + event.cachedTokens
        : null;
    cacheCreationInputTokens =
      cacheCreationInputTokens !== null && event.cacheCreationTokens !== null
        ? cacheCreationInputTokens + event.cacheCreationTokens
        : null;
    reasoningOutputTokens =
      reasoningOutputTokens !== null && event.reasoningTokens !== null
        ? reasoningOutputTokens + event.reasoningTokens
        : null;
  }
  return count
    ? {
        inputTokens,
        cost,
        outputTokens,
        cachedInputTokens,
        cacheCreationInputTokens,
        reasoningOutputTokens,
      }
    : null;
}
