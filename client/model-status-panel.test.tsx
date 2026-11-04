import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelStatusPanel, ModelStatusScreen } from "./model-status-panel.js";
import { contrast, darkTheme, lightTheme, styleOf, themeCases } from "./__tests__/themes.js";

const mock = vi.hoisted(() => ({ status: vi.fn(), usage: vi.fn() }));
vi.mock("@getpaseo/plugin/client", async () => {
  const React = await import("react");
  return {
    useRpc: (contract: { name: string }) =>
      contract.name === "models.status" ? mock.status : mock.usage,
    useTabState: (_tab: unknown, _schema: unknown, initial: unknown) => React.useState(initial),
    openExternalUrl: vi.fn(),
  };
});
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable" }));
vi.mock("@getpaseo/plugin/client/ui", () => ({
  Icon: "Icon",
  Loading: "Loading",
  ScrollView: "ScrollView",
  SettingsCard: "SettingsCard",
  SettingsSelect: "SettingsSelect",
  TextInput: "TextInput",
  useToast: () => ({ error: vi.fn() }),
}));

const data = () => ({
  models: [
    {
      id: "alder",
      name: "Alder",
      loadPercent: 20,
      weeklyQuotaApplies: true,
      weeklyQuotaRemainingPercent: 40,
    },
    {
      id: "empty",
      name: "Empty",
      loadPercent: 80,
      weeklyQuotaApplies: false,
      weeklyQuotaRemainingPercent: null,
    },
    {
      id: "unknown",
      name: "Unknown",
      loadPercent: null,
      weeklyQuotaApplies: false,
      weeklyQuotaRemainingPercent: null,
    },
  ],
  refreshedAt: 1000,
  refreshError: null,
});
const props = {
  workspaceId: "test-workspace",
  host: { id: "test-host", label: "Test host" },
  layout: { compact: false, platform: "web" },
  tab: {},
  theme: {
    colors: {
      foreground: "black",
      foregroundMuted: "gray",
      surface0: "white",
      surface1: "white",
      accent: "green",
      border: "gray",
      statusDanger: "red",
      statusWarning: "orange",
      statusSuccess: "green",
    },
  },
} as unknown as PluginWorkspacePanelProps;
let tree: ReactTestRenderer;
let cache: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mock.status.mockReset().mockResolvedValue(data());
  mock.usage.mockReset().mockResolvedValue({ snapshot: null, refreshError: null });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  cache.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(compact = false, theme = props.theme) {
  await act(async () => {
    tree = create(
      <QueryClientProvider client={cache}>
        <ModelStatusPanel {...props} theme={theme} layout={{ ...props.layout, compact }} />
      </QueryClientProvider>,
    );
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}
const row = (id: string) => tree.root.findByProps({ testID: `trae-model-row-${id}` });

describe("mobile model status screen", () => {
  it.each(["android", "ios"] as const)(
    "renders, sorts and searches on %s without Array.prototype.toSorted",
    async (platform) => {
      const original = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
      // Simulate the missing Hermes API only for this test, restoring it in finally.
      // oxlint-disable-next-line no-extend-native
      Object.defineProperty(Array.prototype, "toSorted", { configurable: true, value: undefined });
      const status = data();
      Object.freeze(status.models);
      mock.status.mockResolvedValue(status);
      try {
        await act(async () => {
          tree = create(
            <QueryClientProvider client={cache}>
              <ModelStatusScreen
                host={props.host}
                theme={darkTheme}
                layout={{ compact: true, platform }}
                params={{}}
              />
            </QueryClientProvider>,
          );
          await vi.advanceTimersByTimeAsync(0);
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        const ids = () =>
          tree.root
            .findAllByProps({ role: "row" })
            .map((view) => view.props.testID)
            .filter((id) => id !== "trae-model-list-header");
        expect(ids()).toEqual([
          "trae-model-row-alder",
          "trae-model-row-empty",
          "trae-model-row-unknown",
        ]);
        await act(async () =>
          tree.root.findByProps({ testID: "trae-model-sort-load" }).props.onPress(),
        );
        expect(ids()).toEqual([
          "trae-model-row-empty",
          "trae-model-row-alder",
          "trae-model-row-unknown",
        ]);
        await act(async () => tree.root.findByType(TextInput).props.onChangeText("alder"));
        expect(ids()).toEqual(["trae-model-row-alder"]);
        expect(status.models.map((model) => model.id)).toEqual(["alder", "empty", "unknown"]);
      } finally {
        // oxlint-disable-next-line no-extend-native
        if (original) Object.defineProperty(Array.prototype, "toSorted", original);
        else Reflect.deleteProperty(Array.prototype, "toSorted");
      }
    },
  );
});

describe("model status panel", () => {
  it.each(themeCases)(
    "keeps text, inputs, and sorting controls readable in $name",
    async ({ theme, compact }) => {
      await render(compact, theme);
      const allowed = Object.values(theme.colors);
      for (const node of tree.root.findAllByType(Text))
        expect(allowed).toContain(styleOf(node.props.style).color);
      for (const node of tree.root.findAllByType(Icon)) expect(allowed).toContain(node.props.color);
      const search = tree.root.findByType(TextInput);
      expect(styleOf(search.props.style).color).toBe(theme.colors.foreground);
      expect(search.props.placeholderTextColor).toBe(theme.colors.foregroundMuted);
      for (const indicator of tree.root
        .findAllByType(View)
        .filter((node) => String(node.props.testID).startsWith("trae-model-sort-indicator-"))) {
        expect(styleOf(indicator.props.style).opacity ?? 1).toBe(1);
        const color = indicator.findByType(Icon).props.color;
        expect(contrast(color, theme.colors.surface1)).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it("refreshes cached styles and highlights the active sort after live theme switches", async () => {
    await render(false, lightTheme);
    for (const theme of [darkTheme, lightTheme]) {
      // oxlint-disable-next-line no-await-in-loop
      await act(async () =>
        tree.update(
          <QueryClientProvider client={cache}>
            <ModelStatusPanel {...props} theme={theme} />
          </QueryClientProvider>,
        ),
      );
      expect(tree.root.findAllByType(ScrollView)[0].props.style.backgroundColor).toBe(
        theme.colors.surface0,
      );
      expect(tree.root.findByType(TextInput).props.placeholderTextColor).toBe(
        theme.colors.foregroundMuted,
      );
      // oxlint-disable-next-line no-await-in-loop
      await act(async () =>
        tree.root.findByProps({ testID: "trae-model-sort-quota" }).props.onPress(),
      );
      expect(
        tree.root.findByProps({ testID: "trae-model-sort-indicator-quota" }).findByType(Icon)
          .props.color,
      ).toBe(theme.colors.foreground);
      for (const node of tree.root.findAllByType(Text))
        expect(Object.values(theme.colors)).toContain(styleOf(node.props.style).color);
    }
  });


});

describe("usage breakdown panel", () => {
  it.each([
    { compact: false, dark: false },
    { compact: true, dark: false },
    { compact: false, dark: true },
    { compact: true, dark: true },
  ])(
    "shows daily and weekly cache details in $compact compact, $dark dark",
    async ({ compact, dark }) => {
      mock.usage.mockResolvedValue({
        snapshot: {
          models: [
            {
              model: "alder",
              todayTokens: 48_200_000,
              weekTokens: 96_400_000,
              todayCost: 50.2,
              weekCost: 1234.56,
              todayCachedTokens: 45_600_000,
              weekCachedTokens: 91_200_000,
            },
            { model: "unknown", todayTokens: 100, weekTokens: 200 },
          ],
          todayStart: 0,
          weekStart: 0,
          timeZone: "UTC",
          refreshedAt: 1000,
        },
        refreshError: null,
      });
      const theme = dark
        ? {
            ...props.theme,
            colors: {
              ...props.theme.colors,
              foreground: "white",
              foregroundMuted: "silver",
              surface0: "black",
              surface1: "black",
            },
          }
        : props.theme;
      await render(compact, theme);
      const cells = row("alder").findAllByProps({ role: "cell" });
      expect(cells[2].findAllByType(Text).map((text) => text.props.children)).toEqual([
        "48.2M | $50.2",
        "缓存 45.6M，新增 2.6M，缓存 94.6%",
      ]);
      expect(cells[3].findAllByType(Text).map((text) => text.props.children)).toEqual([
        "96.4M | $1.23K",
        "缓存 91.2M，新增 5.2M，缓存 94.6%",
      ]);
      const detail = cells[2].findAllByType(Text)[1];
      expect(detail.props.style.color).toBe(theme.colors.foregroundMuted);
      expect(detail.props.numberOfLines).toBe(1);
      expect(cells[2].props.style[0].minWidth).toBeGreaterThanOrEqual(300);
      expect(
        row("empty").findAllByProps({ role: "cell" })[2].findAllByType(Text)[1].props.children,
      ).toBe("缓存 0，新增 0，缓存 0%");
      expect(
        row("unknown").findAllByProps({ role: "cell" })[2].findAllByType(Text)[1].props.children,
      ).toBe("缓存明细未提供");
    },
  );

  it("keeps the last cache details visible when a usage refresh fails", async () => {
    mock.usage.mockResolvedValue({
      snapshot: {
        models: [
          {
            model: "alder",
            todayTokens: 100,
            weekTokens: 200,
            todayCachedTokens: 80,
            weekCachedTokens: 160,
          },
        ],
        todayStart: 0,
        weekStart: 0,
        timeZone: "UTC",
        refreshedAt: 1000,
      },
      refreshError: "本机用量读取失败",
    });
    await render();
    expect(tree.root.findAllByProps({ accessibilityRole: "alert" })).toHaveLength(1);
    expect(
      row("alder").findAllByProps({ role: "cell" })[2].findAllByType(Text)[1].props.children,
    ).toBe("缓存 80，新增 20，缓存 80%");
  });
});
