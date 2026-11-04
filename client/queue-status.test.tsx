import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueueStatusCard } from "./queue-status.js";
import { contrast, darkTheme, lightTheme, themeCases } from "./__tests__/themes.js";
vi.mock("react-native", () => ({ View: "View", Text: "Text" }));
vi.mock("@getpaseo/plugin/client/ui", () => ({ Icon: "Icon" }));
let tree: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = undefined;
  vi.unstubAllGlobals();
});
function props(theme = lightTheme, active = true, compact = false) {
  return {
    theme,
    layout: { compact, platform: "web" },
    item: { data: { active, message: "测试排队状态" } },
  } as Parameters<typeof QueueStatusCard>[0];
}
describe("queue status themes", () => {
  it.each(themeCases)("adapts active and completed cards in $name", async ({ theme, compact }) => {
    await act(async () => {
      tree = create(<QueueStatusCard {...props(theme, true, compact)} />);
    });
    for (const active of [true, false]) {
      // oxlint-disable-next-line no-await-in-loop
      await act(async () => tree!.update(<QueueStatusCard {...props(theme, active, compact)} />));
      expect(tree!.root.findByType(Text).props.style.color).toBe(theme.colors.foreground);
      expect(tree!.root.findByType(Icon).props.color).toBe(
        active ? theme.colors.accent : theme.colors.foregroundMuted,
      );
      const card = tree!.root.findByType(View).props.style;
      expect(card.backgroundColor).toBe(theme.colors.surface1);
      expect(card.borderColor).toBe(theme.colors.border);
      expect(contrast(theme.colors.foreground, card.backgroundColor)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("refreshes memoized colors on a live theme switch", async () => {
    await act(async () => {
      tree = create(<QueueStatusCard {...props()} />);
    });
    for (const theme of [darkTheme, lightTheme]) {
      // oxlint-disable-next-line no-await-in-loop
      await act(async () => tree!.update(<QueueStatusCard {...props(theme)} />));
      expect(tree!.root.findByType(Text).props.style.color).toBe(theme.colors.foreground);
      expect(tree!.root.findByType(Icon).props.color).toBe(theme.colors.accent);
      expect(tree!.root.findByType(View).props.style.backgroundColor).toBe(theme.colors.surface1);
    }
  });
});
