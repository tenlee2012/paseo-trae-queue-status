import type { PaseoAgent, PaseoAgentListResult, SubscriptionObserver } from "@getpaseo/client";
import type {
  PluginButtonContentProps,
  PluginClientContext,
  PluginComposerPillContribution,
} from "@getpaseo/plugin/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Pressable, Text, View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contributeSessionUsage, SessionUsageIcon, SessionUsagePopover } from "./session-usage.js";
import { darkTheme, lightTheme, styleOf } from "./__tests__/themes.js";
import { emptySessionUsage, type SessionUsageSnapshot } from "../shared/session-usage.js";

const mock = vi.hoisted(() => {
  // React Query disables interval observers in SSR. These components run inside
  // the app; provide its client environment before Query's modules initialize.
  vi.stubGlobal("window", {});
  return { query: vi.fn(), status: "idle" };
});
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: () => mock.query,
  useAgent: (_id: string, select: (agent: { status: string }) => unknown) =>
    select({ status: mock.status }),
}));
vi.mock("@getpaseo/plugin/client/ui", () => ({ Icon: "Icon" }));
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable" }));

const usage = (tokens: number | null, details: Partial<SessionUsageSnapshot> = {}) => ({
  ...emptySessionUsage,
  tokens,
  ...details,
});

let tree: ReactTestRenderer | undefined;
let cache: QueryClient;
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  mock.query.mockReset().mockResolvedValue(usage(100));
  mock.status = "idle";
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  cache.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const agent = (id = "trae", extra = {}) =>
  ({
    id,
    workspaceId: "workspace",
    provider: "traecli-queue",
    archivedAt: null,
    persistence: { sessionId: "plugin:native-one" },
    ...extra,
  }) as unknown as PaseoAgent;
function setup(initial: PaseoAgent[] = [agent()]) {
  let observer: SubscriptionObserver<PaseoAgentListResult>;
  const snapshot = (agents: PaseoAgent[], cursor: string | null = null) =>
    ({
      requestId: "list",
      entries: agents.map((item) => ({ agent: item, project: null })),
      pageInfo: { hasMore: cursor !== null, nextCursor: cursor, prevCursor: null },
    }) as unknown as PaseoAgentListResult;
  const unsubscribe = vi.fn();
  const release = vi.fn();
  const list = vi.fn().mockResolvedValue({
    subscription: {
      subscribe(next: SubscriptionObserver<PaseoAgentListResult>) {
        observer = next;
        observer.snapshot?.(snapshot(initial));
        return unsubscribe;
      },
      release,
    },
  });
  const registrations: {
    contribution: PluginComposerPillContribution;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  }[] = [];
  const addComposerPill = vi.fn((contribution: PluginComposerPillContribution) => {
    const registration = { contribution, update: vi.fn(), remove: vi.fn() };
    registrations.push(registration);
    return registration;
  });
  const rpc = vi.fn().mockResolvedValue({ tokens: 25000, refreshError: null });
  const client = {
    paseo: { agents: { list } },
    addComposerPill,
    rpc,
  } as unknown as PluginClientContext;
  const dispose = contributeSessionUsage(client);
  cleanups.push(dispose);
  const upsert = (item: PaseoAgent) =>
    observer.update?.({ type: "agent_update", payload: { kind: "upsert", agent: item } });
  return {
    registrations,
    addComposerPill,
    list,
    rpc,
    dispose,
    release,
    unsubscribe,
    upsert,
    snapshot: (agents: PaseoAgent[], cursor: string | null = null) =>
      observer.snapshot?.(snapshot(agents, cursor)),
  };
}

async function bootstrap() {
  await Promise.resolve();
  await Promise.resolve();
}

function props(compact = false, dark = false) {
  return {
    context: "agent",
    agentId: "trae",
    workspaceId: "workspace",
    close: vi.fn(),
    layout: { compact },
    theme: {
      colors: {
        foreground: dark ? "#eeeeee" : "#111111",
        foregroundMuted: dark ? "#aaaaaa" : "#666666",
        border: dark ? "#333333" : "#dddddd",
      },
    },
  } as unknown as PluginButtonContentProps;
}

