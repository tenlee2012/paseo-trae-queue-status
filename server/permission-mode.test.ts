import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { describe, expect, it } from "vitest";
import { TraePermissionModeBridge } from "./permission-mode.js";

const selector = {
  id: "native_permissions",
  name: "Permissions",
  category: "mode",
  type: "select",
  currentValue: "default",
  options: [
    { value: "default", name: "Default" },
    { value: "auto", name: "Auto" },
  ],
};

function open(
  bridge: TraePermissionModeBridge,
  configOptions: unknown[] = [selector],
  modes?: unknown,
) {
  bridge.outgoing({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
  const response: AcpStreamMessage = {
    jsonrpc: "2.0",
    id: 1,
    result: { sessionId: "native-1", configOptions, modes },
  };
  return { response, incoming: bridge.incoming(response) };
}

function setMode(id = 2): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/set_mode",
    params: { sessionId: "native-1", modeId: "auto" },
  };
}

describe("config-only permission modes", () => {
  it("derives modes from grouped values and uses the declared config ID", () => {
    const bridge = new TraePermissionModeBridge();
    const grouped = {
      ...selector,
      options: [{ group: "permissions", name: "Permissions", options: selector.options }],
    };
    expect(open(bridge, [grouped]).incoming).toMatchObject([
      {
        result: {
          modes: {
            currentModeId: "default",
            availableModes: [
              { id: "default", name: "Default" },
              { id: "auto", name: "Auto" },
            ],
          },
          configOptions: [grouped],
        },
      },
    ]);
    expect(bridge.outgoing(setMode())).toMatchObject({
      method: "session/set_config_option",
      params: { sessionId: "native-1", configId: "native_permissions", value: "auto" },
    });
  });

  it("preserves the native legacy mode API when it is available", () => {
    const bridge = new TraePermissionModeBridge();
    const { response, incoming } = open(bridge, [selector], {
      currentModeId: "default",
      availableModes: [{ id: "default", name: "Default" }],
    });
    expect(incoming).toEqual([response]);
    expect(bridge.outgoing(setMode())).toEqual(setMode());
  });

  it.each([
    [],
    [{ ...selector, category: "model_config" }],
    [{ ...selector, currentValue: "unavailable" }],
    [{ ...selector, options: [] }],
  ])("does not invent permissions from unusable selectors: %j", (...options) => {
    const bridge = new TraePermissionModeBridge();
    const { response, incoming } = open(bridge, options);
    expect(incoming).toEqual([response]);
    expect(bridge.outgoing(setMode())).toEqual(setMode());
  });

  it("synchronizes native permission changes reported only through config options", () => {
    const bridge = new TraePermissionModeBridge();
    open(bridge);
    const notification: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "native-1",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [{ ...selector, currentValue: "auto" }],
        },
      },
    };
    expect(bridge.incoming(notification)).toEqual([
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "native-1",
          update: { sessionUpdate: "current_mode_update", currentModeId: "auto" },
        },
      },
      notification,
    ]);
  });

  it.each([{}, { configOptions: [selector] }])(
    "rejects unconfirmed permission acknowledgements: %j",
    (result) => {
      const bridge = new TraePermissionModeBridge();
      open(bridge);
      bridge.outgoing(setMode());
      expect(bridge.incoming({ jsonrpc: "2.0", id: 2, result })).toMatchObject([
        {
          error: { message: "TRAE CLI did not confirm the selected permission mode" },
        },
      ]);
    },
  );

  it("releases config-only mode bindings when a session closes", () => {
    const bridge = new TraePermissionModeBridge();
    open(bridge);
    bridge.outgoing({
      jsonrpc: "2.0",
      id: 2,
      method: "session/close",
      params: { sessionId: "native-1" },
    });
    bridge.incoming({ jsonrpc: "2.0", id: 2, result: {} });
    expect(bridge.outgoing(setMode(3))).toEqual(setMode(3));
  });
});
