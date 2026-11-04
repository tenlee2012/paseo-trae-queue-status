import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getTurnCost, type TurnUsageData } from "../shared/turn-usage.js";

export interface TurnCostTarget {
  agentId: string;
  hostId: string;
  timestamp: number;
}

// Query in the timeline's host context, not the tooltip's separate React root.
// Old persisted null costs can recover without rewriting conversation history.
export function useTurnCost(data: TurnUsageData, target: TurnCostTarget, visible: boolean) {
  const readCost = useRpc(getTurnCost);
  const query = useQuery({
    queryKey: ["trae-turn-cost", target.hostId, target.agentId, target.timestamp, data],
    queryFn: () => readCost({ agentId: target.agentId, timestamp: target.timestamp, usage: data }),
    enabled: visible && data.state === "ready" && data.cost == null,
    refetchInterval: (state) => (state.state.data?.cost == null ? 5_000 : false),
    staleTime: 0,
    retry: false,
  });
  const cost = data.cost ?? query.data?.cost;
  return useMemo(
    () => (cost == null || cost === data.cost ? data : { ...data, cost }),
    [data, cost],
  );
}
