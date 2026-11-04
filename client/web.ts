import type { ReactNode } from "react";
import * as Native from "react-native";

// React Native Web's renderer is supplied by Paseo's react-native host module.
// Keep DOM access in this web-only adapter; all overlay content uses RN views.
interface OverlayElement {
  style: Record<string, string>;
  contains(target: unknown): boolean;
  remove(): void;
}
interface WebRenderer {
  render(
    content: ReactNode,
    container: OverlayElement,
  ): {
    render(content: ReactNode): void;
    unmount(): void;
  };
}
type WebListener = (event: { key?: string; target?: unknown }) => void;
declare const document: {
  body: { appendChild(element: OverlayElement): void };
  createElement(tag: "div"): OverlayElement;
};
declare const window: {
  addEventListener(type: string, listener: WebListener, capture?: boolean): void;
  removeEventListener(type: string, listener: WebListener, capture?: boolean): void;
};

export function createWebOverlay(dismiss: () => void) {
  if (Native.Platform.OS !== "web") return null;
  const renderer = Native as unknown as WebRenderer;
  const container = document.createElement("div");
  Object.assign(container.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
    zIndex: "2147483647",
  });
  document.body.appendChild(container);
  const onKeyDown: WebListener = (event) => {
    if (event.key === "Escape") dismiss();
  };
  const onScroll: WebListener = (event) => {
    if (event.target && event.target !== window && container.contains(event.target)) return;
    dismiss();
  };
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", dismiss);
  window.addEventListener("keydown", onKeyDown);
  let disposed = false;
  let root: ReturnType<WebRenderer["render"]> | undefined;
  return {
    render(content: ReactNode) {
      if (disposed) return;
      if (root) root.render(content);
      else root = renderer.render(content, container);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", onKeyDown);
      // Dispose this separate root after the owning React commit completes.
      queueMicrotask(() => {
        root?.unmount();
        container.remove();
      });
    },
  };
}
