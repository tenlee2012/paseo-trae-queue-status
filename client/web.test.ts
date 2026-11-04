import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebOverlay } from "./web.js";

const host = vi.hoisted(() => ({
  platform: "web",
  render: vi.fn(),
  update: vi.fn(),
  unmount: vi.fn(),
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return host.platform;
    },
  },
  render: host.render,
}));
const container = { style: {}, contains: vi.fn(() => false), remove: vi.fn() };
const append = vi.fn();
const addListener = vi.fn();
const removeListener = vi.fn();
beforeEach(() => {
  host.platform = "web";
  host.render.mockReturnValue({ render: host.update, unmount: host.unmount });
  vi.stubGlobal("document", {
    body: { appendChild: append },
    createElement: vi.fn(() => container),
  });
  vi.stubGlobal("window", { addEventListener: addListener, removeEventListener: removeListener });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("web hover overlay", () => {
  it("renders RN content above scroll containers without blocking the underlying pointer", async () => {
    const overlay = createWebOverlay(vi.fn())!;
    expect(append).toHaveBeenCalledWith(container);
    expect(container.style).toMatchObject({
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "2147483647",
    });
    overlay.render("fixture");
    expect(host.render).toHaveBeenCalledWith("fixture", container);
    overlay.render("updated");
    expect(host.update).toHaveBeenCalledWith("updated");
    overlay.dispose();
    overlay.dispose();
    overlay.render("disposed");
    await Promise.resolve();
    expect(host.render).toHaveBeenCalledTimes(1);
    expect(host.unmount).toHaveBeenCalledOnce();
    expect(container.remove).toHaveBeenCalledOnce();
    expect(removeListener.mock.calls).toEqual(addListener.mock.calls);
  });

  it("dismisses on Escape, window resize, and ancestor scrolling", () => {
    const dismiss = vi.fn();
    const overlay = createWebOverlay(dismiss)!;
    const scroll = addListener.mock.calls.find(([event]) => event === "scroll")!;
    expect(scroll[2]).toBe(true);
    expect(addListener).toHaveBeenCalledWith("resize", dismiss);
    container.contains.mockReturnValueOnce(true);
    scroll[1]({ target: {} });
    expect(dismiss).not.toHaveBeenCalled();
    scroll[1]({ target: {} });
    expect(dismiss).toHaveBeenCalledOnce();
    const keydown = addListener.mock.calls.find(([event]) => event === "keydown")![1];
    keydown({ key: "Enter" });
    expect(dismiss).toHaveBeenCalledOnce();
    keydown({ key: "Escape" });
    expect(dismiss).toHaveBeenCalledTimes(2);
    overlay.dispose();
  });

  it("does not access DOM globals on native clients", () => {
    host.platform = "ios";
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("window", undefined);
    expect(createWebOverlay(vi.fn())).toBeNull();
    expect(host.render).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });
});
