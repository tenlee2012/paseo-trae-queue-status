import type { TurnUsageData } from "../shared/turn-usage.js";
import type { UsageEvent, UsageRollout } from "./usage-rollout.js";

// Resolve only a whole native turn with matching counters. Never use the
// session's current model or prorate its lifetime cost to repair a historical row.
export function findTurnCostEvents(
  rollout: UsageRollout,
  sessionId: string,
  usage: TurnUsageData,
  timestamp: number,
): UsageEvent[] | null {
  if (usage.state !== "ready" || usage.inputTokens === null || usage.outputTokens === null)
    return null;
  const groups = new Map<string, UsageEvent[]>();
  for (const event of rollout.events.values()) {
    if (!event.turnId) continue;
    const group = groups.get(event.turnId) ?? [];
    group.push(event);
    groups.set(event.turnId, group);
  }
  if (usage.source) {
    if (usage.source.sessionId !== sessionId) return null;
    const ids = new Set(usage.source.turnIds);
    if ([...ids].some((id) => !groups.has(id))) return null;
    const events = [...ids].flatMap((id) => groups.get(id)!);
    return matches(events, usage) ? events : null;
  }

  // Older timeline rows have no native ID. Recover only an exact, unique token
  // breakdown from this session's past turns. Allow the existing 5s flush window;
  // repeated totals or future turns cannot silently select another turn's price.
  const candidates = [...groups.values()].filter(
    (events) =>
      events.some((event) => event.timestamp <= timestamp) &&
      events.every((event) => event.timestamp <= timestamp + 5_000) &&
      matches(events, usage),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

function matches(events: UsageEvent[], usage: TurnUsageData): boolean {
  const fields = [
    ["inputTokens", "inputTokens"],
    ["outputTokens", "outputTokens"],
    ["cachedInputTokens", "cachedTokens"],
    ["cacheCreationInputTokens", "cacheCreationTokens"],
    ["reasoningOutputTokens", "reasoningTokens"],
  ] as const;
  return fields.every(([expected, field]) => {
    if (usage[expected] == null) return true;
    let total = 0;
    for (const event of events) {
      const value = event[field];
      if (value === null) return false;
      total += value;
    }
    return Number.isSafeInteger(total) && total === usage[expected];
  });
}
