import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type {
  ProviderEvent,
  ProviderMcpServerConfig,
  ProviderPermissionResponse,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { QUESTION_TOOL_GUIDANCE } from "./prompt-text.js";

export { QUESTION_TOOL_GUIDANCE } from "./prompt-text.js";

export const QUESTION_SERVER_NAME = "paseo_questions";
export const QUESTION_TOOL_NAME = "AskUserQuestion";

const questionSchema = z.object({
  header: z.string().min(1),
  question: z.string().min(1),
  options: z
    .array(z.object({ label: z.string().min(1), description: z.string().optional() }))
    .default([]),
  multiSelect: z.boolean().default(false),
  allowOther: z.boolean().default(true),
});
const inputSchema = z
  .object({ questions: z.array(questionSchema).min(1).max(12) })
  .superRefine((input, context) => {
    const headers = input.questions.map((question) => question.header);
    if (new Set(headers).size !== headers.length)
      context.addIssue({ code: "custom", message: "Question headers must be unique" });
  });
const rpcSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
const callSchema = z.object({ name: z.literal(QUESTION_TOOL_NAME), arguments: inputSchema });
const answersSchema = z.record(z.string(), z.string());
type QuestionInput = z.infer<typeof inputSchema>;
interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
interface PendingQuestion {
  sessionId: string;
  requestId: string | number;
  input: QuestionInput;
  resolve(result: ToolResult): void;
}

// This small stateless Streamable HTTP server exposes only one local interaction
// tool. Keeping it in the provider lets answers use Paseo's existing question UI.
export class PaseoQuestionTool {
  private readonly server: Server;
  private readonly sessions = new Map<string, string>();
  private readonly pending = new Map<string, PendingQuestion>();
  private origin: string | null = null;
  private starting: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly emit: (event: ProviderEvent) => void) {
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error: unknown) => {
        console.error(
          "Paseo question request failed",
          error instanceof Error ? error.message : String(error),
        );
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
  }

  async open(sessionId: string): Promise<ProviderMcpServerConfig> {
    if (this.closed) throw new Error("Paseo question service is closed");
    this.starting ??= this.start();
    await this.starting;
    if (this.closed) throw new Error("Paseo question service is closed");
    let token = this.sessions.get(sessionId);
    if (!token) {
      token = randomUUID();
      this.sessions.set(sessionId, token);
    }
    return { type: "http", url: `${this.origin}/mcp/${token}`, alwaysLoad: true };
  }

  respond(permissionId: string, sessionId: string, response: ProviderPermissionResponse): void {
    const pending = this.pending.get(permissionId);
    if (!pending || pending.sessionId !== sessionId)
      throw new Error(`Unknown Paseo question: ${permissionId}`);
    if (response.behavior === "deny") {
      this.finish(permissionId, cancelledResult());
      return;
    }
    const answers = answersSchema.parse(response.updatedInput?.answers);
    for (const question of pending.input.questions) {
      const answer = answers[question.header];
      if (!answer?.trim()) throw new Error(`Answer required: ${question.header}`);
      if (
        !question.multiSelect &&
        !question.allowOther &&
        question.options.length > 0 &&
        !question.options.some((option) => option.label === answer)
      )
        throw new Error(`Invalid choice: ${question.header}`);
    }
    this.finish(permissionId, { content: [{ type: "text", text: JSON.stringify({ answers }) }] });
  }

  cancel(sessionId: string): void {
    for (const [id, pending] of this.pending)
      if (pending.sessionId === sessionId) this.finish(id, cancelledResult());
  }

  release(sessionId: string): void {
    this.cancel(sessionId);
    this.sessions.delete(sessionId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.starting) await this.starting;
    for (const id of this.pending.keys()) this.finish(id, cancelledResult());
    this.sessions.clear();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
      this.server.closeAllConnections();
    });
  }

  private start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.removeListener("error", reject);
        const address = this.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Question server has no TCP address"));
          return;
        }
        this.origin = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = request.headers.origin;
    if (origin && origin !== this.origin) {
      response.writeHead(403).end();
      return;
    }
    if (`http://${request.headers.host}` !== this.origin) {
      response.writeHead(403).end();
      return;
    }
    const sessionId = [...this.sessions].find(([, token]) => request.url === `/mcp/${token}`)?.[0];
    if (!sessionId || this.closed) {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    request.setEncoding("utf8");
    let body = "";
    for await (const chunk of request) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 65536) {
        response.writeHead(413).end();
        request.resume();
        return;
      }
    }
    if (this.closed || !this.sessions.has(sessionId)) {
      response.writeHead(404).end();
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const parsed = rpcSchema.safeParse(raw);
    if (!parsed.success) {
      response.writeHead(400).end();
      return;
    }
    const rpc = parsed.data;
    if (rpc.id === undefined) {
      if (rpc.method === "notifications/cancelled") this.cancelRequest(sessionId, rpc.params);
      response.writeHead(202).end();
      return;
    }
    let result: unknown;
    switch (rpc.method) {
      case "initialize":
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: QUESTION_SERVER_NAME, version: "1.0.0" },
          instructions: QUESTION_TOOL_GUIDANCE,
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = {
          tools: [
            {
              name: QUESTION_TOOL_NAME,
              description:
                "Ask the user questions with selectable options in Paseo and wait for their answers. Works in Default, Full Access and Plan modes. Use for clarification, preferences and choices instead of native request_user_input. Questions do not change permissions or execute commands.",
              inputSchema: z.toJSONSchema(inputSchema, { io: "input" }),
              annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
            },
          ],
        };
        break;
      case "tools/call": {
        const call = callSchema.safeParse(rpc.params);
        if (!call.success) {
          result = { content: [{ type: "text", text: call.error.message }], isError: true };
          break;
        }
        result = await this.ask({
          sessionId,
          requestId: rpc.id,
          input: call.data.arguments,
          response,
        });
        break;
      }
      default:
        sendJson(response, {
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32601, message: "Method not found" },
        });
        return;
    }
    sendJson(response, { jsonrpc: "2.0", id: rpc.id, result });
  }

  private ask(options: {
    sessionId: string;
    requestId: string | number;
    input: QuestionInput;
    response: ServerResponse;
  }): Promise<ToolResult> {
    const id = `paseo-question:${randomUUID()}`;
    return new Promise((resolve) => {
      this.pending.set(id, {
        sessionId: options.sessionId,
        requestId: options.requestId,
        input: options.input,
        resolve,
      });
      options.response.once("close", () => {
        if (!options.response.writableFinished) this.finish(id, cancelledResult());
      });
      this.emit({
        type: "session.permission",
        sessionId: options.sessionId,
        request: {
          id,
          name: QUESTION_TOOL_NAME,
          kind: "question",
          title: "Question",
          input: options.input,
        },
      });
    });
  }

  private cancelRequest(sessionId: string, params: unknown): void {
    const parsed = z.object({ requestId: z.union([z.string(), z.number()]) }).safeParse(params);
    if (!parsed.success) return;
    for (const [id, pending] of this.pending)
      if (pending.sessionId === sessionId && pending.requestId === parsed.data.requestId)
        this.finish(id, cancelledResult());
  }

  private finish(id: string, result: ToolResult): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.resolve(result);
    this.emit({
      type: "session.permission_resolved",
      sessionId: pending.sessionId,
      permissionId: id,
    });
  }
}

function sendJson(response: ServerResponse, payload: unknown): void {
  if (response.destroyed) return;
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}
function cancelledResult(): ToolResult {
  return {
    content: [{ type: "text", text: "The user dismissed the question or the session stopped." }],
    isError: true,
  };
}