async function mount(element: ReactNode) {
  await act(async () => {
    tree = create(<QueryClientProvider client={cache}>{element}</QueryClientProvider>);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
}

function icon(contribution: PluginComposerPillContribution) {
  const Component = contribution.button.icon;
  if (typeof Component !== "function") throw new Error("Expected a live usage icon");
  return <Component {...props()} size={16} color="#888888" />;
}

const text = () =>
  tree!.root
    .findAllByType(Text)
    .map((node) => node.props.children)
    .join(" | ");

describe("session usage composer registration", () => {
  it("targets only TraeX composers with a workspace and performs no background file queries", async () => {
    const f = setup([
      agent(),
      agent("codex", { provider: "codex" }),
      agent("draft", { workspaceId: null }),
      agent("archived", { archivedAt: "2026-11-03" }),
    ]);
    await bootstrap();
    expect(f.registrations).toHaveLength(1);
    expect(f.registrations[0].contribution).toMatchObject({
      id: "session-usage",
      workspaceId: "workspace",
      agentId: "trae",
      button: { label: "—", behavior: { kind: "popover" } },
    });
    expect(f.rpc).not.toHaveBeenCalled();
    expect(mock.query).not.toHaveBeenCalled();
  });

  it("shows only the total beside the icon and opens a native popover", async () => {
    const f = setup();
    await bootstrap();
    const registration = f.registrations[0];
    mock.query.mockResolvedValue(usage(32771, { cost: 50.2 }));
    await mount(icon(registration.contribution));
    expect(mock.query).toHaveBeenCalledWith({ agentId: "trae" });
    expect(registration.update).toHaveBeenLastCalledWith({
      label: "32.77K",
      title: "本次会话累计 32.77K tokens，点击查看明细。",
    });
    const behavior = registration.contribution.button.behavior;
    if (behavior.kind !== "popover") throw new Error("Expected a native popover");
    await act(async () =>
      tree!.update(
        <QueryClientProvider client={cache}>
          {icon(registration.contribution)}
          <behavior.Content {...props()} />
        </QueryClientProvider>,
      ),
    );
    expect(text()).toContain("Token 总量 | 32.77K | $50.2");
    expect(mock.query).toHaveBeenCalledOnce();
    // Publishing label/title must not replace behavior and close the popover.
    expect(registration.update).toHaveBeenCalledOnce();
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it.each([0, null])("distinguishes a known zero from missing usage: %s", async (tokens) => {
    const f = setup();
    await bootstrap();
    mock.query.mockResolvedValue(
      usage(tokens, { refreshError: tokens === null ? "用量未提供" : null }),
    );
    const registration = f.registrations[0];
    await mount(icon(registration.contribution));
    expect(registration.update).toHaveBeenLastCalledWith({
      label: tokens === null ? "—" : "0",
      title: tokens === null ? "用量未提供" : expect.stringContaining("累计 0 tokens"),
    });
  });

  it("reuses the same pill for status changes and reconnect snapshots", async () => {
    const f = setup();
    await bootstrap();
    f.upsert(agent("trae", { status: "running" }));
    f.snapshot([agent()]);
    expect(f.registrations).toHaveLength(1);
    expect(f.registrations[0].remove).not.toHaveBeenCalled();
    f.snapshot([]);
    expect(f.registrations[0].remove).toHaveBeenCalledOnce();
  });

  it("registers later directory pages while preserving newer live updates", async () => {
    const f = setup();
    await bootstrap();
    let resolve!: (value: unknown) => void;
    f.list.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    f.snapshot([agent()], "next-page");
    f.upsert(agent("later", { workspaceId: "new-workspace" }));
    resolve({
      entries: [
        { agent: agent("later", { workspaceId: "old-workspace" }) },
        { agent: agent("last-page") },
      ],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    await bootstrap();
    expect(f.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: { limit: 200, cursor: "next-page" } }),
    );
    expect(f.registrations.map((item) => item.contribution.agentId)).toEqual([
      "trae",
      "later",
      "last-page",
    ]);
    expect(f.registrations[1].contribution.workspaceId).toBe("new-workspace");
    expect(f.registrations[1].remove).not.toHaveBeenCalled();
  });

  it("rejects stale results when the native session or workspace changes", async () => {
    const f = setup();
    await bootstrap();
    let resolve!: (value: SessionUsageSnapshot) => void;
    mock.query.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const old = f.registrations[0];
    await mount(icon(old.contribution));
    f.upsert(
      agent("trae", { workspaceId: "moved", persistence: { sessionId: "plugin:native-two" } }),
    );
    await act(async () => {
      resolve(usage(99999));
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(old.remove).toHaveBeenCalledOnce();
    expect(old.update).not.toHaveBeenCalled();
    expect(f.registrations[1].contribution).toMatchObject({
      workspaceId: "moved",
      button: { label: "—" },
    });
  });

  it("releases observations and ignores late responses after plugin cleanup", async () => {
    const f = setup();
    await bootstrap();
    f.dispose();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.registrations[0].remove).toHaveBeenCalledOnce();
    f.upsert(agent("late"));
    expect(f.registrations).toHaveLength(1);
    expect(f.list.mock.calls[0][0].signal.aborted).toBe(true);
  });
});

describe("visible session usage icon", () => {
  function element(
    publish: (snapshot: SessionUsageSnapshot) => void,
    sessionKey = "native",
    color = "#888888",
  ) {
    return (
      <QueryClientProvider client={cache}>
        <SessionUsageIcon
          agentId="trae"
          sessionKey={sessionKey}
          publish={publish}
          size={16}
          color={color}
        />
      </QueryClientProvider>
    );
  }
  async function render(publish: (snapshot: SessionUsageSnapshot) => void) {
    await act(async () => {
      tree = create(element(publish));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }

  it("updates the composer icon color supplied by the host without restarting its usage query", async () => {
    const publish = vi.fn();
    await render(publish);
    const calls = mock.query.mock.calls.length;
    for (const theme of [lightTheme, darkTheme, lightTheme]) {
      // oxlint-disable-next-line no-await-in-loop
      await act(async () => tree!.update(element(publish, "native", theme.colors.foregroundMuted)));
      expect(tree!.root.findByType(Icon).props.color).toBe(theme.colors.foregroundMuted);
      expect(tree!.root.findByType(Icon).props.size).toBe(16);
    }
    expect(mock.query).toHaveBeenCalledTimes(calls);
  });

  it("polls while visible, refreshes on turn completion, and stops when unmounted", async () => {
    const publish = vi.fn();
    await render(publish);
    expect(publish).toHaveBeenLastCalledWith(usage(100));
    mock.query.mockResolvedValue(usage(200));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(publish).toHaveBeenLastCalledWith(usage(200));
    mock.status = "running";
    await act(async () => tree!.update(element(publish)));
    mock.query.mockResolvedValue(usage(300));
    mock.status = "idle";
    await act(async () => tree!.update(element(publish)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(publish).toHaveBeenLastCalledWith(usage(300));
    await act(async () => tree!.unmount());
    tree = undefined;
    const calls = mock.query.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(mock.query).toHaveBeenCalledTimes(calls);
  });

  it("shows unavailable on RPC failure rather than inventing zero", async () => {
    mock.query.mockRejectedValue(new Error("offline"));
    const publish = vi.fn();
    await render(publish);
    expect(publish).toHaveBeenLastCalledWith(usage(null, { refreshError: expect.any(String) }));
  });
});

describe("session usage popover", () => {
  it.each([false, true])("shows formatted cost in the total, compact=%s", async (compact) => {
    mock.query.mockResolvedValue(usage(728_410, { cost: 50.2 }));
    await mount(
      <SessionUsagePopover
        {...props(compact)}
        agentId="trae"
        sessionKey="native"
        publish={vi.fn()}
      />,
    );
    expect(text()).toContain("Token 总量 | 728.41K | $50.2");
    expect(
      tree!.root.findAllByProps({ accessibilityLabel: "728.41K tokens | $50.2" }),
    ).toHaveLength(1);
  });
  const sample = usage(16370, {
    inputTokens: 16240,
    outputTokens: 130,
    cachedInputTokens: 9020,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 36,
  });
  const publish = vi.fn();
  const content = (compact = false, dark = false) => (
    <SessionUsagePopover
      {...props(compact, dark)}
      agentId="trae"
      sessionKey="native"
      publish={publish}
    />
  );

  it("updates an already-open session popover through light and dark themes", async () => {
    mock.query.mockResolvedValue(sample);
    await mount(content());
    for (const theme of [lightTheme, darkTheme, lightTheme]) {
      // oxlint-disable-next-line no-await-in-loop
      await act(async () =>
        tree!.update(
          <QueryClientProvider client={cache}>
            <SessionUsagePopover
              {...props()}
              theme={theme}
              agentId="trae"
              sessionKey="native"
              publish={publish}
            />
          </QueryClientProvider>,
        ),
      );
      for (const node of tree!.root.findAllByType(Text))
        expect([theme.colors.foreground, theme.colors.foregroundMuted]).toContain(
          styleOf(node.props.style).color,
        );
      const separator = tree!.root
        .findAllByType(View)
        .find((node) => node.props.style.borderTopWidth === 1);
      expect(separator!.props.style.borderColor).toBe(theme.colors.border);
      expect(text()).toContain("Token 总量 | 16.37K");
    }
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("shows the full breakdown in compact=%s dark=%s", async (compact, dark) => {
    mock.query.mockResolvedValue(sample);
    await mount(content(compact, dark));
    expect(text()).toBe(
      "本次会话 | 输入 Token | 16.24K | 99.2% | 缓存读取 Token | 9.02K | 55.5% | 缓存创建 Token | 0 | 0.0% | 输出 Token | 130 | 0.8% | 推理 Token | 36 | 0.2% | Token 总量 | 16.37K | $—",
    );
    expect(tree!.root.findAllByType(View)[0].props.style.width).toBe(compact ? "100%" : 320);
    const colors = props(compact, dark).theme.colors;
    for (const node of tree!.root.findAllByType(Text))
      expect([colors.foreground, colors.foregroundMuted]).toContain(node.props.style.color);
    expect(tree!.root.findAllByProps({ accessibilityLabel: "16.37K tokens | $—" })).toHaveLength(1);
    expect(tree!.root.findAllByType(Pressable)).toHaveLength(0);
  });

  it("retains known totals when optional details were not reported", async () => {
    mock.query.mockResolvedValue({
      ...sample,
      cachedInputTokens: null,
      cacheCreationInputTokens: null,
      reasoningOutputTokens: null,
    });
    await mount(content());
    expect(text()).toContain("缓存读取 Token | 未提供 | — | 缓存创建 Token | 未提供 | —");
    expect(text()).toContain("推理 Token | 未提供 | — | Token 总量 | 16.37K");
    expect(text()).not.toMatch(/NaN|Infinity/);
  });

  it("distinguishes explicit zero counts and undefined zero-denominator shares", async () => {
    mock.query.mockResolvedValue(
      usage(0, {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
      }),
    );
    await mount(content());
    expect(text()).toBe(
      "本次会话 | 输入 Token | 0 | — | 缓存读取 Token | 0 | — | 缓存创建 Token | 0 | — | 输出 Token | 0 | — | 推理 Token | 0 | — | Token 总量 | 0 | $—",
    );
  });

  it("updates an open popover and uses raw counts before compact rounding", async () => {
    mock.query.mockResolvedValue(sample);
    await mount(content());
    mock.query.mockResolvedValue(
      usage(1506, {
        inputTokens: 1499,
        outputTokens: 7,
        cachedInputTokens: 449,
        cacheCreationInputTokens: 100,
        reasoningOutputTokens: 3,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5001);
    });
    expect(text()).toContain("输入 Token | 1.5K | 99.5% | 缓存读取 Token | 449 | 30.0%");
    expect(text()).toContain("缓存创建 Token | 100 | 6.7%");
    expect(text()).toContain("推理 Token | 3 | 0.2% | Token 总量 | 1.51K");
  });

  it("recovers from a failed read using the popover retry action", async () => {
    mock.query.mockRejectedValue(new Error("offline"));
    await mount(content());
    expect(text()).toContain("Token 总量 | 未提供");
    const retry = tree!.root.findByType(Pressable);
    mock.query.mockResolvedValue(sample);
    await act(async () => {
      retry.props.onPress();
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(text()).toContain("Token 总量 | 16.37K");
    expect(tree!.root.findAllByType(Pressable)).toHaveLength(0);
  });
});
