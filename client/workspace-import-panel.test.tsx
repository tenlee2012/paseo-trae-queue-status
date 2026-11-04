import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceImportPanel } from "./workspace-import-panel.js";
import { darkTheme, lightTheme, styleOf } from "./__tests__/themes.js";

const mock = vi.hoisted(() => ({ list: vi.fn(), import: vi.fn(), inputMounts: 0 }));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { name: string }) =>
    contract.name === "sessions.list" ? mock.list : mock.import,
  useWorkspace: () => ({ name: "Workspace B", directory: "/workspace/B" }),
}));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ActivityIndicator: "ActivityIndicator",
}));
vi.mock("@getpaseo/plugin/client/ui", async () => {
  const React = await import("react");
  return {
    Icon: "Icon",
    ScrollView: "ScrollView",
    // Paseo's Loading is a file-panel overlay. Its presence during search would
    // cover the input and controls even though their React instances survive.
    Loading: () => React.createElement("GlobalLoading", { testID: "global-loading" }),
    TextInput: React.forwardRef((props, ref) => {
      React.useEffect(() => {
        mock.inputMounts++;
      }, []);
      return React.createElement("TextInput", { ...props, ref });
    }),
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const entry = (id: string, title: string) => ({
  providerHandleId: id,
  title,
  preview: title + " first prompt",
  lastActivityAt: "2026-10-30T00:00:00Z",
});
const response = (entries = [entry("alpha", "Alpha task"), entry("beta", "Beta task")]) => ({
  workspaceId: "workspace-B",
  directory: "/workspace/B",
  entries,
  filteredAlreadyImportedCount: 0,
  errors: [],
});
const props = {
  workspaceId: "workspace-B",
  host: { id: "host-1", label: "This host" },
  layout: { compact: false, platform: "web" },
  theme: {
    colors: {
      foreground: "black",
      foregroundMuted: "gray",
      surface0: "white",
      surface1: "white",
      accent: "green",
      border: "gray",
      statusDanger: "red",
    },
  },
} as unknown as PluginWorkspacePanelProps;

let tree: ReactTestRenderer;
let cache: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mock.list.mockReset();
  mock.import.mockReset();
  mock.inputMounts = 0;
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  cache.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => {
    tree = create(
      <QueryClientProvider client={cache}>
        <WorkspaceImportPanel {...props} />
      </QueryClientProvider>,
    );
  });
}
async function settle(action: () => void) {
  await act(async () => {
    action();
    await vi.advanceTimersByTimeAsync(0);
  });
}
const input = () => tree.root.findByProps({ testID: "trae-session-search" });
const refresh = () => tree.root.findByProps({ testID: "trae-session-refresh" });
const rendered = () => JSON.stringify(tree.toJSON());

describe("workspace import panel interactions", () => {
  it("updates text, icons, fields, and backgrounds during live theme changes", async () => {
    mock.list.mockResolvedValue(response());
    await render();
    await settle(() => {});
    const originalInput = input();
    await settle(() => input().props.onChangeText("Alpha"));
    for (const theme of [lightTheme, darkTheme, lightTheme]) {
      // oxlint-disable-next-line no-await-in-loop
      await act(async () =>
        tree.update(
          <QueryClientProvider client={cache}>
            <WorkspaceImportPanel {...props} theme={theme} />
          </QueryClientProvider>,
        ),
      );
      expect(input()).toBe(originalInput);
      expect(input().props.value).toBe("Alpha");
      expect(styleOf(input().props.style).color).toBe(theme.colors.foreground);
      expect(input().props.placeholderTextColor).toBe(theme.colors.foregroundMuted);
      expect(tree.root.findByType(ScrollView).props.style.backgroundColor).toBe(
        theme.colors.surface0,
      );
      for (const node of tree.root.findAllByType(Text))
        expect(Object.values(theme.colors)).toContain(styleOf(node.props.style).color);
      for (const node of tree.root.findAllByType(Icon))
        expect(Object.values(theme.colors)).toContain(node.props.color);
    }
  });

  it("keeps the form visible during initial loading without the host's full-page overlay", async () => {
    mock.list.mockReturnValue(new Promise(() => {}));
    await render();
    expect(input().props.value).toBe("");
    expect(refresh().props.disabled).toBe(false);
    expect(rendered()).toContain("正在加载会话");
    expect(tree.root.findAllByProps({ testID: "global-loading" })).toHaveLength(0);
  });

  it("filters immediately, keeps input mounted and retains matching rows while remote search runs", async () => {
    const initial = deferred<ReturnType<typeof response>>();
    const search = deferred<ReturnType<typeof response>>();
    mock.list.mockReturnValueOnce(initial.promise).mockReturnValueOnce(search.promise);
    await render();
    await settle(() => initial.resolve(response()));
    const originalInput = input();
    await settle(() => input().props.onChangeText("Beta"));
    expect(rendered()).toContain("Beta task");
    expect(rendered()).not.toContain("Alpha task");
    expect(mock.list).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mock.list).toHaveBeenLastCalledWith({
      workspaceId: "workspace-B",
      query: "Beta",
      limit: 50,
    });
    expect(input()).toBe(originalInput);
    expect(input().props.value).toBe("Beta");
    expect(mock.inputMounts).toBe(1);
    expect(rendered()).toContain("Beta task");
    expect(rendered()).toContain("正在搜索");
    expect(tree.root.findAllByProps({ testID: "global-loading" })).toHaveLength(0);
    expect(refresh().props.disabled).toBe(false);
    await settle(() => refresh().props.onPress());
    expect(refresh().props.disabled).toBe(true);
    expect(mock.list).toHaveBeenCalledTimes(2);
    await settle(() => search.resolve(response([entry("beta-new", "Beta remote match")])));
    expect(rendered()).toContain("Beta remote match");
    expect(refresh().props.disabled).toBe(false);
    expect(input()).toBe(originalInput);
  });

  it("refreshes the list, shows progress and prevents duplicate clicks without hiding existing rows", async () => {
    const initial = deferred<ReturnType<typeof response>>();
    const next = deferred<ReturnType<typeof response>>();
    mock.list.mockReturnValueOnce(initial.promise).mockReturnValueOnce(next.promise);
    await render();
    await settle(() => initial.resolve(response()));
    await settle(() => {
      refresh().props.onPress();
      refresh().props.onPress();
    });
    expect(mock.list).toHaveBeenCalledTimes(2);
    expect(refresh().props.accessibilityState.busy).toBe(true);
    expect(rendered()).toContain("刷新中");
    expect(rendered()).toContain("Alpha task");
    await settle(() => next.resolve(response([entry("fresh", "A fresh conversation")])));
    expect(rendered()).toContain("A fresh conversation");
    expect(rendered()).not.toContain("Alpha task");
    expect(refresh().props.disabled).toBe(false);
    expect(rendered()).toContain("更新于");
  });

  it("keeps the last result after a failed refresh and makes retry available", async () => {
    const initial = deferred<ReturnType<typeof response>>();
    const next = deferred<ReturnType<typeof response>>();
    mock.list.mockReturnValueOnce(initial.promise).mockReturnValueOnce(next.promise);
    await render();
    await settle(() => initial.resolve(response()));
    await settle(() => refresh().props.onPress());
    await settle(() =>
      next.reject(
        new Error(
          "Request failed: 暂时无法读取会话 requestType=plugin.rpc.invoke.request code=handler_error",
        ),
      ),
    );
    expect(rendered()).toContain("Alpha task");
    expect(rendered()).toContain("暂时无法读取会话");
    expect(rendered()).not.toContain("requestType=");
    expect(refresh().props.disabled).toBe(false);
  });
});
