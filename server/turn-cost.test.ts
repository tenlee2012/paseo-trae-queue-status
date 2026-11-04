import { describe, expect, it } from "vitest";
import type { TurnUsageData } from "../shared/turn-usage.js";
import { UsageRollout, type UsageEvent } from "./usage-rollout.js";
import { findTurnCostEvents } from "./turn-cost.js";

const usage: TurnUsageData = {
  state: "ready",
  outcome: "completed",
  cost: null,
  inputTokens: 100,
  outputTokens: 10,
  cachedInputTokens: 80,
  cacheCreationInputTokens: 10,
  reasoningOutputTokens: 5,
};
const event = (key: string, extra: Partial<UsageEvent> = {}): UsageEvent => ({
  key,
  timestamp: 1000,
  turnId: "turn-one",
  model: "model-one",
  inputTokens: 100,
  outputTokens: 10,
  tokens: 110,
  cachedTokens: 80,
  cacheCreationTokens: 10,
  reasoningTokens: 5,
  ...extra,
});
const rollout = (...events: UsageEvent[]) => {
  const result = new UsageRollout("session-one");
  for (const item of events) result.events.set(item.key, item);
  return result;
};

describe("historical turn cost attribution", () => {
  it("recovers a uniquely matching legacy turn from raw counters", () => {
    const target = event("one");
    const data = rollout(target, event("two", { turnId: "turn-two", inputTokens: 200 }));
    expect(findTurnCostEvents(data, "session-one", usage, 5000)).toEqual([target]);
    expect(findTurnCostEvents(data, "session-one", { ...usage, cost: undefined }, 5000)).toEqual([
      target,
    ]);
  });

  it("rejects ambiguous repeated totals even when models differ, unless native IDs identify the turn", () => {
    const first = event("one");
    const second = event("two", { turnId: "turn-two", model: "different-price" });
    const data = rollout(first, second);
    expect(findTurnCostEvents(data, "session-one", usage, 5000)).toBeNull();
    expect(
      findTurnCostEvents(
        data,
        "session-one",
        {
          ...usage,
          source: { sessionId: "session-one", turnIds: ["turn-two"] },
        },
        5000,
      ),
    ).toEqual([second]);
  });

  it.each([
    { sessionId: "other-session", turnIds: ["turn-one"] },
    { sessionId: "session-one", turnIds: ["missing-turn"] },
    { sessionId: "session-one", turnIds: ["turn-one", "missing-turn"] },
  ])("does not fall back from an invalid source: %j", (source) => {
    expect(
      findTurnCostEvents(rollout(event("one")), "session-one", { ...usage, source }, 5000),
    ).toBeNull();
  });

  it("requires the whole turn and every known token detail to match", () => {
    const data = rollout(event("one"), event("two"));
    expect(findTurnCostEvents(data, "session-one", usage, 5000)).toBeNull();
    for (const field of [
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "cacheCreationInputTokens",
      "reasoningOutputTokens",
    ] as const) {
      expect(
        findTurnCostEvents(rollout(event("one")), "session-one", { ...usage, [field]: 999 }, 5000),
      ).toBeNull();
    }
    expect(
      findTurnCostEvents(
        rollout(event("one")),
        "session-one",
        { ...usage, state: "pending" },
        5000,
      ),
    ).toBeNull();
  });

  it("can restore details omitted by old rows without admitting future or unidentified turns", () => {
    const target = event("one");
    expect(
      findTurnCostEvents(
        rollout(target),
        "session-one",
        {
          ...usage,
          cachedInputTokens: null,
          cacheCreationInputTokens: undefined,
          reasoningOutputTokens: null,
        },
        5000,
      ),
    ).toEqual([target]);
    expect(findTurnCostEvents(rollout(target), "session-one", usage, 999)).toBeNull();
    expect(
      findTurnCostEvents(rollout(event("one", { turnId: null })), "session-one", usage, 5000),
    ).toBeNull();
  });
});
