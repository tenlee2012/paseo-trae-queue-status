import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { describe, expect, it } from "vitest";
import { TraeQuestionToolApproval } from "./question-tool-approval.js";

function request(
  name = "mcp__paseo_questions__AskUserQuestion",
  sessionId = "s",
  kind = "allow_once",
): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    id: "permission",
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: { toolCallId: "call", name },
      options: [
        { optionId: "reject", kind: "reject_once" },
        { optionId: "allow", kind },
      ],
    },
  };
}
function bound(method = "session/new", enabled = true, failed = false) {
  const bridge = new TraeQuestionToolApproval();
  bridge.outgoing({
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      sessionId: "s",
      mcpServers: enabled ? [{ name: "paseo_questions" }] : [],
    },
  });
  bridge.incoming(
    failed
      ? { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Failed" } }
      : { jsonrpc: "2.0", id: 1, result: method === "session/load" ? {} : { sessionId: "s" } },
  );
  return bridge;
}

describe("Paseo question tool execution approval", () => {
  it.each(["session/new", "session/load"])(
    "approves only one execution for an injected question tool after %s",
    (method) => {
      expect(bound(method).incoming(request())).toEqual({
        jsonrpc: "2.0",
        id: "permission",
        result: {
          outcome: { outcome: "selected", optionId: "allow" },
        },
      });
    },
  );

  it.each([
    request("mcp__other__AskUserQuestion"),
    request("mcp__paseo_questions__WriteFile"),
    request("AskUserQuestion"),
    request(undefined, "other-session"),
    request(undefined, undefined, "allow_always"),
  ])("leaves unrelated or broader permission requests to the host (%j)", (message) => {
    expect(bound().incoming(message)).toBeUndefined();
  });

  it("requires successful registration of the plugin's question server", () => {
    expect(new TraeQuestionToolApproval().incoming(request())).toBeUndefined();
    expect(bound("session/new", false).incoming(request())).toBeUndefined();
    expect(bound("session/new", true, true).incoming(request())).toBeUndefined();
  });
});
