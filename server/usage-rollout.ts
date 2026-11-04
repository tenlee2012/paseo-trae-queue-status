import { normalizeUsageModel } from "../shared/model-usage.js";

export interface UsageEvent {
  key: string;
  timestamp: number;
  model: string | null;
  turnId: string | null;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  cachedTokens: number | null;
  cacheCreationTokens: number | null;
  reasoningTokens: number | null;
}

interface TokenUsage {
  input: number;
  output: number;
  cached: number | null;
  cacheCreation: number | null;
  reasoning: number | null;
}

export class UsageRollout {
  readonly events = new Map<string, UsageEvent>();
  readonly turns = new Map<string, number>();
  private sessionId: string | null = null;
  private model: string | null = null;
  private turnId: string | null = null;
  private hasUsageRecords = false;
  private previousTotal: TokenUsage | null = null;
  private pending = new Map<string, UsageEvent>();

  constructor(private readonly fileId: string) {}

  clone(): UsageRollout {
    const copy = new UsageRollout(this.fileId);
    Object.assign(copy, structuredClone({ ...this }));
    return copy;
  }

  prune(since: number): void {
    for (const [key, event] of this.events) {
      if (event.timestamp < since) this.events.delete(key);
    }
    for (const [key, event] of this.pending) {
      if (event.timestamp < since) this.pending.delete(key);
    }
  }

  consume(line: string, since: number): void {
    // History mutations and tool output can be megabytes long. Never parse or
    // retain their content; only the top-level record header is inspected.
    const header = line.slice(0, 250);
    const type = /"type"\s*:\s*"([^"]+)"/.exec(header)?.[1];
    if (!["session_meta", "turn_context", "token_usage_record", "event_msg"].includes(type ?? ""))
      return;
    if (type === "event_msg" && !/"type"\s*:\s*"(?:token_count|task_started)"/.test(header)) return;
    const record = object(JSON.parse(line));
    const payload = object(record.payload);
    if (type === "session_meta") {
      this.sessionId = string(payload.id) ?? string(payload.session_id) ?? this.sessionId;
      return;
    }
    if (type === "turn_context") {
      this.model = string(payload.model) ?? this.model;
      this.observeTurn(payload.turn_id, record.timestamp);
      return;
    }
    if (type === "event_msg" && payload.type === "task_started") {
      this.observeTurn(payload.turn_id, record.timestamp);
      return;
    }
    const timestamp = Date.parse(string(record.timestamp) ?? "");
    if (!Number.isFinite(timestamp)) throw new Error("Invalid usage timestamp");
    if (type === "token_usage_record") {
      this.hasUsageRecords = true;
      // Forks may carry their parent's records. Count the original request once.
      if (this.sessionId && payload.thread_id && payload.thread_id !== this.sessionId) return;
      const turnId = string(payload.turn_id) ?? this.turnId;
      if (turnId && !this.turns.has(turnId)) this.turns.set(turnId, timestamp);
      if (timestamp < since) return;
      const usage = tokens(payload.usage);
      const total = tokens(payload.thread_token_usage);
      const key = JSON.stringify([
        payload.thread_id ?? this.sessionId ?? this.fileId,
        payload.turn_id,
        payload.response_id,
        total.input,
        total.output,
        usage.input,
        usage.output,
      ]);
      const event = {
        key,
        timestamp,
        model: this.model,
        turnId,
        inputTokens: usage.input,
        outputTokens: usage.output,
        tokens: usage.input + usage.output,
        cachedTokens: usage.cached,
        cacheCreationTokens: usage.cacheCreation,
        reasoningTokens: usage.reasoning,
      };
      this.events.set(key, event);
      this.pending.set(totalKey(total), event);
      return;
    }

    const info = object(payload.info);
    if (!info.total_token_usage) return; // Rate-limit-only update.
    const total = tokens(info.total_token_usage);
    const context = object(payload.context);
    const model = string(context.model) ?? string(object(context.contextUsage).model) ?? this.model;
    const pending = this.pending.get(totalKey(total));
    if (pending) {
      pending.model = model;
      this.pending.delete(totalKey(total));
    }
    // Older CLI releases only emitted cumulative token_count events. Take the
    // delta, including the baseline before midnight, and ignore repeated updates.
    if (!this.hasUsageRecords && timestamp >= since) {
      const input = total.input - (this.previousTotal?.input ?? 0);
      const output = total.output - (this.previousTotal?.output ?? 0);
      if (input < 0 || output < 0) throw new Error("Usage counter decreased");
      if (input + output > 0) {
        const cached =
          total.cached !== null && (!this.previousTotal || this.previousTotal.cached !== null)
            ? total.cached - (this.previousTotal?.cached ?? 0)
            : null;
        if (cached !== null && (cached < 0 || cached > input))
          throw new Error("Invalid cached token delta");
        const key = JSON.stringify([this.sessionId ?? this.fileId, timestamp, totalKey(total)]);
        this.events.set(key, {
          key,
          timestamp,
          model,
          turnId: this.turnId,
          inputTokens: input,
          outputTokens: output,
          tokens: input + output,
          cachedTokens: cached,
          cacheCreationTokens: optionalDelta(
            total.cacheCreation,
            this.previousTotal?.cacheCreation,
            input,
          ),
          reasoningTokens: optionalDelta(total.reasoning, this.previousTotal?.reasoning, output),
        });
      }
    }
    this.previousTotal = total;
  }

  private observeTurn(value: unknown, time: unknown): void {
    const id = string(value);
    if (!id) return;
    const timestamp = Date.parse(string(time) ?? "");
    if (!Number.isFinite(timestamp)) throw new Error("Invalid turn timestamp");
    this.turnId = id;
    if (!this.turns.has(id)) this.turns.set(id, timestamp);
  }
}

export function usageModel(event: UsageEvent): string {
  if (!event.model) throw new Error("Usage record has no model attribution");
  return normalizeUsageModel(event.model);
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function tokens(value: unknown): TokenUsage {
  const {
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: cached,
    cache_creation_input_tokens: cacheCreation,
    reasoning_output_tokens: reasoning,
  } = object(value);
  if (
    typeof input !== "number" ||
    typeof output !== "number" ||
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    input < 0 ||
    output < 0
  ) {
    throw new Error("Invalid token usage");
  }
  if (
    cached != null &&
    (typeof cached !== "number" || !Number.isSafeInteger(cached) || cached < 0 || cached > input)
  ) {
    throw new Error("Invalid cached token usage");
  }
  // Cached input is already included in input_tokens; reasoning is included in
  // output_tokens. Neither is subtracted or added a second time.
  return {
    input,
    output,
    cached: cached ?? null,
    cacheCreation: optionalTokens(cacheCreation, input),
    reasoning: optionalTokens(reasoning, output),
  };
}

// Older records may omit these details. Invalid optional details must not hide
// otherwise reliable input/output totals or be presented as a known zero.
function optionalTokens(value: unknown, maximum: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value
    : null;
}

function optionalDelta(
  current: number | null,
  previous: number | null | undefined,
  maximum: number,
) {
  return current === null || previous === null
    ? null
    : optionalTokens(current - (previous ?? 0), maximum);
}

function totalKey(total: TokenUsage): string {
  return `${total.input}:${total.output}`;
}
