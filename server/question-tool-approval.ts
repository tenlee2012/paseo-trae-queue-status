import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { z } from "zod";
import { QUESTION_SERVER_NAME, QUESTION_TOOL_NAME } from "./question-tool.js";

const sessionSchema = z.object({
  sessionId: z.string().optional(),
  mcpServers: z.array(z.object({ name: z.string() })),
});
const permissionSchema = z.object({
  sessionId: z.string(),
  toolCall: z.object({ name: z.string().optional(), title: z.string().optional() }),
  options: z.array(z.object({ optionId: z.string(), kind: z.string() })),
});

// The provider reserves this server name and supplies its own local MCP server.
// Approve only execution of its question tool; the answer still requires user input.
export class TraeQuestionToolApproval {
  private pending: { id: string | number; sessionId?: string } | undefined;
  private sessionId: string | undefined;

  outgoing(message: AcpStreamMessage): void {
    if (
      !("method" in message) ||
      !("id" in message) ||
      message.id === null ||
      (message.method !== "session/new" && message.method !== "session/load")
    )
      return;
    this.sessionId = undefined;
    this.pending = undefined;
    const params = sessionSchema.safeParse(message.params);
    if (
      params.success &&
      params.data.mcpServers.some((server) => server.name === QUESTION_SERVER_NAME)
    )
      this.pending = { id: message.id, sessionId: params.data.sessionId };
  }

  incoming(message: AcpStreamMessage): AcpStreamMessage | undefined {
    if (!("method" in message)) {
      if (this.pending && message.id === this.pending.id) {
        if ("result" in message) {
          const result = z.object({ sessionId: z.string().optional() }).safeParse(message.result);
          if (result.success) this.sessionId = result.data.sessionId ?? this.pending.sessionId;
        }
        this.pending = undefined;
      }
      return undefined;
    }
    if (
      message.method !== "session/request_permission" ||
      !("id" in message) ||
      message.id === null
    )
      return undefined;
    const parsed = permissionSchema.safeParse(message.params);
    if (!parsed.success || !this.sessionId || parsed.data.sessionId !== this.sessionId)
      return undefined;
    const { toolCall, options } = parsed.data;
    if ((toolCall.name ?? toolCall.title) !== `mcp__${QUESTION_SERVER_NAME}__${QUESTION_TOOL_NAME}`)
      return undefined;
    const allow = options.find((option) => option.kind === "allow_once");
    if (!allow) return undefined;
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: { outcome: { outcome: "selected", optionId: allow.optionId } },
    };
  }
}
