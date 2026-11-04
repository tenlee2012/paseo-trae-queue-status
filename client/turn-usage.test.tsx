import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { Pressable, Text, useWindowDimensions } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnUsageData } from "../shared/turn-usage.js";
import { TurnUsageRow as ActualTurnUsageRow } from "./turn-usage.js";
import { contrast, darkTheme, lightTheme, themeCases } from "./__tests__/themes.js";

const bridge = vi.hoisted(() => ({ create: vi.fn(), render: vi.fn(), dispose: vi.fn() }));
const rpc = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  return { read: vi.fn() };
});
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => rpc.read }));
vi.mock("./web.js", () => ({ createWebOverlay: bridge.create }));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  useWindowDimensions: vi.fn(() => ({ width: 800, height: 700, scale: 1, fontScale: 1 })),
}));
vi.mock("@getpaseo/plugin/client/ui", () => ({
  Icon: "Icon",
  ScrollView: "ScrollView",
  Modal: Object.assign(
    ({ children, open }: { children: ReactNode; open: boolean }) => (open ? children : null),
    {
      Content: ({ children }: { children: ReactNode }) => children,
    },
  ),
}));
let tree: ReactTestRenderer | undefined;
let popup: ReactTestRenderer | undefined;
let cache: QueryClient;
function TurnUsageRow(properties: PluginTimelineItemProps<TurnUsageData>) {
  return (
    <QueryClientProvider client={cache}>
      <ActualTurnUsageRow {...properties} />
    </QueryClientProvider>
  );
}
const measure = vi.fn();
beforeEach(() => {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  rpc.read.mockReset().mockResolvedValue({ cost: null });
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  bridge.create.mockReturnValue({ render: bridge.render, dispose: bridge.dispose });
  measure.mockImplementation((callback) => callback(200, 400, 72, 18));
  vi.mocked(useWindowDimensions).mockReturnValue({
    width: 800,
    height: 700,
    scale: 1,
    fontScale: 1,
  });
});
afterEach(async () => {
  await act(async () => {
    tree?.unmount();
    popup?.unmount();
  });
  tree = undefined;
  popup = undefined;
  cache.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function props(data: TurnUsageData, compact = false, platform: "web" | "ios" | "android" = "web") {
  return {
    agentId: "test-agent",
    host: { id: "test-host", label: "Test host" },
    timestamp: new Date("2026-11-03T12:00:00Z"),
    item: { data },
    layout: { compact, platform },
    theme: {
      colors: {
        foreground: "#eeeeee",
        foregroundMuted: "#888888",
        surface0: "#222222",
        surface1: "#333333",
      },
    },
  } as PluginTimelineItemProps<TurnUsageData>;
}
async function render(
  data: TurnUsageData,
  compact = false,
  platform: "web" | "ios" | "android" = "web",
) {
  await act(async () => {
    tree = create(<TurnUsageRow {...props(data, compact, platform)} />, {
      createNodeMock: () => ({ measureInWindow: measure }),
    });
  });
}
const text = (view = tree!) =>
  view.root
    .findAllByType(Text)
    .map((node) => node.props.children)
    .join(" | ");
const trigger = () => tree!.root.findByType(Pressable);
async function syncPopup() {
  const content = bridge.render.mock.lastCall?.[0];
  if (!content) throw new Error("Tooltip was not rendered");
  await act(async () => {
    if (popup) popup.update(content);
    else popup = create(content);
  });
  return popup!;
}
async function hover() {
  await act(async () => trigger().props.onHoverIn());
  return syncPopup();
}
const ready = (
  inputTokens = 16240,
  outputTokens = 130,
  cachedInputTokens: number | null = 9020,
): TurnUsageData => ({
  state: "ready",
  outcome: "completed",
  inputTokens,
  outputTokens,
  cachedInputTokens,
  cacheCreationInputTokens: 0,
  reasoningOutputTokens: Math.min(36, outputTokens),
});

describe("turn usage row", () => {
  it("recovers a persisted null cost when opening its tooltip without exposing it outside", async () => {
    rpc.read.mockResolvedValue({ cost: 0.1234 });
    await render({ ...ready(), cost: null });
    expect(rpc.read).not.toHaveBeenCalled();
    await hover();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(text(await syncPopup())).toContain("Token 总量 | 16.37K | $0.12");
    expect(text()).toBe("本轮: | 16.37K");
    expect(rpc.read).toHaveBeenCalledWith({
      agentId: "test-agent",
      timestamp: Date.parse("2026-11-03T12:00:00Z"),
      usage: { ...ready(), cost: null },
    });
  });

  it("retries unavailable pricing only while open, including after the original turn expired", async () => {
    vi.useFakeTimers();
    rpc.read.mockResolvedValueOnce({ cost: null }).mockResolvedValue({ cost: 0.25 });
    await render({ ...ready(), cost: null });
    await hover();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_001);
    });
    expect(text(await syncPopup())).toContain("Token 总量 | 16.37K | $0.25");
    const calls = rpc.read.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(rpc.read).toHaveBeenCalledTimes(calls);
  });

  it("stops retrying unknown costs when the tooltip closes", async () => {
    vi.useFakeTimers();
    await render({ ...ready(), cost: null });
    await hover();
    await act(async () => {
      trigger().props.onHoverOut();
      await vi.advanceTimersByTimeAsync(151);
    });
    const calls = rpc.read.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(rpc.read).toHaveBeenCalledTimes(calls);
  });

  it("does not query already known costs or turn failures, and keeps RPC errors unknown", async () => {
    await render({ ...ready(), cost: 0.5 });
    expect(text(await hover())).toContain("Token 总量 | 16.37K | $0.5");
    expect(rpc.read).not.toHaveBeenCalled();
    rpc.read.mockRejectedValue(new Error("unavailable"));
    await act(async () => tree!.update(<TurnUsageRow {...props({ ...ready(), cost: null })} />));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(text(await syncPopup())).toContain("Token 总量 | 16.37K | $—");
    const calls = rpc.read.mock.calls.length;
    await act(async () =>
      tree!.update(<TurnUsageRow {...props({ ...ready(), state: "unavailable" })} />),
    );
    expect(rpc.read).toHaveBeenCalledTimes(calls);
  });

  it.each(["ios", "android"] as const)(
    "recovers costs in the %s detail modal",
    async (platform) => {
      rpc.read.mockResolvedValue({ cost: 0 });
      await render(ready(), true, platform);
      await act(async () => trigger().props.onPress());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(text()).toContain("Token 总量 | 16.37K | $0");
      expect(trigger().findByType(Text).props.children).toBe("16.37K");
    },
  );

  it.each([false, true])("keeps cost inside the details only, compact=%s", async (compact) => {
    await render({ ...ready(719_170, 9_240), cost: 50.2 }, compact);
    expect(text()).toBe("本轮: | 728.41K");
    expect(text(await hover())).toContain("Token 总量 | 728.41K | $50.2");
    expect(trigger().props.accessibilityLabel).toContain("728.41K tokens");
    expect(trigger().props.accessibilityLabel).not.toContain("$");
  });
  it.each(themeCases)(
    "keeps all row and tooltip text readable in $name",
    async ({ theme, compact }) => {
      await render({ ...ready(), modelCallCount: 2, toolCallCount: 1 }, compact);
      await act(async () =>
        tree!.update(
          <TurnUsageRow
            {...props({ ...ready(), modelCallCount: 2, toolCallCount: 1 }, compact)}
            theme={theme}
          />,
        ),
      );
      for (const node of tree!.root.findAllByType(Text))
        expect(node.props.style.color).toBe(theme.colors.foregroundMuted);
      for (const node of tree!.root.findAllByType(Icon))
        expect(node.props.color).toBe(theme.colors.foregroundMuted);
      expect(trigger().findByType(Text).props.style).toMatchObject({
        textDecorationLine: "underline",
        textDecorationStyle: "dotted",
        textDecorationColor: theme.colors.foregroundMuted,
      });
      expect(contrast(theme.colors.foregroundMuted, theme.colors.surface0)).toBeGreaterThanOrEqual(
        4.5,
      );
      await hover();
      const tooltip = popup!.root.findByProps({ role: "tooltip" });
      expect(tooltip.props.style.backgroundColor).toBe(theme.colors.foreground);
      for (const node of popup!.root.findAllByType(Text)) {
        expect(node.props.style.color).toBe(theme.colors.surface0);
        expect(
          contrast(node.props.style.color, tooltip.props.style.backgroundColor),
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it("updates an already-open tooltip and its arrow through light, dark, and light again", async () => {
    await render(ready());
    await hover();
    for (const theme of [lightTheme, darkTheme, lightTheme]) {
      // oxlint-disable-next-line no-await-in-loop
      await act(async () => tree!.update(<TurnUsageRow {...props(ready())} theme={theme} />));
      // oxlint-disable-next-line no-await-in-loop
      await syncPopup();
      expect(popup!.root.findByProps({ role: "tooltip" }).props.style.backgroundColor).toBe(
        theme.colors.foreground,
      );
      for (const node of popup!.root.findAllByType(Text))
        expect(node.props.style.color).toBe(theme.colors.surface0);
      expect(JSON.stringify(popup!.toJSON())).toContain(
        `"borderTopColor":"${theme.colors.foreground}"`,
      );
      for (const node of tree!.root.findAllByType(Icon))
        expect(node.props.color).toBe(theme.colors.foregroundMuted);
      expect(trigger().findByType(Text).props.style.textDecorationColor).toBe(
        theme.colors.foregroundMuted,
      );
    }
    expect(bridge.create).toHaveBeenCalledTimes(1);
  });

  it("updates an open touch detail dialog when the theme changes", async () => {
    await render(ready(), true, "ios");
    await act(async () => trigger().props.onPress());
    for (const theme of [lightTheme, darkTheme, lightTheme]) {
      // oxlint-disable-next-line no-await-in-loop
      await act(async () =>
        tree!.update(<TurnUsageRow {...props(ready(), true, "ios")} theme={theme} />),
      );
      const modal = tree!.root.findByType(Modal);
      for (const node of modal.findAllByType(Text))
        expect(node.props.style.color).toBe(theme.colors.foreground);
      expect(modal.props.open).toBe(true);
    }
    expect(bridge.create).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps only the token icon and compact total in compact=%s",
    async (compact) => {
      await render(ready(22204, 94, 10040), compact);
      expect(text()).toBe("本轮: | 22.3K");
      expect(tree!.root.findByType(ScrollView).props.horizontal).toBe(true);
      for (const node of tree!.root.findAllByType(Text)) expect(node.props.numberOfLines).toBe(1);
      expect(trigger().props.accessibilityLabel).toContain("22.3K tokens");
      expect(bridge.create).not.toHaveBeenCalled();
      expect(text(await hover())).toContain("输入 Token | 22.2K | 99.6%");
      expect(text(popup)).toContain("缓存读取 Token | 10.04K | 45.2%");
      expect(text(popup)).toContain("输出 Token | 94 | 0.4%");
    },
  );

  it("shows the requested per-turn breakdown with correctly scoped percentages", async () => {
    await render(ready());
    expect(text(await hover())).toBe(
      "输入 Token | 16.24K | 99.2% | 缓存读取 Token | 9.02K | 55.5% | 缓存创建 Token | 0 | 0.0% | 输出 Token | 130 | 0.8% | 推理 Token | 36 | 0.2% | Token 总量 | 16.37K | $—",
    );
    expect(bridge.create).toHaveBeenCalledTimes(1);
    expect(popup!.root.findByProps({ role: "tooltip" }).props.nativeID).toBe(
      trigger().props["aria-describedby"],
    );
  });

  it.each([
    ["pending", "completed", "本轮: | 用量统计中…"],
    ["unavailable", "canceled", "本轮: | 用量未提供 · 已停止"],
    ["unavailable", "failed", "本轮: | 用量未提供 · 失败"],
  ] as const)("shows %s and %s without inventing zero usage", async (state, outcome, expected) => {
    await render({
      state,
      outcome,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
    });
    expect(text()).toBe(expected);
    expect(text(await hover())).toContain("输入 Token | 未提供 | —");
    expect(text(popup)).toContain("Token 总量 | 未提供");
  });

  it("keeps old rows readable without inventing missing cache creation or reasoning", async () => {
    await render({
      state: "ready",
      outcome: "canceled",
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: null,
    });
    expect(text()).toBe("本轮: | 110 · 已停止");
    const details = text(await hover());
    expect(details).toContain("缓存读取 Token | 未提供 | —");
    expect(details).toContain("缓存创建 Token | 未提供 | —");
    expect(details).toContain("推理 Token | 未提供 | —");
    expect(details).toContain("输入 Token | 100 | 90.9%");
  });

  it.each([
    [100, 0, "缓存读取 Token | 0 | 0.0%"],
    [100, 100, "缓存读取 Token | 100 | 100.0%"],
    [0, 0, "缓存读取 Token | 0 | —"],
  ] as const)(
    "handles input=%s and cached=%s without invalid percentages",
    async (input, cached, expected) => {
      await render(ready(input, 10, cached));
      expect(text(await hover())).toContain(expected);
      expect(text(popup)).not.toMatch(/NaN|Infinity/);
    },
  );

  it("updates an open tooltip in place when delayed usage arrives", async () => {
    await render(ready(100, 10, 20));
    await hover();
    await act(async () => tree!.update(<TurnUsageRow {...props(ready(200, 20, 150))} />));
    expect(text()).toBe("本轮: | 220");
    expect(text(await syncPopup())).toContain("缓存读取 Token | 150 | 75.0%");
    expect(bridge.create).toHaveBeenCalledTimes(1);
  });

  it("shows zero values and unavailable shares for zero denominators", async () => {
    await render(ready(0, 0, 0));
    expect(text()).toBe("本轮: | 0");
    expect(text(await hover())).toBe(
      "输入 Token | 0 | — | 缓存读取 Token | 0 | — | 缓存创建 Token | 0 | — | 输出 Token | 0 | — | 推理 Token | 0 | — | Token 总量 | 0 | $—",
    );
  });

  it("calculates shares from raw counts before compact rounding", async () => {
    await render(ready(1499, 7, 449));
    expect(text(await hover())).toContain("缓存读取 Token | 449 | 30.0%");
    expect(text(popup)).toContain("输入 Token | 1.5K | 99.5%");
  });

  it("retains the failed outcome beside known consumption", async () => {
    await render({ ...ready(), outcome: "failed" });
    expect(text()).toBe("本轮: | 16.37K · 失败");
  });

  it.each([false, true])(
    "keeps model and tool counts directly visible in compact=%s",
    async (compact) => {
      await render({ ...ready(43270, 382, 21300), modelCallCount: 2, toolCallCount: 1 }, compact);
      expect(text()).toBe("本轮: | 2 calls | 1 calls | 43.65K");
      expect(tree!.root.findAllByType(Text).map((node) => node.props.accessibilityLabel)).toEqual([
        undefined,
        "Model 2 calls",
        "Tools 1 calls",
        undefined,
      ]);
      expect(tree!.root.findAllByType(Pressable)).toHaveLength(1);
      const icons = tree!.root.findAllByType(Icon);
      expect(icons).toHaveLength(3);
      for (const icon of icons) expect(icon.props.color).toBe("#888888");
    },
  );

  it("shows authoritative zero call counts even when token usage is unavailable", async () => {
    await render({
      state: "unavailable",
      outcome: "canceled",
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      modelCallCount: 0,
      toolCallCount: 0,
    });
    expect(text()).toBe("本轮: | 0 calls | 0 calls | 用量未提供 · 已停止");
  });

  it("does not present legacy Thinking and partial ACP tool counts as trace statistics", async () => {
    await render({ ...ready(), reasoningCount: 4, toolCallCount: 18 });
    expect(text()).toBe("本轮: | 16.37K");
  });

  it("distinguishes unavailable trace counts from a known zero", async () => {
    await render({ ...ready(), modelCallCount: null, toolCallCount: null });
    expect(text()).toBe("本轮: | — calls | — calls | 16.37K");
    await act(async () =>
      tree!.update(
        <TurnUsageRow {...props({ ...ready(), modelCallCount: 10, toolCallCount: 28 })} />,
      ),
    );
    expect(text()).toBe("本轮: | 10 calls | 28 calls | 16.37K");
  });

  it("keeps the tooltip open when the pointer moves from the total onto its content", async () => {
    vi.useFakeTimers();
    await render(ready());
    await hover();
    await act(async () => {
      trigger().props.onHoverOut();
      popup!.root.findByType(Pressable).props.onHoverIn();
      vi.advanceTimersByTime(200);
    });
    expect(bridge.dispose).not.toHaveBeenCalled();
    await act(async () => {
      popup!.root.findByType(Pressable).props.onHoverOut();
      vi.advanceTimersByTime(150);
    });
    expect(bridge.dispose).toHaveBeenCalledOnce();
    expect(trigger().props["aria-describedby"]).toBeUndefined();
  });

  it("supports keyboard focus, Escape dismissal, and blur", async () => {
    vi.useFakeTimers();
    await render(ready());
    await act(async () => trigger().props.onFocus());
    expect(bridge.create).toHaveBeenCalledTimes(1);
    await act(async () => bridge.create.mock.lastCall![0]());
    expect(bridge.dispose).toHaveBeenCalledOnce();
    await act(async () => trigger().props.onFocus());
    await act(async () => {
      trigger().props.onBlur();
      vi.advanceTimersByTime(150);
    });
    expect(bridge.dispose).toHaveBeenCalledTimes(2);
  });

  it("ignores a delayed anchor measurement after the pointer leaves", async () => {
    let pending: (x: number, y: number, width: number, height: number) => void;
    measure.mockImplementation((callback) => {
      pending = callback;
    });
    await render(ready());
    await act(async () => {
      trigger().props.onHoverIn();
      trigger().props.onHoverOut();
      pending(200, 400, 72, 18);
    });
    expect(bridge.create).not.toHaveBeenCalled();
  });

  it.each(["ios", "android"] as const)(
    "opens token details on tap on %s without DOM access",
    async (platform) => {
      await render(ready(), true, platform);
      await act(async () => trigger().props.onHoverIn());
      expect(bridge.create).not.toHaveBeenCalled();
      await act(async () => trigger().props.onPress());
      expect(tree!.root.findByType(Modal).props.open).toBe(true);
      expect(text()).toContain("缓存创建 Token | 0 | 0.0%");
      await act(async () => tree!.root.findByType(Modal).props.onOpenChange(false));
      expect(tree!.root.findAllByType(Modal)).toHaveLength(0);
    },
  );

  it("flips below a top-edge target and stays inside a narrow viewport", async () => {
    vi.mocked(useWindowDimensions).mockReturnValue({
      width: 280,
      height: 500,
      scale: 1,
      fontScale: 1,
    });
    measure.mockImplementation((callback) => callback(240, 10, 32, 18));
    await render(ready(), true);
    await hover();
    expect(popup!.root.findByType(Pressable).props.style).toMatchObject({
      width: 264,
      left: 8,
      top: 32,
    });
  });

  it("anchors an above-target tooltip using its measured height", async () => {
    await render(ready());
    await hover();
    expect(popup!.root.findByType(Pressable).props.style.top).toBe(166);
    await act(async () =>
      popup!.root
        .findByType(Pressable)
        .props.onLayout({ nativeEvent: { layout: { height: 220 } } }),
    );
    await syncPopup();
    expect(popup!.root.findByType(Pressable).props.style.top).toBe(176);
    expect(popup!.root.findByType(Pressable).props.pointerEvents).toBe("auto");
  });

  it("disposes the overlay when a timeline row unmounts", async () => {
    await render(ready());
    await hover();
    await act(async () => tree!.unmount());
    tree = undefined;
    expect(bridge.dispose).toHaveBeenCalledOnce();
  });
});
