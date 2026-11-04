import type {
  ProviderConfigChanges,
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
} from "@getpaseo/plugin/server/provider";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { refreshModelLoads } from "../client/model-load-refresh.js";
import { TraeModelLoadRefresh } from "./model-load-refresh.js";
import subagentFrames from "./fixtures/trae-subagents-0.214.1.json";
import { createTraeQueueStatusProvider } from "./provider.js";
import { PaseoQuestionTool } from "./question-tool.js";
import { canonicalSessionCwd, workspaceSessionPersistence } from "./session-persistence.js";

let usageTestHome: string;
beforeAll(async () => {
  usageTestHome = await mkdtemp(join(tmpdir(), "trae-provider-usage-"));
  vi.stubEnv("TRAECLI_HOME", usageTestHome);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(usageTestHome, { recursive: true, force: true });
});

const FAKE_TRAE_ACP = String.raw`
let buffer = "";
let currentModelId = process.env.INITIAL_MODEL || "alder/high";
const modes = { currentModeId: process.env.QUESTION_PERMISSION_MODE || "bypass_permissions", availableModes: [
  { id: "default", name: "Default", description: "Ask before tools" },
  { id: "auto", name: "Auto", description: "Automatically approve safe tools" },
  { id: "bypass_permissions", name: "Full Access", description: "Run without permission prompts" },
] };
if (process.env.WITH_PLAN) modes.availableModes.push({ id: "plan", name: "Plan", description: "Inspect without making changes" });
if (process.env.INITIAL_PLAN) modes.currentModeId = "plan";
const ids = ["alder/low", "alder/high", "alder/max/low", "alder/max/high", "fixed-model"].filter((id) => !process.env.NO_MAX || !id.includes("/max/"));
const configOptions = [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "alder", options: [
    { value: "alder", name: "Alder", _meta: { trae: { supportsMaxMode: true, load: { percent: 214 } } } },
    { value: "fixed-model", name: "Fixed Model", _meta: { trae: { supportsMaxMode: false, load: { percent: 140 } } } },
  ] },
  { id: "effort", name: "Thinking", category: "thought_level", type: "select", currentValue: "high", options: [
    { value: "low", name: "Low" }, { value: "high", name: "High" },
  ] },
];
if (process.env.QUOTA_MODEL) {
  ids.push("quota-model/high", "quota-model/max/high");
  configOptions[0].options.push({ value: "quota-model", name: "quota-model", _meta: { trae: {
    supportsMaxMode: true, load: { percent: 257 },
    weeklyQuota: { applies: true, isDepleted: true, usedPercent: 100, remainingPercent: 0 },
  } } });
}
configOptions.push({ id: "permission_mode", name: "Permissions", category: "mode", type: "select", currentValue: modes.currentModeId,
  options: modes.availableModes.map((mode) => ({ value: mode.id, name: mode.name })) });
if (process.env.NATIVE_COLLABORATION) configOptions.push({
  id: "collaboration_mode", name: "Collaboration mode", category: "other", type: "select",
  currentValue: process.env.INITIAL_COLLABORATION || "default",
  options: process.env.EMPTY_COLLABORATION ? [] : [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }],
});
if (process.env.MODEL_FIXTURE) {
  const models = JSON.parse(process.env.MODEL_FIXTURE);
  ids.splice(0, ids.length, ...models.flatMap((model) => model.nativeIds));
  currentModelId = process.env.INITIAL_MODEL || ids[0];
  configOptions[0].currentValue = models[0].id;
  configOptions[0].options = models.map((model) => ({
    value: model.id, name: model.name,
    _meta: { trae: { supportsMaxMode: model.nativeIds.some((id) => id.startsWith(model.id + "/max")) } },
  }));
}
if (process.env.NO_MODE_CONFIG) configOptions.splice(configOptions.findIndex((option) => option.category === "mode"), 1);
let questionServerUrl;
let activePrompt = null;
let activeNativeTurn;
let usageInput = 0;
let usageOutput = 0;
const writeCallTrace = (type, payload = {}) => {
  if (!process.env.ACTIVITY_COUNTS || !process.env.TRAECLI_ROLLOUT_TRACE_ROOT) return;
  const fs = require("node:fs");
  const path = require("node:path");
  const directory = path.join(process.env.TRAECLI_ROLLOUT_TRACE_ROOT, "trace-fixture-native-1");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ schema_version: 1, root_thread_id: "native-1" }));
  fs.appendFileSync(path.join(directory, "trace.jsonl"), JSON.stringify({ schema_version: 1, wall_time_unix_ms: Date.now(), thread_id: "native-1", codex_turn_id: activeNativeTurn, payload: { type, ...payload } }) + "\n");
};
const writeUsage = (input, output, responseId) => {
  if (!process.env.USAGE_FILE) return;
  const fs = require("node:fs");
  const at = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n";
  if (!fs.existsSync(process.env.USAGE_FILE)) fs.writeFileSync(process.env.USAGE_FILE, at("session_meta", { id: "native-1" }));
  usageInput += input;
  usageOutput += output;
  fs.appendFileSync(process.env.USAGE_FILE,
    at("turn_context", { turn_id: activeNativeTurn, model: currentModelId }) +
    at("token_usage_record", {
      thread_id: "native-1", turn_id: activeNativeTurn, response_id: responseId,
      usage: { input_tokens: input, output_tokens: output, cached_input_tokens: input / 2, reasoning_output_tokens: output },
      thread_token_usage: { input_tokens: usageInput, output_tokens: usageOutput },
    }));
  writeCallTrace("inference_started", { inference_call_id: activeNativeTurn + responseId });
};
let cancelCount = 0;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const writeActivity = (id) => {
  if (!process.env.ACTIVITY_COUNTS) return;
  const update = (value) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-1", update: value } });
  update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Inspect" } });
  update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: " and continue" } });
  update({ sessionUpdate: "tool_call", toolCallId: id, title: "Read fixture", kind: "read", status: "in_progress" });
  update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
  writeCallTrace("code_cell_started", { model_visible_call_id: "exec-" + id });
  writeCallTrace("tool_call_started", { tool_call_id: id });
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (process.env.STARTUP_LOG) require("node:fs").appendFileSync(process.env.STARTUP_LOG, JSON.stringify({ args: process.argv.slice(2), request }) + "\n");
    if ((request.method === "session/new" || request.method === "session/load") && process.env.STARTUP_ERROR) {
      send({ jsonrpc: "2.0", id: request.id, error: JSON.parse(process.env.STARTUP_ERROR) });
      continue;
    }
    if (!request.method && request.id === "question-1") {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-1", update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(request.result) },
      } } });
      if (activePrompt) send({ jsonrpc: "2.0", id: activePrompt.id, result: { stopReason: "end_turn" } });
      activePrompt = null;
    } else if (request.method === "initialize") {
      if (process.env.QUESTION_MODE && !request.params.clientCapabilities?.elicitation?.form) {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Form support was not advertised" } });
        continue;
      }
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: request.params.protocolVersion,
          agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
          _meta: { steering: { supported: true } },
        },
      });
    } else if (request.method === "session/load") {
      questionServerUrl = request.params.mcpServers.find((server) => server.name === "paseo_questions")?.url;
      if (process.env.LOAD_CWD_LOG) require("node:fs").writeFileSync(process.env.LOAD_CWD_LOG, request.params.cwd);
      for (const update of JSON.parse(process.env.HISTORY_UPDATES || "[]")) {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: request.params.sessionId, update } });
      }
      for (const frame of JSON.parse(process.env.SUBAGENT_HISTORY || "[]")) send(frame);
      if (process.env.REJECT_LOAD) {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "History unavailable" } });
        continue;
      }
      send({ jsonrpc: "2.0", id: request.id, result: { modes: process.env.NO_MODES ? null : modes, configOptions: process.env.OMIT_CONFIG ? undefined : configOptions, models: {
        currentModelId, availableModels: process.env.OMIT_VARIANTS ? undefined : ids.map((modelId) => ({ modelId, name: modelId })),
      } } });
      setTimeout(() => send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: request.params.sessionId,
        update: { sessionUpdate: "available_commands_update", availableCommands: [] },
      } }), process.env.EARLY_COMMANDS ? 0 : 25);
    } else if (request.method === "session/new") {
      questionServerUrl = request.params.mcpServers.find((server) => server.name === "paseo_questions")?.url;
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { sessionId: "native-1", modes: process.env.NO_MODES ? null : modes, configOptions: process.env.OMIT_CONFIG ? undefined : configOptions, models: {
          currentModelId, availableModels: process.env.OMIT_VARIANTS ? undefined : ids.map((modelId) => ({ modelId, name: modelId })),
        } },
      });
      setTimeout(() => send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "native-1",
          update: { sessionUpdate: "available_commands_update", availableCommands: [] },
        },
      }), process.env.EARLY_COMMANDS ? 0 : 25);
    } else if (request.method === "session/list") {
      const pages = JSON.parse(process.env.SESSION_PAGES || "[]");
      const page = Number(request.params.cursor || "0");
      if (process.env.SESSION_LIST_ERROR) {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Session list unavailable" } });
      } else send({ jsonrpc: "2.0", id: request.id, result: { sessions: pages[page] || [], nextCursor: page + 1 < pages.length ? String(page + 1) : null } });
    } else if (request.method === "session/set_mode") {
      if (process.env.NO_MODES && !process.env.NO_MODE_CONFIG) {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Use the permission config option" } });
        continue;
      }
      if (process.env.MODE_LOG) require("node:fs").appendFileSync(process.env.MODE_LOG, request.params.modeId + "\n");
      if (request.params.modeId === process.env.REJECT_MODE) {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Plan temporarily unavailable" } });
        continue;
      }
      modes.currentModeId = request.params.modeId;
      const permission = configOptions.find((option) => option.id === "permission_mode");
      if (permission) permission.currentValue = request.params.modeId;
      if (process.env.WITH_PLAN) {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-1", update: { sessionUpdate: "current_mode_update", currentModeId: modes.currentModeId } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-1", update: { sessionUpdate: "config_option_update", configOptions } } });
      }
      send({ jsonrpc: "2.0", id: request.id, result: {} });
    } else if (request.method === "session/set_config_option") {
      const option = configOptions.find((option) => option.id === request.params.configId);
      if (option?.id === "collaboration_mode") {
        if (!option.options.some((entry) => entry.value === request.params.value) || request.params.value === process.env.REJECT_COLLABORATION) {
          send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Collaboration mode refused" } });
          continue;
        }
        option.currentValue = request.params.value;
        if (process.env.COLLABORATION_LOG) require("node:fs").appendFileSync(process.env.COLLABORATION_LOG, request.params.value + "\n");
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-1", update: { sessionUpdate: "config_option_update", configOptions } } });
        send({ jsonrpc: "2.0", id: request.id, result: { configOptions: process.env.PARTIAL_COLLABORATION ? configOptions.filter((entry) => entry.id !== "collaboration_mode") : configOptions } });
        continue;
      }
      if (option?.category !== "mode" || !option.options.some((entry) => entry.value === request.params.value)) {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Invalid permission config option" } });
        continue;
      }
      if (request.params.value === process.env.REJECT_MODE) {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Permission temporarily unavailable" } });
        continue;
      }
      if (process.env.MODE_LOG) require("node:fs").appendFileSync(process.env.MODE_LOG, request.params.value + "\n");
      modes.currentModeId = option.currentValue = request.params.value;
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-1", update: { sessionUpdate: "config_option_update", configOptions } } });
      send({ jsonrpc: "2.0", id: request.id, result: { configOptions } });
    } else if (request.method === "session/set_model") {
      if (request.params.modelId === process.env.REJECT_MODEL) {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Max temporarily unavailable" } });
      } else if (ids.includes(request.params.modelId)) {
        currentModelId = request.params.modelId;
        send({ jsonrpc: "2.0", id: request.id, result: {} });
      } else send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Invalid model" } });
    } else if (request.method === "session/prompt") {
      if (process.env.SUBAGENT_LIVE) {
        for (const frame of JSON.parse(process.env.SUBAGENT_LIVE)) send(frame);
        send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
        continue;
      }
      activePrompt = request;
      activeNativeTurn = "native-turn-" + request.id;
      writeCallTrace("codex_turn_started");
      writeUsage(100, 10, "initial-request");
      writeActivity("initial-" + request.id);
      if (request.params.prompt.some((part) => part.text?.includes("For questions that need the user's choice in Paseo,"))) throw new Error("Question guidance polluted user prompt");
      if (process.env.MCP_QUESTION_MODE) {
        void (async () => {
          if (!questionServerUrl) throw new Error("Missing Paseo question integration");
          const initialized = await fetch(questionServerUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "mcp-init", method: "initialize" }) });
          if (!(await initialized.json()).result.instructions?.includes("paseo_questions")) throw new Error("Missing MCP question instructions");
          if (process.env.QUESTION_PERMISSION_MODE && modes.currentModeId !== process.env.QUESTION_PERMISSION_MODE) throw new Error("Question changed the native permission mode");
          const reply = await fetch(questionServerUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
            jsonrpc: "2.0", id: "mcp-question", method: "tools/call", params: { name: "AskUserQuestion", arguments: { questions: [
              { header: "Season", question: "Which season?", options: [{ label: "春天", description: "Flowers" }, { label: "秋天" }], allowOther: false },
              { header: "Activities", question: "What to do?", options: [{ label: "Hiking" }, { label: "Reading" }], multiSelect: true },
            ] } },
          }) });
          const result = await reply.json();
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-1", update: {
            sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(result.result) },
          } } });
          send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
          activePrompt = null;
        })().catch((error) => { console.error(error); process.exit(1); });
        continue;
      }
      if (process.env.NATIVE_QUESTION_MODE) {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-1", update: {
          sessionUpdate: "tool_call", toolCallId: "ask-native", title: "Ask User Question", rawInput: { questions: [{
            id: "season", header: "季节偏好", question: "你喜欢哪个季节？", isOther: true, multiSelect: false,
            options: [{ label: "春天", description: "万物复苏" }, { label: "秋天", description: "秋高气爽" }],
          }] },
        } } });
        send({ jsonrpc: "2.0", id: "question-1", method: "elicitation/create", params: {
          mode: "form", sessionId: "native-1", toolCallId: "ask-native", message: "你喜欢哪个季节？",
          requestedSchema: { type: "object", properties: {
            question_0: { type: "string", title: "季节偏好", oneOf: [{ const: "春天", title: "春天" }, { const: "秋天", title: "秋天" }] },
            question_0_custom: { type: "string", title: "Other" },
          } },
        } });
        continue;
      }
      if (process.env.QUESTION_MODE) {
        send({ jsonrpc: "2.0", id: "question-1", method: "elicitation/create", params: {
          sessionId: "native-1", toolCallId: "ask-1", mode: "form", message: "Choose a season",
          requestedSchema: { type: "object", required: ["season", "activities"], properties: {
            season: { type: "string", title: "Season", description: "Which season?", oneOf: [
              { const: "spring", title: "春天", description: "Flowers" }, { const: "autumn", title: "秋天" },
            ] },
            activities: { type: "array", description: "What would you do?", items: { type: "string", enum: ["Hiking", "Reading"] } },
            notes: { type: "string", description: "Anything else?" },
          } },
        } });
        continue;
      }
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "native-1",
          update: {
            sessionUpdate: "session_info_update",
            _meta: {
              trae: {
                queueStatus: {
                  state: "queued",
                  position: currentModelId.includes("/max/") ? 7 : 5,
                },
              },
            },
          },
        },
      });
    } else if (request.method === "_session/steering") {
      const text = request.params?.prompt?.[0]?.text;
      if (cancelCount > 0 || request.params?.sessionId !== "native-1" || text !== "change course") {
        send({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32602, message: "invalid steering payload" },
        });
        continue;
      }
      writeUsage(200, 20, "steered-request");
      writeActivity("steered-" + request.id);
      writeCallTrace("codex_turn_ended", { status: "completed" });
      send({ jsonrpc: "2.0", id: request.id, result: { outcome: "injected" } });
      if (activePrompt) {
        const prompt = activePrompt;
        activePrompt = null;
        setTimeout(() => send({
          jsonrpc: "2.0",
          id: prompt.id,
          result: { stopReason: "end_turn" },
        }), 10);
      }
    } else if (request.method === "session/cancel") {
      cancelCount += 1;
    } else if (request.method === "session/close") {
      send({ jsonrpc: "2.0", id: request.id, result: {} });
    }
  }
});
`;

describe("TRAE queue-status provider", () => {
  it("lists later pages after empty and internal sessions, and searches before applying the limit", async () => {
    const registration = createTraeQueueStatusProvider(
      {
        command: process.execPath,
        args: ["-e", FAKE_TRAE_ACP],
        env: {
          ...process.env,
          TRAECLI_HOME: join(tmpdir(), "missing-trae-session-previews"),
          SESSION_PAGES: JSON.stringify([
            [],
            [
              {
                sessionId: "metadata",
                cwd: "/repo",
                title:
                  "Generate a title and git branch name for a coding agent based on the user prompt.",
              },
              { sessionId: "unrelated", cwd: "/elsewhere", title: "Unrelated workspace" },
              { sessionId: "other", cwd: "/repo", title: "Unrelated" },
            ],
            [{ sessionId: "native-1", cwd: "/repo", title: "Match me" }],
          ]),
        },
      },
      null,
    );
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["session.list"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({
        type: "sessions",
        requestId: "list-1",
        cwd: "/repo",
        query: "match",
        limit: 1,
      });
      expect(await waitForEvent(events, (event) => event.type === "sessions")).toMatchObject({
        sessions: [
          {
            title: "Match me",
            persistence: { version: 2, data: { sessionId: "native-1", workspaceCwd: "/repo" } },
          },
        ],
      });
      expect(events.some((event) => event.type === "request.failed")).toBe(false);
    } finally {
      await connection.close();
    }
  });

  it("loads a conversation from another directory in the selected workspace and replays its history", async () => {
    const root = await mkdtemp(join(tmpdir(), "trae-import-workspace-"));
    const destination = join(root, "workspace");
    const log = join(root, "load-cwd.txt");
    await mkdir(destination);
    const registration = createTraeQueueStatusProvider(
      {
        command: process.execPath,
        args: ["-e", FAKE_TRAE_ACP],
        env: {
          ...process.env,
          LOAD_CWD_LOG: log,
          TRAECLI_HOME: join(root, "missing-preview"),
          SESSION_PAGES: JSON.stringify([
            [{ sessionId: "native-1", cwd: "/original/project", title: "Continue the old task" }],
          ]),
          HISTORY_UPDATES: JSON.stringify([
            {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "The original task" },
            },
          ]),
        },
      },
      null,
    );
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["session.list", "session.persistence", "prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({ type: "sessions", requestId: "all-sources" });
      const listed = await waitForEvent(events, (event) => event.type === "sessions");
      if (listed.type !== "sessions") throw new Error("Missing import list");
      expect(listed.sessions).toHaveLength(1);
      const source = listed.sessions[0];
      expect(source).toMatchObject({ cwd: "/original/project", description: undefined });
      const input = openInput();
      const persistence = workspaceSessionPersistence(
        source.persistence,
        await canonicalSessionCwd(destination),
      );
      await connection.send({
        ...input,
        config: { ...input.config, cwd: destination },
        persistence,
        history: "replay",
      });
      await waitForEvent(events, (event) => event.type === "session.ready");
      expect(await readFile(log, "utf8")).toBe(destination);
      expect(events.find((event) => event.type === "session.opened")).toMatchObject({
        cwd: destination,
        persistence,
      });
      expect(events.find((event) => event.type === "timeline.item")).toMatchObject({
        item: { type: "user_message", text: "The original task" },
      });
    } finally {
      await connection.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reopens a closed A conversation in B without matching A's archived persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "trae-closed-workspace-"));
    const a = join(root, "A");
    const b = join(root, "B");
    await mkdir(a);
    await mkdir(b);
    const { connection, events } = await contextProvider({
      HISTORY_UPDATES: JSON.stringify([
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "History from A" } },
      ]),
    });
    const input = openInput();
    try {
      await connection.send({ ...input, config: { ...input.config, cwd: a } });
      await waitForEvent(events, (event) => event.type === "session.ready");
      const openedA = events.find((event) => event.type === "session.opened");
      if (openedA?.type !== "session.opened") throw new Error("Missing A session");
      const persistenceA = openedA.persistence!;
      await connection.send({
        type: "session.close",
        requestId: "close-a",
        sessionId: input.sessionId,
      });
      await waitForEvent(events, (event) => event.type === "session.closed");
      events.length = 0;
      await connection.send({
        ...input,
        requestId: "import-b",
        config: { ...input.config, cwd: b },
        persistence: persistenceA,
        history: "replay",
      });
      await waitForEvent(events, (event) => event.type === "session.ready");
      const openedB = events.find((event) => event.type === "session.opened");
      if (openedB?.type !== "session.opened") throw new Error("Missing B session");
      expect(openedB.persistence).toEqual({
        version: 2,
        data: { sessionId: "native-1", workspaceCwd: b },
      });
      expect(openedB.persistence).not.toEqual(persistenceA);
      expect(openedB.cwd).toBe(b);
      expect(events.find((event) => event.type === "timeline.item")).toMatchObject({
        item: { text: "History from A" },
      });
      await connection.send({
        type: "session.close",
        requestId: "close-b",
        sessionId: input.sessionId,
      });
      await waitForEvent(events, (event) => event.type === "session.closed");
      events.length = 0;
      await connection.send({
        ...input,
        requestId: "reopen-b",
        config: { ...input.config, cwd: b },
        persistence: openedB.persistence,
        history: "replay",
      });
      await waitForEvent(events, (event) => event.type === "session.ready");
      expect(events.find((event) => event.type === "session.opened")).toMatchObject({
        persistence: openedB.persistence,
        cwd: b,
      });
    } finally {
      await connection.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports native session list failures instead of returning an empty list", async () => {
    const registration = createTraeQueueStatusProvider(
      {
        command: process.execPath,
        args: ["-e", FAKE_TRAE_ACP],
        env: { ...process.env, SESSION_LIST_ERROR: "1" },
      },
      null,
    );
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["session.list"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({ type: "sessions", requestId: "failed-list" });
      expect(await waitForEvent(events, (event) => event.type === "request.failed")).toMatchObject({
        requestId: "failed-list",
        error: { message: "Session list unavailable" },
      });
    } finally {
      await connection.close();
    }
  });

  it("steers an imported session whose load response omits the native session ID", async () => {
    const registration = createTraeQueueStatusProvider(
      { command: process.execPath, args: ["-e", FAKE_TRAE_ACP] },
      null,
    );
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({
        ...openInput(),
        persistence: { version: 1, data: { sessionId: "native-1" } },
        history: "replay",
      });
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send(promptInput("first-imported", "Inspect", "auto"));
      await waitForEvent(
        events,
        (event) => event.type === "session.turn" && event.state === "started",
      );
      await connection.send(promptInput("steer-imported", "change course", "steer"));
      expect(
        await waitForEvent(
          events,
          (event) =>
            event.type === "session.prompt_result" && event.clientMessageId === "steer-imported",
        ),
      ).toMatchObject({ result: { type: "steer" } });
    } finally {
      await connection.close();
    }
  });

  it.each([
    { history: "skip" as const, reject: "", expected: { type: "session.ready" } },
    {
      history: "replay" as const,
      reject: "true",
      expected: {
        type: "request.failed",
        error: { message: expect.stringContaining("History unavailable") },
      },
    },
  ])(
    "does not publish discarded history for $history with rejected load=$reject",
    async ({ history, reject, expected }) => {
      const { connection, events } = await contextProvider({
        REJECT_LOAD: reject,
        HISTORY_UPDATES: JSON.stringify([
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Uncommitted history" },
          },
        ]),
      });
      try {
        await connection.send({
          ...openInput(),
          history,
          persistence: { version: 1, data: { sessionId: "native-1" } },
        });
        const outcome = await waitForEvent(
          events,
          (event) => event.type === "session.ready" || event.type === "request.failed",
        );
        expect(outcome).toMatchObject(expected);
        expect(events.filter((event) => event.type === "timeline.item")).toEqual([]);
      } finally {
        await connection.close();
      }
    },
  );

  it("keeps fallback message identities stable across reopens and merges failed tool updates", async () => {
    const { connection, events } = await contextProvider({
      HISTORY_UPDATES: JSON.stringify([
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Inspect" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Before " } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "tool" } },
        {
          sessionUpdate: "tool_call",
          toolCallId: "failed-tool",
          title: "Read",
          status: "pending",
          rawInput: { path: "missing" },
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "failed-tool",
          status: "failed",
          rawOutput: "File missing",
        },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "After tool" } },
      ]),
    });
    const input = {
      ...openInput(),
      history: "replay" as const,
      persistence: { version: 1 as const, data: { sessionId: "native-1" } },
    };
    try {
      await connection.send(input);
      await waitForEvent(events, (event) => event.type === "session.ready");
      const first = events.flatMap((event) => (event.type === "timeline.item" ? [event.item] : []));
      expect(first).toEqual([
        expect.objectContaining({ type: "user_message", text: "Inspect" }),
        expect.objectContaining({ type: "assistant_message", text: "Before tool" }),
        expect.objectContaining({
          type: "tool_call",
          status: "failed",
          error: "File missing",
          detail: { type: "unknown", input: { path: "missing" }, output: "File missing" },
        }),
        expect.objectContaining({ type: "assistant_message", text: "After tool" }),
      ]);
      expect(new Set(first.map((item) => item.id)).size).toBe(4);
      await connection.send({
        type: "session.close",
        requestId: "close-history",
        sessionId: "session-1",
      });
      await waitForEvent(events, (event) => event.type === "session.closed");
      events.length = 0;
      await connection.send({ ...input, requestId: "reopen-history" });
      await waitForEvent(events, (event) => event.type === "session.ready");
      expect(
        events.flatMap((event) => (event.type === "timeline.item" ? [event.item] : [])),
      ).toEqual(first);
    } finally {
      await connection.close();
    }
  });

  it("restores historical user, reasoning, assistant, tool and plan rows before session ready", async () => {
    const updates = [
      {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: { type: "text", text: "Check " },
      },
      {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: { type: "text", text: "the alarm" },
      },
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-1",
        content: { type: "text", text: "Inspect evidence" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "reply-1",
        content: { type: "text", text: "Checking " },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "reply-1",
        content: { type: "text", text: "logs" },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read logs",
        status: "in_progress",
        rawInput: { command: "cat alarm.log" },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: "All clear",
      },
      {
        sessionUpdate: "plan",
        entries: [{ content: "Check alarm", status: "completed", priority: "high" }],
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "reply-2",
        content: { type: "text", text: "Alarm resolved" },
      },
    ];
    const { connection, events } = await contextProvider({
      HISTORY_UPDATES: JSON.stringify(updates),
    });
    try {
      await connection.send({
        ...openInput(),
        history: "replay",
        persistence: { version: 1, data: { sessionId: "native-1" } },
      });
      await waitForEvent(events, (event) => event.type === "session.ready");
      const rows = events.flatMap((event) => (event.type === "timeline.item" ? [event.item] : []));
      expect(rows).toEqual([
        expect.objectContaining({
          type: "user_message",
          messageId: "user-1",
          text: "Check the alarm",
        }),
        expect.objectContaining({ type: "reasoning", text: "Inspect evidence" }),
        expect.objectContaining({
          type: "assistant_message",
          messageId: "reply-1",
          text: "Checking logs",
        }),
        expect.objectContaining({
          type: "tool_call",
          callId: "tool-1",
          name: "Read logs",
          status: "completed",
          error: null,
          detail: { type: "unknown", input: { command: "cat alarm.log" }, output: "All clear" },
        }),
        expect.objectContaining({
          type: "todo",
          id: "acp-plan",
          items: [{ id: "0", text: "Check alarm", completed: true, status: "completed" }],
        }),
        expect.objectContaining({
          type: "assistant_message",
          messageId: "reply-2",
          text: "Alarm resolved",
        }),
      ]);
      expect(events.findLastIndex((event) => event.type === "timeline.item")).toBeLessThan(
        events.findIndex((event) => event.type === "session.ready"),
      );
    } finally {
      await connection.close();
    }
  });

  it.each(["", "true"])(
    "exposes Plan and preserves permissions and Max with NO_MODES=%j",
    async (NO_MODES) => {
      const directory = await mkdtemp(join(tmpdir(), "trae-plan-test-"));
      const log = join(directory, "modes.txt");
      const { connection, events } = await contextProvider({
        WITH_PLAN: "true",
        MODE_LOG: log,
        NO_MODES,
      });
      const current = () => events.findLast((event) => event.type === "session.config");
      try {
        await connection.send({ type: "catalog", requestId: "plan-catalog" });
        expect(await waitForEvent(events, (event) => event.type === "catalog")).toMatchObject({
          catalog: {
            defaultMode: "bypass_permissions",
            modes: [{ id: "default" }, { id: "auto" }, { id: "bypass_permissions" }],
          },
        });
        await connection.send(openInput());
        await waitForEvent(events, (event) => event.type === "session.ready");
        expect(current()).toMatchObject({
          config: {
            mode: "bypass_permissions",
            modes: [{ id: "default" }, { id: "auto" }, { id: "bypass_permissions" }],
            settings: [
              { id: "trae_context_mode" },
              {
                id: "plan_mode",
                type: "toggle",
                label: "Plan",
                value: false,
                icon: "list-todo",
                tooltip: "Toggle plan mode",
              },
            ],
          },
        });
        expect(
          await configurePlan(connection, events, "plan-on", { settings: { plan_mode: true } }),
        ).toMatchObject({ type: "request.completed" });
        expect(
          await configurePlan(connection, events, "plan-permission", { mode: "auto" }),
        ).toMatchObject({ type: "request.completed" });
        expect(
          await configurePlan(connection, events, "plan-max", {
            settings: { trae_context_mode: "max" },
          }),
        ).toMatchObject({ type: "request.completed" });
        expect(current()).toMatchObject({
          config: {
            mode: "auto",
            settings: [
              { id: "trae_context_mode", value: "max" },
              { id: "plan_mode", value: true },
            ],
          },
        });
        expect(await readFile(log, "utf8")).toBe("plan\n");
        expect(
          await configurePlan(connection, events, "plan-off", { settings: { plan_mode: false } }),
        ).toMatchObject({ type: "request.completed" });
        expect(current()).toMatchObject({
          config: {
            mode: "auto",
            settings: [
              { id: "trae_context_mode", value: "max" },
              { id: "plan_mode", value: false },
            ],
          },
        });
        expect(await readFile(log, "utf8")).toBe("plan\nauto\n");
      } finally {
        await connection.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("opens a saved Plan session with a separate permission selection and restores it on exit", async () => {
    const { connection, events } = await contextProvider({
      WITH_PLAN: "true",
      INITIAL_PLAN: "true",
    });
    try {
      const input = openInput();
      await connection.send({
        ...input,
        config: { ...input.config, mode: "auto", settings: { plan_mode: true } },
      });
      await waitForEvent(events, (event) => event.type === "session.ready");
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: {
          mode: "auto",
          settings: [{ id: "trae_context_mode" }, { id: "plan_mode", value: true }],
        },
      });
      expect(
        await configurePlan(connection, events, "saved-plan-off", {
          settings: { plan_mode: false },
        }),
      ).toMatchObject({ type: "request.completed" });
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: {
          mode: "auto",
          settings: [{ id: "trae_context_mode" }, { id: "plan_mode", value: false }],
        },
      });
    } finally {
      await connection.close();
    }
  });

  it.each([
    { NO_MODES: "", WITH_PLAN: "true" },
    { NO_MODES: "true", WITH_PLAN: "true" },
    { NO_MODES: "", WITH_PLAN: "" },
  ])(
    "prefers native collaboration and changes permissions independently (NO_MODES=$NO_MODES, WITH_PLAN=$WITH_PLAN)",
    async ({ NO_MODES, WITH_PLAN }) => {
      const directory = await mkdtemp(join(tmpdir(), "trae-native-plan-"));
      const modeLog = join(directory, "modes.txt");
      const collaborationLog = join(directory, "collaboration.txt");
      const { connection, events } = await contextProvider({
        WITH_PLAN,
        NATIVE_COLLABORATION: "true",
        NO_MODES,
        PARTIAL_COLLABORATION: NO_MODES,
        MODE_LOG: modeLog,
        COLLABORATION_LOG: collaborationLog,
      });
      try {
        await connection.send({ type: "catalog", requestId: "native-plan-catalog" });
        const catalog = await waitForEvent(events, (event) => event.type === "catalog");
        if (catalog.type !== "catalog") throw new Error("Missing catalog");
        expect(catalog.catalog.modes.some((mode) => mode.id === "plan")).toBe(false);
        await connection.send(openInput());
        await waitForEvent(events, (event) => event.type === "session.ready");
        expectNativePlanning(events, "default", "bypass_permissions");
        expect(
          await configurePlan(connection, events, "native-plan-on", {
            settings: { collaboration_mode: "plan" },
          }),
        ).toMatchObject({ type: "request.completed" });
        expectNativePlanning(events, "plan", "bypass_permissions");
        expect(
          await configurePlan(connection, events, "native-permission", { mode: "auto" }),
        ).toMatchObject({ type: "request.completed" });
        expectNativePlanning(events, "plan", "auto");
        expect(
          await configurePlan(connection, events, "native-plan-off", {
            settings: { collaboration_mode: "default" },
          }),
        ).toMatchObject({ type: "request.completed" });
        expectNativePlanning(events, "default", "auto");
        expect(await readFile(modeLog, "utf8")).toBe("auto\n");
        expect(await readFile(collaborationLog, "utf8")).toBe("plan\ndefault\n");
      } finally {
        await connection.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])(
    "maps saved legacy Plan=%s to the native collaboration selector",
    async (savedPlan) => {
      const { connection, events } = await contextProvider({
        WITH_PLAN: "true",
        NATIVE_COLLABORATION: "true",
        INITIAL_COLLABORATION: savedPlan ? "default" : "plan",
      });
      try {
        const input = openInput();
        await connection.send({
          ...input,
          config: { ...input.config, mode: "auto", settings: { plan_mode: savedPlan } },
        });
        expect(
          await waitForEvent(
            events,
            (event) => event.type === "session.ready" || event.type === "request.failed",
          ),
        ).toMatchObject({ type: "session.ready" });
        expectNativePlanning(events, savedPlan ? "plan" : "default", "auto");
      } finally {
        await connection.close();
      }
    },
  );

  it("prefers explicit native settings and accepts legacy Plan aliases without a second control", async () => {
    const { connection, events } = await contextProvider({
      WITH_PLAN: "true",
      NATIVE_COLLABORATION: "true",
    });
    try {
      const input = openInput();
      await connection.send({
        ...input,
        config: { ...input.config, settings: { plan_mode: false, collaboration_mode: "plan" } },
      });
      await waitForEvent(events, (event) => event.type === "session.ready");
      expectNativePlanning(events, "plan", "bypass_permissions");
      expect(
        await configurePlan(connection, events, "legacy-plan-off", {
          settings: { plan_mode: false },
        }),
      ).toMatchObject({ type: "request.completed" });
      expectNativePlanning(events, "default", "bypass_permissions");
      expect(
        await configurePlan(connection, events, "legacy-mode-plan", { mode: "plan" }),
      ).toMatchObject({ type: "request.completed" });
      expectNativePlanning(events, "plan", "bypass_permissions");
    } finally {
      await connection.close();
    }
  });

  it("maps saved collaboration values back to the legacy toggle on older CLIs", async () => {
    const { connection, events } = await contextProvider({ WITH_PLAN: "true" });
    try {
      const input = openInput();
      await connection.send({
        ...input,
        config: { ...input.config, settings: { plan_mode: false, collaboration_mode: "plan" } },
      });
      await waitForEvent(events, (event) => event.type === "session.ready");
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: {
          settings: expect.arrayContaining([
            expect.objectContaining({ id: "plan_mode", value: true }),
          ]),
        },
      });
      expect(
        await configurePlan(connection, events, "downgraded-plan-off", {
          settings: { collaboration_mode: "default" },
        }),
      ).toMatchObject({ type: "request.completed" });
      const config = events.findLast((event) => event.type === "session.config");
      expect(config).toMatchObject({
        config: {
          settings: expect.arrayContaining([
            expect.objectContaining({ id: "plan_mode", value: false }),
          ]),
        },
      });
      expect(config?.config.settings.some((setting) => setting.id === "collaboration_mode")).toBe(
        false,
      );
    } finally {
      await connection.close();
    }
  });

  it.each(["", "true"])(
    "migrates a restored legacy read-only Plan session to native collaboration (NO_MODES=%s)",
    async (NO_MODES) => {
      const directory = await mkdtemp(join(tmpdir(), "trae-plan-migration-"));
      const modeLog = join(directory, "modes.txt");
      const collaborationLog = join(directory, "collaboration.txt");
      const { connection, events } = await contextProvider({
        WITH_PLAN: "true",
        INITIAL_PLAN: "true",
        NATIVE_COLLABORATION: "true",
        NO_MODES,
        MODE_LOG: modeLog,
        COLLABORATION_LOG: collaborationLog,
      });
      try {
        await connection.send({
          ...openInput(),
          persistence: { version: 1, data: { sessionId: "native-1" } },
        });
        expect(
          await waitForEvent(
            events,
            (event) => event.type === "session.ready" || event.type === "request.failed",
          ),
        ).toMatchObject({ type: "session.ready" });
        expectNativePlanning(events, "plan", "default");
        expect(await readFile(modeLog, "utf8")).toBe("default\n");
        expect(await readFile(collaborationLog, "utf8")).toBe("plan\n");
      } finally {
        await connection.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["", "true"])(
    "restores legacy read-only permissions when native Plan migration is refused (NO_MODES=%s)",
    async (NO_MODES) => {
      const directory = await mkdtemp(join(tmpdir(), "trae-plan-migration-failed-"));
      const modeLog = join(directory, "modes.txt");
      const { connection, events } = await contextProvider({
        WITH_PLAN: "true",
        INITIAL_PLAN: "true",
        NATIVE_COLLABORATION: "true",
        NO_MODES,
        REJECT_COLLABORATION: "plan",
        MODE_LOG: modeLog,
      });
      try {
        await connection.send(openInput());
        expect(
          await waitForEvent(
            events,
            (event) => event.type === "session.ready" || event.type === "request.failed",
          ),
        ).toMatchObject({
          type: "request.failed",
          error: { message: expect.stringContaining("Plan migration failed") },
        });
        expect(events.some((event) => event.type === "session.ready")).toBe(false);
        expect(await readFile(modeLog, "utf8")).toBe("default\nplan\n");
      } finally {
        await connection.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("keeps the native selector after refusal or an explicitly empty choices list", async () => {
    const { connection, events } = await contextProvider({
      WITH_PLAN: "true",
      NATIVE_COLLABORATION: "true",
      EMPTY_COLLABORATION: "true",
    });
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      expectNativePlanning(events, "default", "bypass_permissions");
      expect(
        await configurePlan(connection, events, "native-unavailable", {
          settings: { collaboration_mode: "plan" },
        }),
      ).toMatchObject({ type: "request.failed" });
      expectNativePlanning(events, "default", "bypass_permissions");
    } finally {
      await connection.close();
    }
  });

  it("keeps the previous controls when TRAE rejects Plan or a later setting needs rollback", async () => {
    const { connection, events } = await contextProvider({
      WITH_PLAN: "true",
      REJECT_MODE: "plan",
    });
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      expect(
        await configurePlan(connection, events, "rejected-plan", { settings: { plan_mode: true } }),
      ).toMatchObject({
        type: "request.failed",
        error: { message: expect.stringContaining("Plan temporarily unavailable") },
      });
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: {
          mode: "bypass_permissions",
          settings: [{ id: "trae_context_mode" }, { id: "plan_mode", value: false }],
        },
      });
      expect(
        await configurePlan(connection, events, "invalid-plan", { settings: { plan_mode: "yes" } }),
      ).toMatchObject({ type: "request.failed" });
      expect(events.filter((event) => event.type === "session.runtime_failed")).toEqual([]);
    } finally {
      await connection.close();
    }
  });

  it("rolls back Plan and permission changes together when a later context selection fails", async () => {
    const { connection, events } = await contextProvider({ WITH_PLAN: "true" });
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      expect(
        await configurePlan(connection, events, "plan-rollback", {
          mode: "auto",
          settings: { plan_mode: true, trae_context_mode: "unavailable" },
        }),
      ).toMatchObject({ type: "request.failed" });
      expect(events.filter((event) => event.type === "session.runtime_failed")).toEqual([]);
      expect(
        await configurePlan(connection, events, "plan-after-rollback", {
          settings: { plan_mode: true },
        }),
      ).toMatchObject({ type: "request.completed" });
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: {
          mode: "bypass_permissions",
          settings: [
            { id: "trae_context_mode", value: "standard" },
            { id: "plan_mode", value: true },
          ],
        },
      });
    } finally {
      await connection.close();
    }
  });

  it.each([
    { nativeMode: "default", permission: "default", plan: false },
    { nativeMode: "bypass_permissions", permission: "bypass_permissions", plan: false },
    { nativeMode: "plan", permission: "default", plan: true },
  ])(
    "returns MCP question answers without changing $nativeMode mode",
    async ({ nativeMode, permission, plan }) => {
      const { connection, events } = await questionProvider({
        MCP_QUESTION_MODE: "1",
        QUESTION_PERMISSION_MODE: nativeMode,
        WITH_PLAN: "true",
      });
      try {
        const questionEvent = await waitForEvent(
          events,
          (event) => event.type === "session.permission",
        );
        if (questionEvent.type !== "session.permission") throw new Error("Missing question");
        expect(questionEvent.request).toMatchObject({
          kind: "question",
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                header: "Season",
                options: [{ label: "春天", description: "Flowers" }, { label: "秋天" }],
                allowOther: false,
              },
              { header: "Activities", multiSelect: true, allowOther: true },
            ],
          },
        });
        expect(events.find((event) => event.type === "session.config")).toMatchObject({
          config: {
            mode: permission,
            settings: expect.arrayContaining([
              {
                id: "plan_mode",
                type: "toggle",
                label: "Plan",
                description: "Toggle plan mode",
                value: plan,
                icon: "list-todo",
                tooltip: "Toggle plan mode",
              },
            ]),
          },
        });
        const answer = {
          ...questionAnswer({ Season: "Winter", Activities: "Reading" }),
          permissionId: questionEvent.request.id,
        };
        await expect(connection.send(answer)).rejects.toThrow("Invalid choice");
        await connection.send({
          ...answer,
          response: {
            behavior: "allow",
            updatedInput: { answers: { Season: "秋天", Activities: "Hiking, Reading" } },
          },
        });
        const message = await waitForEvent(
          events,
          (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
        );
        expect(message).toMatchObject({
          item: {
            text: JSON.stringify({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    answers: { Season: "秋天", Activities: "Hiking, Reading" },
                  }),
                },
              ],
            }),
          },
        });
        await waitForEvent(
          events,
          (event) => event.type === "session.turn" && event.state === "completed",
        );
        expect(events.filter((event) => event.type === "session.permission_resolved")).toHaveLength(
          1,
        );
      } finally {
        await connection.close();
      }
    },
  );

  it.each(["dismiss", "interrupt"])("cancels a plugin MCP question on %s", async (action) => {
    const { connection, events } = await questionProvider({ MCP_QUESTION_MODE: "1" });
    try {
      const questionEvent = await waitForEvent(
        events,
        (event) => event.type === "session.permission",
      );
      if (questionEvent.type !== "session.permission") throw new Error("Missing question");
      await connection.send(
        action === "dismiss"
          ? {
              type: "session.permission",
              sessionId: "session-1",
              permissionId: questionEvent.request.id,
              response: { behavior: "deny" },
            }
          : { type: "session.interrupt", sessionId: "session-1", requestId: "stop" },
      );
      const message = await waitForEvent(
        events,
        (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
      );
      expect(message).toMatchObject({ item: { text: expect.stringContaining('"isError":true') } });
      expect(events.filter((event) => event.type === "session.permission_resolved")).toHaveLength(
        1,
      );
    } finally {
      await connection.close();
    }
  });

  it("isolates question URLs, rejects foreign origins, and revokes closed sessions", async () => {
    const events: ProviderEvent[] = [];
    const tool = new PaseoQuestionTool((event) => events.push(event));
    try {
      const first = await tool.open("first");
      const second = await tool.open("second");
      if (first.type !== "http" || second.type !== "http") throw new Error("Expected HTTP MCP");
      expect(first.url).not.toBe(second.url);
      expect(
        (await questionRpc(first.url, "initialize", {}, "https://foreign.example")).status,
      ).toBe(403);
      expect(await (await questionRpc(first.url, "tools/list")).json()).toMatchObject({
        result: { tools: [{ name: "AskUserQuestion", inputSchema: { type: "object" } }] },
      });
      const pending = questionRpc(first.url, "tools/call", {
        name: "AskUserQuestion",
        arguments: { questions: [{ header: "Season", question: "Which?" }] },
      });
      const questionEvent = await waitForEvent(
        events,
        (event) => event.type === "session.permission",
      );
      if (questionEvent.type !== "session.permission") throw new Error("Missing question");
      expect(() => tool.respond(questionEvent.request.id, "second", { behavior: "deny" })).toThrow(
        "Unknown Paseo question",
      );
      tool.release("first");
      expect(await (await pending).json()).toMatchObject({ result: { isError: true } });
      expect((await questionRpc(first.url, "ping")).status).toBe(404);
      expect((await questionRpc(second.url, "ping")).status).toBe(200);
    } finally {
      await tool.close();
    }
  });

  it.each([
    ["秋天", { question_0: "秋天" }],
    ["冬天，看雪", { question_0_custom: "冬天，看雪" }],
  ])("uses TRAE's native question with one Other input and returns %s", async (answer, content) => {
    const { connection, events } = await questionProvider({ NATIVE_QUESTION_MODE: "1" });
    try {
      expect(
        await waitForEvent(events, (event) => event.type === "session.permission"),
      ).toMatchObject({
        request: {
          input: {
            questions: [
              {
                header: "季节偏好",
                question: "你喜欢哪个季节？",
                options: [
                  { label: "春天", description: "万物复苏" },
                  { label: "秋天", description: "秋高气爽" },
                ],
                allowOther: true,
                allowEmpty: false,
              },
            ],
          },
        },
      });
      await connection.send(questionAnswer({ 季节偏好: answer }));
      expect(
        await waitForEvent(
          events,
          (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
        ),
      ).toMatchObject({ item: { text: JSON.stringify({ action: "accept", content }) } });
    } finally {
      await connection.close();
    }
  });

  it("renders native form questions and returns selected values and free text to TRAE", async () => {
    const { connection, events } = await questionProvider();
    try {
      const question = await waitForEvent(events, (event) => event.type === "session.permission");
      expect(question).toMatchObject({
        type: "session.permission",
        sessionId: "session-1",
        request: {
          id: "trae-question:string:question-1",
          kind: "question",
          name: "request_user_input",
          input: {
            questions: [
              {
                header: "Season",
                question: "Which season?",
                multiSelect: false,
                options: [{ label: "春天", description: "Flowers" }, { label: "秋天" }],
              },
              {
                header: "activities",
                multiSelect: true,
                options: [{ label: "Hiking" }, { label: "Reading" }],
              },
              { header: "notes", options: [], allowOther: true, allowEmpty: true },
            ],
          },
        },
      });
      await connection.send(
        questionAnswer({ Season: "秋天", activities: "Hiking, Reading", notes: "看日落" }),
      );
      expect(
        await waitForEvent(events, (event) => event.type === "session.permission_resolved"),
      ).toMatchObject({ permissionId: "trae-question:string:question-1" });
      const answer = await waitForEvent(
        events,
        (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
      );
      expect(answer).toMatchObject({
        item: {
          text: JSON.stringify({
            action: "accept",
            content: { season: "autumn", activities: ["Hiking", "Reading"], notes: "看日落" },
          }),
        },
      });
      await waitForEvent(
        events,
        (event) => event.type === "session.turn" && event.state === "completed",
      );
    } finally {
      await connection.close();
    }
  });

  it("keeps a question pending after an invalid answer and accepts a retry", async () => {
    const { connection, events } = await questionProvider();
    try {
      await waitForEvent(events, (event) => event.type === "session.permission");
      await expect(
        connection.send(questionAnswer({ Season: "Winter", activities: "Reading" })),
      ).rejects.toThrow("Invalid choice");
      expect(events.filter((event) => event.type === "session.permission_resolved")).toEqual([]);
      await connection.send(questionAnswer({ Season: "春天", activities: "Reading" }));
      await waitForEvent(events, (event) => event.type === "session.permission_resolved");
    } finally {
      await connection.close();
    }
  });

  it.each(["dismiss", "interrupt"])("cancels a native question on %s", async (action) => {
    const { connection, events } = await questionProvider();
    try {
      await waitForEvent(events, (event) => event.type === "session.permission");
      if (action === "dismiss")
        await connection.send({
          type: "session.permission",
          sessionId: "session-1",
          permissionId: "trae-question:string:question-1",
          response: { behavior: "deny" },
        });
      else
        await connection.send({
          type: "session.interrupt",
          sessionId: "session-1",
          requestId: "stop",
        });
      await waitForEvent(events, (event) => event.type === "session.permission_resolved");
      expect(
        await waitForEvent(
          events,
          (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
        ),
      ).toMatchObject({ item: { text: JSON.stringify({ action: "cancel" }) } });
    } finally {
      await connection.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "uses a scanned binary for ACP and model load discovery without PATH",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "trae scanned binary "));
      await mkdir(join(home, ".local/bin"), { recursive: true });
      const calls = join(home, "calls.jsonl");
      const binary = join(home, ".local/bin/traecli");
      await writeFile(
        binary,
        `#!${process.execPath}\nconst fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "models") {
  process.stdout.write(JSON.stringify([{ config_name: "alder", name: "Alder", _meta: { trae: { load: { percent: 88 } } } }]));
} else { ${FAKE_TRAE_ACP} }`,
        { mode: 0o755 },
      );
      const registration = createTraeQueueStatusProvider({
        env: { ...process.env, HOME: home, PATH: "", TRAECLI_BIN: "" },
      });
      const connection = await registration.connect({
        versions: [1],
        capabilities: ["prompt.message", "session.configure"],
      });
      const events: ProviderEvent[] = [];
      connection.onEvent((event) => events.push(event));
      try {
        await connection.send({ type: "catalog", requestId: "scanned-catalog" });
        const catalog = await waitForEvent(events, (event) => event.type === "catalog");
        expect(catalog).toMatchObject({
          catalog: {
            models: expect.arrayContaining([
              expect.objectContaining({ id: "alder", label: "Alder 🟢 88%" }),
            ]),
          },
        });
        await connection.send(openInput());
        await waitForEvent(events, (event) => event.type === "session.ready");
        expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
          config: {
            model: "alder",
            thinkingOption: "high",
            models: expect.arrayContaining([
              expect.objectContaining({ id: "alder", label: "Alder 🟢 88%" }),
            ]),
          },
        });
        const invocations = (await readFile(calls, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(invocations).toContainEqual(["acp", "serve", "--enable", "headless_queue_status"]);
        expect(invocations).toContainEqual(["models", "--json"]);
      } finally {
        await connection.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("shows ACP quota metadata in both the catalog and session without changing model routing", async () => {
    const { connection, events } = await contextProvider({ QUOTA_MODEL: "true" });
    const router = {
      id: "quota-model",
      label: "quota-model 🔴 257% · 周剩余 0%",
      description: "",
    };
    try {
      await connection.send({ type: "catalog", requestId: "quota-catalog" });
      const catalog = await waitForEvent(events, (event) => event.type === "catalog");
      expect(catalog).toMatchObject({
        catalog: { models: expect.arrayContaining([expect.objectContaining(router)]) },
      });
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.configure",
        requestId: "quota-max",
        sessionId: "session-1",
        changes: {
          model: "quota-model",
          thinkingOption: "high",
          settings: { trae_context_mode: "max" },
        },
      });
      const outcome = await waitForEvent(
        events,
        (event) =>
          (event.type === "request.completed" || event.type === "request.failed") &&
          event.requestId === "quota-max",
      );
      expect(outcome.type).toBe("request.completed");
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: {
          model: "quota-model",
          thinkingOption: "high",
          settings: [{ id: "trae_context_mode", value: "max" }],
          models: expect.arrayContaining([expect.objectContaining(router)]),
        },
      });
    } finally {
      await connection.close();
    }
  });

  it("refreshes client model menus every 30 seconds and cancels scheduling on unload", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => ({ acknowledged: true, requestId: "load-refresh" }));
    const stop = refreshModelLoads({ refresh });
    try {
      await vi.advanceTimersByTimeAsync(29_999);
      expect(refresh).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(refresh).toHaveBeenCalledExactlyOnceWith({ providers: ["traecli-queue"] });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(refresh).toHaveBeenCalledTimes(2);
      stop();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it("does not overlap client refreshes or reschedule a pending refresh after unload", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const refresh = vi.fn(async () => {
      await pending;
      return { acknowledged: true, requestId: "load-refresh" };
    });
    const stop = refreshModelLoads({ refresh });
    try {
      await vi.advanceTimersByTimeAsync(120_000);
      expect(refresh).toHaveBeenCalledTimes(1);
      stop();
      finish();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      finish();
      vi.useRealTimers();
    }
  });

  it("refreshes model loads during an active Max turn without changing session controls", async () => {
    const fixture = await modelLoadFixture();
    const registration = createTraeQueueStatusProvider(
      {
        command: process.execPath,
        args: ["-e", FAKE_TRAE_ACP],
      },
      fixture.refresh,
    );
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer", "session.configure"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({ type: "catalog", requestId: "catalog" });
      await waitForEvent(events, (event) => event.type === "catalog");
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.configure",
        requestId: "max",
        sessionId: "session-1",
        changes: { settings: { trae_context_mode: "max" } },
      });
      await waitForEvent(
        events,
        (event) => event.type === "request.completed" && event.requestId === "max",
      );
      await connection.send(promptInput("load-turn", "start and wait", "auto"));
      await waitForEvent(
        events,
        (event) => event.type === "session.turn" && event.state === "started",
      );
      await fixture.write(99);
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.config" &&
          event.config.models.some((model) => model.label === "Alder 🟢 99%"),
      );
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: {
          model: "alder",
          mode: "bypass_permissions",
          thinkingOption: "high",
          settings: [{ id: "trae_context_mode", value: "max" }],
        },
      });
      await fixture.write(150);
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.config" &&
          event.config.models.some((model) => model.label === "Alder 🟡 150%"),
      );
      await connection.send({ type: "catalog", requestId: "updated-catalog" });
      expect(
        await waitForEvent(
          events,
          (event) => event.type === "catalog" && event.requestId === "updated-catalog",
        ),
      ).toMatchObject({
        catalog: {
          models: [
            { id: "alder", label: "Alder 🟡 150%" },
            { id: "fixed-model", label: "Fixed Model 🟡 140%" },
          ],
        },
      });
      expect(events.filter((event) => event.type === "session.turn")).toHaveLength(1);
      await connection.send(promptInput("load-steer", "change course", "steer"));
      expect(
        await waitForEvent(
          events,
          (event) =>
            event.type === "session.prompt_result" && event.clientMessageId === "load-steer",
        ),
      ).toMatchObject({ result: { type: "steer", turnId: "acp:load-turn" } });
    } finally {
      await connection.close();
      await fixture.close();
    }
  });

  it("shares load reads, preserves previous values on failure, and stops polling after unsubscribe", async () => {
    const fixture = await modelLoadFixture(50);
    try {
      const first = fixture.refresh.refresh();
      const concurrent = fixture.refresh.refresh();
      expect(concurrent).toBe(first);
      await first;
      expect(await fixture.reads()).toHaveLength(1);
      await fixture.refresh.refresh();
      expect(await fixture.reads()).toHaveLength(1);
      await fixture.invalid();
      await expect
        .poll(
          async () => {
            try {
              await fixture.refresh.refresh();
              return false;
            } catch {
              return true;
            }
          },
          { timeout: 2_000 },
        )
        .toBe(true);
      expect(fixture.refresh.apply([{ id: "alder", label: "Alder" }])).toMatchObject([
        { label: "Alder 🔴 214%" },
      ]);
      await fixture.write(151);
      let updates = 0;
      const unsubscribe = fixture.refresh.subscribe(() => updates++);
      await expect.poll(() => updates, { timeout: 2_000 }).toBe(1);
      const count = (await fixture.reads()).length;
      unsubscribe();
      await fixture.write(20);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(await fixture.reads()).toHaveLength(count);
      expect(updates).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("aborts an in-flight model load subprocess when the last subscriber closes", async () => {
    const refresh = new TraeModelLoadRefresh({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      env: process.env,
    });
    const unsubscribe = refresh.subscribe(() => {});
    const pending = refresh.refresh();
    unsubscribe();
    await expect(pending).rejects.toThrow();
  });

  it("refreshes quota for depleted CLI rows without config_name and keeps model IDs intact", async () => {
    const fixture = await modelLoadFixture(50);
    try {
      await fixture.quota(0);
      await fixture.refresh.refresh();
      const models = [
        {
          id: "quota-model",
          label: "quota-model",
          thinkingOptions: [{ id: "high", label: "High" }],
        },
      ];
      expect(fixture.refresh.apply(models)).toEqual([
        { ...models[0], label: "quota-model 🔴 257% · 周剩余 0%" },
      ]);
      await fixture.quota(65);
      const unsubscribe = fixture.refresh.subscribe(() => {});
      try {
        await expect
          .poll(() => fixture.refresh.apply(models)[0].label, { timeout: 2_000 })
          .toBe("quota-model 🔴 257% · 周剩余 65%");
      } finally {
        unsubscribe();
      }
      expect(models[0].label).toBe("quota-model");
    } finally {
      await fixture.close();
    }
  });

  it("shows the same model load labels in the catalog and session after model/context changes", async () => {
    const { connection, events } = await contextProvider();
    const expectedModels = [
      { id: "alder", label: "Alder 🔴 214%", description: "" },
      { id: "fixed-model", label: "Fixed Model 🟡 140%", description: "" },
    ];
    try {
      await connection.send({ type: "catalog", requestId: "catalog" });
      expect(await waitForEvent(events, (event) => event.type === "catalog")).toMatchObject({
        catalog: { models: expectedModels },
      });
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: { model: "alder", models: expectedModels },
      });
      const configure = async (
        requestId: string,
        changes: Extract<ProviderInput, { type: "session.configure" }>["changes"],
      ) => {
        await connection.send({
          type: "session.configure",
          requestId,
          sessionId: "session-1",
          changes,
        });
        const outcome = await waitForEvent(
          events,
          (event) =>
            (event.type === "request.completed" || event.type === "request.failed") &&
            event.requestId === requestId,
        );
        expect(outcome.type).toBe("request.completed");
        expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
          config: { models: expectedModels },
        });
      };
      await configure("max-load", { settings: { trae_context_mode: "max" } });
      await configure("fixed-load", { model: "fixed-model" });
    } finally {
      await connection.close();
    }
  });

  it("renders one usage row per completed turn, including requests after steering", async () => {
    const home = await mkdtemp(join(tmpdir(), "trae-turn-provider-"));
    await mkdir(join(home, "sessions"));
    const registration = createTraeQueueStatusProvider(
      {
        command: process.execPath,
        args: ["-e", FAKE_TRAE_ACP],
        env: {
          ...process.env,
          TRAECLI_HOME: home,
          USAGE_FILE: join(home, "sessions", "native-1.jsonl"),
          ACTIVITY_COUNTS: "true",
        },
      },
      null,
    );
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      for (const id of ["first-usage", "second-usage"]) {
        // oxlint-disable-next-line no-await-in-loop
        await connection.send(promptInput(id, "start", "auto"));
        // oxlint-disable-next-line no-await-in-loop
        await waitForEvent(
          events,
          (event) =>
            event.type === "session.turn" &&
            event.turnId === `acp:${id}` &&
            event.state === "started",
        );
        // oxlint-disable-next-line no-await-in-loop
        await connection.send(promptInput(`steer-${id}`, "change course", "steer"));
        // oxlint-disable-next-line no-await-in-loop
        const summary = await waitForEvent(
          events,
          (event) =>
            isTurnUsageEvent(event, id) &&
            event.type === "timeline.item" &&
            event.item.type === "plugin" &&
            (event.item.data as { state: string }).state === "ready",
        );
        expect(summary).toMatchObject({
          item: {
            data: {
              inputTokens: 300,
              outputTokens: 30,
              cachedInputTokens: 150,
              modelCallCount: 2,
              toolCallCount: 4,
              outcome: "completed",
            },
          },
        });
      }
      expect(
        new Set(
          events
            .filter(
              (event) =>
                isTurnUsageEvent(event, "first-usage") || isTurnUsageEvent(event, "second-usage"),
            )
            .map((event) => (event.type === "timeline.item" ? event.item.id : "")),
        ),
      ).toHaveProperty("size", 2);
    } finally {
      await connection.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("steers a queued turn without canceling or starting a replacement turn", async () => {
    const registration = createTraeQueueStatusProvider(
      {
        command: process.execPath,
        args: ["-e", FAKE_TRAE_ACP],
      },
      null,
    );
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));

    try {
      expect(connection.capabilities).toContain("prompt.steer");
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      expect(events.find((event) => event.type === "session.opened")).toMatchObject({
        capabilities: expect.arrayContaining(["prompt.steer"]),
      });
      await connection.send(promptInput("first", "start and wait", "auto"));
      const started = await waitForEvent(
        events,
        (event) => event.type === "session.turn" && event.state === "started",
      );
      expect(started).toMatchObject({ turnId: "acp:first" });

      await connection.send(promptInput("steer-1", "change course", "steer"));
      const steered = await waitForEvent(
        events,
        (event) => event.type === "session.prompt_result" && event.clientMessageId === "steer-1",
      );
      expect(steered).toMatchObject({ result: { type: "steer", turnId: "acp:first" } });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "user_message" &&
          event.item.clientMessageId === "steer-1",
      );
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:first" &&
          event.state === "completed",
      );

      expect(
        events.filter((event) => event.type === "session.turn" && event.state === "started"),
      ).toHaveLength(1);
      expect(
        events.some((event) => event.type === "timeline.item" && event.item.type === "plugin"),
      ).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("does not advertise steering when TRAE omits the capability", async () => {
    const registration = createTraeQueueStatusProvider(
      {
        command: process.execPath,
        args: ["-e", FAKE_TRAE_ACP.replace("supported: true", "supported: false")],
      },
      null,
    );
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer"],
    });
    try {
      expect(connection.capabilities).not.toContain("prompt.steer");
    } finally {
      await connection.close();
    }
  });
  it("opens Fixed Model with a stale GPT thinking level and publishes no thinking selector", async () => {
    const { connection, events } = await contextProvider();
    try {
      const input = openInput();
      await connection.send({
        ...input,
        config: { ...input.config, model: "fixed-model", thinkingOption: "high" },
      });
      const outcome = await waitForEvent(
        events,
        (event) => event.type === "session.ready" || event.type === "request.failed",
      );
      expect(outcome).toMatchObject({ type: "session.ready" });
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: {
          model: "fixed-model",
          thinkingOption: undefined,
          thinkingOptions: [],
        },
      });
    } finally {
      await connection.close();
    }
  });

  it.each([false, true])(
    "starts fixed model immediately with inherited GPT Max and thinking settings (restore=%s)",
    async (restore) => {
      const { connection, events } = await contextProvider(
        restore ? { INITIAL_MODEL: "fixed-model" } : {},
      );
      try {
        const sessionId = restore ? "fixed-restored" : "fixed-new";
        const input = { ...openInput(), sessionId };
        // No catalog discovery or settings refresh before opening the session.
        await connection.send({
          ...input,
          ...(restore ? { persistence: { version: 1, data: { sessionId: "native-1" } } } : {}),
          config: {
            ...input.config,
            model: "fixed-model",
            thinkingOption: "high",
            settings: { trae_context_mode: "max" },
          },
        });
        const outcome = await waitForEvent(
          events,
          (event) => event.type === "session.ready" || event.type === "request.failed",
        );
        expect(outcome).toMatchObject({ type: "session.ready" });
        expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
          config: {
            model: "fixed-model",
            thinkingOption: undefined,
            thinkingOptions: [],
            settings: [{ id: "trae_context_mode", value: "standard" }],
          },
        });
        await connection.send({ ...promptInput("fixed-first", "hello", "auto"), sessionId });
        expect(
          await waitForEvent(
            events,
            (event) =>
              (event.type === "timeline.item" && event.item.type === "plugin") ||
              (event.type === "session.prompt_result" && event.result.type === "failed"),
          ),
        ).toMatchObject({ item: { data: { position: 5 } } });
      } finally {
        await connection.close();
      }
    },
  );

  it("still rejects unsupported Max selected explicitly after fixed model has opened", async () => {
    const { connection, events } = await contextProvider({ INITIAL_MODEL: "fixed-model" });
    try {
      const input = openInput();
      await connection.send({
        ...input,
        config: { ...input.config, model: "fixed-model" },
      });
      await waitForEvent(events, (event) => event.type === "session.ready");
      expect(
        await configurePlan(connection, events, "unsupported-fixed-max", {
          settings: { trae_context_mode: "max" },
        }),
      ).toMatchObject({
        type: "request.failed",
        error: {
          message: expect.stringContaining("context mode, or thinking level is unavailable"),
        },
      });
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: { model: "fixed-model", settings: [{ value: "standard" }] },
      });
    } finally {
      await connection.close();
    }
  });

  it("honors native Max support for fixed-reasoning models during startup", async () => {
    const model = {
      id: "fixed-model",
      name: "Fixed Model",
      nativeIds: ["fixed-model", "fixed-model/max"],
    };
    const { connection, events } = await contextProvider({
      MODEL_FIXTURE: JSON.stringify([model]),
    });
    try {
      const input = openInput();
      await connection.send({
        ...input,
        config: {
          ...input.config,
          model: model.id,
          thinkingOption: "high",
          settings: { trae_context_mode: "max" },
        },
      });
      expect(
        await waitForEvent(
          events,
          (event) => event.type === "session.ready" || event.type === "request.failed",
        ),
      ).toMatchObject({ type: "session.ready" });
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: { model: model.id, thinkingOptions: [], settings: [{ value: "max" }] },
      });
    } finally {
      await connection.close();
    }
  });

  it.each([{}, { NO_MAX: "true" }])(
    "publishes per-model thinking choices instead of inheriting GPT choices (%j)",
    async (env) => {
      const { connection, events } = await contextProvider(env);
      try {
        await connection.send({ type: "catalog", requestId: "catalog" });
        const catalog = await waitForEvent(events, (event) => event.type === "catalog");
        expect(catalog).toMatchObject({
          catalog: {
            thinkingOptions: [],
            defaultThinkingOption: undefined,
            models: [
              {
                id: "alder",
                thinkingOptions: [
                  { id: "low", label: "Low" },
                  { id: "high", label: "High" },
                ],
                defaultThinkingOptionId: "high",
              },
              {
                id: "fixed-model",
                thinkingOptions: [],
                defaultThinkingOptionId: undefined,
              },
            ],
          },
        });
      } finally {
        await connection.close();
      }
    },
  );

  it("clears a stale thinking level when switching to fixed model and restores GPT controls", async () => {
    const { connection, events } = await contextProvider();
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.configure",
        requestId: "fixed",
        sessionId: "session-1",
        changes: { model: "fixed-model", thinkingOption: "high" },
      });
      const fixeded = await waitForEvent(
        events,
        (event) =>
          (event.type === "request.completed" || event.type === "request.failed") &&
          event.requestId === "fixed",
      );
      expect(fixeded).toMatchObject({ type: "request.completed" });
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: { model: "fixed-model", thinkingOption: undefined, thinkingOptions: [] },
      });
      await connection.send({
        type: "session.configure",
        requestId: "gpt",
        sessionId: "session-1",
        changes: { model: "alder", thinkingOption: "high", settings: { trae_context_mode: "max" } },
      });
      const gpt = await waitForEvent(
        events,
        (event) =>
          (event.type === "request.completed" || event.type === "request.failed") &&
          event.requestId === "gpt",
      );
      expect(gpt).toMatchObject({ type: "request.completed" });
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: {
          model: "alder",
          thinkingOption: "high",
          thinkingOptions: [{ id: "low" }, { id: "high" }],
          settings: [{ value: "max" }],
        },
      });
    } finally {
      await connection.close();
    }
  });

  it("reopens a fixed-reasoning model with a persisted GPT thinking selection", async () => {
    const { connection, events } = await contextProvider({ INITIAL_MODEL: "fixed-model" });
    try {
      const input = openInput();
      await connection.send({
        ...input,
        config: { ...input.config, model: "fixed-model", thinkingOption: "high" },
      });
      const outcome = await waitForEvent(
        events,
        (event) => event.type === "session.ready" || event.type === "request.failed",
      );
      expect(outcome).toMatchObject({ type: "session.ready" });
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: { model: "fixed-model", thinkingOption: undefined, thinkingOptions: [] },
      });
    } finally {
      await connection.close();
    }
  });

  it("shows permission modes once while preserving Context and mode changes", async () => {
    const { connection, events } = await contextProvider();
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: {
          mode: "bypass_permissions",
          modes: [
            { id: "default", label: "Default" },
            { id: "auto", label: "Auto" },
            { id: "bypass_permissions", label: "Full Access" },
          ],
          settings: [{ id: "trae_context_mode", value: "standard" }],
        },
      });
      await connection.send({
        type: "session.configure",
        requestId: "permission",
        sessionId: "session-1",
        changes: { mode: "default", settings: { trae_context_mode: "max" } },
      });
      await waitForEvent(
        events,
        (event) => event.type === "request.completed" && event.requestId === "permission",
      );
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: {
          mode: "default",
          settings: [{ id: "trae_context_mode", value: "max" }],
        },
      });
    } finally {
      await connection.close();
    }
  });

  it("exposes config-only permissions through the standard permission control", async () => {
    const { connection, events } = await contextProvider({ NO_MODES: "true" });
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: {
          mode: "bypass_permissions",
          modes: [{ id: "default" }, { id: "auto" }, { id: "bypass_permissions" }],
          settings: [{ id: "trae_context_mode", value: "standard" }],
        },
      });
    } finally {
      await connection.close();
    }
  });

  it.each([false, true])(
    "opens with Auto and High using config-only permissions (resume=%s)",
    async (resume) => {
      const { connection, events } = await contextProvider({ NO_MODES: "true" });
      try {
        const input = openInput();
        await connection.send({
          ...input,
          ...(resume ? { persistence: { version: 1, data: { sessionId: "native-1" } } } : {}),
          config: { ...input.config, model: "alder", mode: "auto", thinkingOption: "high" },
        });
        const outcome = await waitForEvent(
          events,
          (event) => event.type === "session.ready" || event.type === "request.failed",
        );
        expect(outcome).toMatchObject({ type: "session.ready" });
        expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
          config: { model: "alder", mode: "auto", thinkingOption: "high" },
        });
        expect(
          await configurePlan(connection, events, "permission", { mode: "default" }),
        ).toMatchObject({ type: "request.completed" });
        expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
          config: { mode: "default" },
        });
      } finally {
        await connection.close();
      }
    },
  );

  it("rolls back config-only permissions when a later configuration change fails", async () => {
    const { connection, events } = await contextProvider({
      NO_MODES: "true",
      REJECT_MODEL: "alder/max/high",
    });
    try {
      const input = openInput();
      await connection.send({ ...input, config: { ...input.config, mode: "auto" } });
      await waitForEvent(events, (event) => event.type === "session.ready");
      expect(
        await configurePlan(connection, events, "rollback", {
          mode: "bypass_permissions",
          settings: { trae_context_mode: "max" },
        }),
      ).toMatchObject({
        type: "request.failed",
        error: { message: expect.stringContaining("Max temporarily unavailable") },
      });
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: { mode: "auto" },
      });
      expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);
      expect(await configurePlan(connection, events, "retry", { mode: "default" })).toMatchObject({
        type: "request.completed",
      });
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: { mode: "default" },
      });
    } finally {
      await connection.close();
    }
  });

  it("reports a rejected config-only permission without committing it", async () => {
    const { connection, events } = await contextProvider({ NO_MODES: "true", REJECT_MODE: "auto" });
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      expect(
        await configurePlan(connection, events, "rejected-permission", { mode: "auto" }),
      ).toMatchObject({
        type: "request.failed",
        error: { message: expect.stringContaining("Permission temporarily unavailable") },
      });
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: { mode: "bypass_permissions" },
      });
      expect(
        await configurePlan(connection, events, "retry-permission", { mode: "default" }),
      ).toMatchObject({ type: "request.completed" });
    } finally {
      await connection.close();
    }
  });

  it("publishes the Context selector and applies it before a prompt", async () => {
    const { connection, events } = await contextProvider();
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      const initial = events.find((event) => event.type === "session.config");
      expect(initial).toMatchObject({
        config: {
          settings: [
            {
              id: "trae_context_mode",
              label: "Context",
              value: "standard",
              options: [
                { label: "Standard", value: "standard" },
                { label: "Max", value: "max" },
              ],
            },
          ],
        },
      });
      await connection.send({
        type: "session.configure",
        requestId: "max",
        sessionId: "session-1",
        changes: { settings: { trae_context_mode: "max" }, thinkingOption: "low" },
      });
      await waitForEvent(
        events,
        (event) => event.type === "request.completed" && event.requestId === "max",
      );
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: {
          model: "alder",
          thinkingOption: "low",
          settings: [{ id: "trae_context_mode", value: "max" }],
        },
      });
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "message-1",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "hello" }] },
        },
      });
      const queue = await waitForEvent(
        events,
        (event) => event.type === "timeline.item" && event.item.type === "plugin",
      );
      expect(queue).toMatchObject({ item: { data: { position: 7 } } });
    } finally {
      await connection.close();
    }
  });

  it("keeps Standard committed and the session usable when Max is refused", async () => {
    const { connection, events } = await contextProvider({ REJECT_MODEL: "alder/max/high" });
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.configure",
        requestId: "denied",
        sessionId: "session-1",
        changes: { settings: { trae_context_mode: "max" } },
      });
      const denied = await waitForEvent(
        events,
        (event) => event.type === "request.failed" && event.requestId === "denied",
      );
      expect(denied).toMatchObject({
        error: { message: expect.stringContaining("Max temporarily unavailable") },
      });
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: { settings: [{ value: "standard" }] },
      });
      expect(events.filter((event) => event.type === "session.runtime_failed")).toEqual([]);
      await connection.send({
        type: "session.configure",
        requestId: "retry",
        sessionId: "session-1",
        changes: { thinkingOption: "low", settings: { trae_context_mode: "max" } },
      });
      await waitForEvent(
        events,
        (event) => event.type === "request.completed" && event.requestId === "retry",
      );
      expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
        config: { thinkingOption: "low", settings: [{ value: "max" }] },
      });
    } finally {
      await connection.close();
    }
  });
});

describe.skipIf(process.platform === "win32")("TRAE startup model recovery", () => {
  const unavailable = {
    code: -32603,
    message: "Internal error",
    data: "model `retired` is unavailable because its metadata could not be resolved",
  };
  async function fixture(env: NodeJS.ProcessEnv = {}, models?: unknown[]) {
    const directory = await mkdtemp(join(tmpdir(), "trae-startup-"));
    const command = join(directory, "traecli.cjs");
    const log = join(directory, "requests.jsonl");
    await writeFile(
      command,
      `#!${process.execPath}\n
if (process.argv[2] === "models") {
  if (process.env.MODELS_ERROR) { process.stderr.write("model list offline"); process.exit(1); }
  process.stdout.write(process.env.STARTUP_MODELS);
} else {
  if (process.argv.includes('model="alder"') && !process.env.RETRY_FAILS) delete process.env.STARTUP_ERROR;
  ${FAKE_TRAE_ACP}
}`,
      { mode: 0o755 },
    );
    const loads = new TraeModelLoadRefresh({
      command,
      env: {
        ...process.env,
        ...env,
        STARTUP_MODELS: JSON.stringify(
          models ?? [
            { name: "no config ID" },
            {
              config_name: "depleted",
              name: "Depleted",
              _meta: { trae: { weeklyQuota: { applies: true, isDepleted: true } } },
            },
            { config_name: "retired", name: "Retired" },
            { config_name: "alder", name: "Alder" },
          ],
        ),
      },
    });
    const registration = createTraeQueueStatusProvider(
      {
        command,
        env: {
          ...process.env,
          STARTUP_LOG: log,
          STARTUP_ERROR: JSON.stringify(unavailable),
          ...env,
        },
      },
      loads,
    );
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "session.configure", "session.persistence", "prompt.steer"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    return {
      connection,
      events,
      async requests() {
        return (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                args: string[];
                request: { method: string; params: Record<string, unknown> };
              },
          );
      },
      async close() {
        await connection.close();
        loads.dispose();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }

  it.each(["catalog", "new", "load"])(
    "recovers %s and preserves request parameters and selected model",
    async (operation) => {
      const f = await fixture({
        HISTORY_UPDATES: JSON.stringify([
          {
            sessionUpdate: "agent_message_chunk",
            messageId: "old-reply",
            content: { type: "text", text: "History" },
          },
        ]),
      });
      try {
        const input = openInput();
        input.config.model = "fixed-model";
        if (operation === "load") {
          input.persistence = { version: 1, data: { sessionId: "native-1" } };
          input.history = "replay";
        }
        await f.connection.send(
          operation === "catalog" ? { type: "catalog", requestId: "catalog" } : input,
        );
        const outcome = await waitForEvent(
          f.events,
          (event) =>
            event.type === "catalog" ||
            event.type === "session.ready" ||
            event.type === "request.failed",
        );
        expect(outcome.type).toBe(operation === "catalog" ? "catalog" : "session.ready");
        const requests = await f.requests();
        const startups = requests.filter(({ request }) =>
          ["session/new", "session/load"].includes(request.method),
        );
        expect(startups).toHaveLength(2);
        expect(startups[0].args).not.toContain('model="alder"');
        expect(startups[1].args).toContain('model="alder"');
        expect(startups[1].request).toEqual(startups[0].request);
        expect(requests.filter(({ request }) => request.method === "initialize")).toHaveLength(3);
        expect(f.events.some((event) => event.type === "session.runtime_failed")).toBe(false);
        if (operation !== "catalog")
          expect(f.events).toContainEqual(
            expect.objectContaining({
              type: "session.config",
              config: expect.objectContaining({ model: "fixed-model" }),
            }),
          );
        if (operation === "load")
          expect(f.events.filter((event) => event.type === "timeline.item")).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
  );

  it.each([
    {
      name: "unrelated internal error",
      env: { STARTUP_ERROR: JSON.stringify({ ...unavailable, data: "Authentication failed" }) },
      attempts: 1,
      detail: "Authentication failed",
    },
    {
      name: "second startup failure",
      env: { RETRY_FAILS: "1" },
      attempts: 2,
      detail: "metadata could not be resolved",
    },
    {
      name: "model list failure",
      env: { MODELS_ERROR: "1" },
      attempts: 1,
      detail: "model recovery failed",
    },
    {
      name: "empty model list",
      env: {},
      models: [],
      attempts: 1,
      detail: "no available fallback model",
    },
    { name: "healthy default", env: { STARTUP_ERROR: "" }, attempts: 1, detail: null },
  ])("bounds recovery for $name", async ({ env, models, attempts, detail }) => {
    const f = await fixture(env, models);
    try {
      await f.connection.send({ type: "catalog", requestId: "catalog" });
      const outcome = await waitForEvent(
        f.events,
        (event) => event.type === "catalog" || event.type === "request.failed",
      );
      if (detail)
        expect(outcome).toMatchObject({
          type: "request.failed",
          error: { message: expect.stringContaining(detail) },
        });
      else expect(outcome.type).toBe("catalog");
      expect(
        (await f.requests()).filter(({ request }) => request.method === "session/new"),
      ).toHaveLength(attempts);
    } finally {
      await f.close();
    }
  });
});

function isTurnUsageEvent(event: ProviderEvent, id: string): boolean {
  return (
    event.type === "timeline.item" &&
    event.item.type === "plugin" &&
    event.item.kind === "trae-turn-usage" &&
    event.item.id === `trae-turn-usage:acp:${id}`
  );
}

function expectNativePlanning(events: ProviderEvent[], value: string, mode: string) {
  const latest = events.findLast((event) => event.type === "session.config");
  expect(latest).toMatchObject({
    config: {
      mode,
      settings: expect.arrayContaining([
        expect.objectContaining({ id: "collaboration_mode", value }),
      ]),
    },
  });
  expect(
    latest?.config.settings.filter((setting) => setting.id === "collaboration_mode"),
  ).toHaveLength(1);
  expect(latest?.config.settings.some((setting) => setting.id === "plan_mode")).toBe(false);
  expect(latest?.config.modes.some((choice) => choice.id === "plan")).toBe(false);
}

function openInput(): Extract<ProviderInput, { type: "session.open" }> {
  return {
    type: "session.open",
    requestId: "open-1",
    sessionId: "session-1",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
    history: "skip",
  };
}

function promptInput(
  clientMessageId: string,
  text: string,
  delivery: "auto" | "steer",
): Extract<ProviderInput, { type: "session.prompt" }> {
  return {
    type: "session.prompt",
    sessionId: "session-1",
    prompt: {
      clientMessageId,
      delivery,
      input: { type: "message", content: [{ type: "text", text }] },
    },
  };
}

async function waitForEvent(
  events: ProviderEvent[],
  predicate: (event: ProviderEvent) => boolean,
): Promise<ProviderEvent> {
  await expect.poll(() => events.find(predicate), { timeout: 3_000 }).toBeTruthy();
  return events.find(predicate)!;
}

describe("provider subagent integration", () => {
  it.each(["live", "replay", "skip"])(
    "exposes native children through the full ACP provider (%s)",
    async (mode) => {
      const registration = createTraeQueueStatusProvider(
        {
          command: process.execPath,
          args: ["-e", FAKE_TRAE_ACP],
          env: {
            ...process.env,
            [mode === "live" ? "SUBAGENT_LIVE" : "SUBAGENT_HISTORY"]:
              JSON.stringify(subagentFrames),
          },
        },
        null,
      );
      const connection = await registration.connect({
        versions: [1],
        capabilities: ["prompt.message", "session.persistence", "session.subsession"],
      });
      const events: ProviderEvent[] = [];
      connection.onEvent((event) => events.push(event));
      const input = openInput();
      try {
        expect(connection.capabilities).toContain("session.subsession");
        await connection.send({
          ...input,
          ...(mode !== "live"
            ? {
                persistence: { version: 1, data: { sessionId: "native-1" } },
                history: mode === "skip" ? "skip" : "replay",
              }
            : {}),
        });
        await waitForEvent(
          events,
          (event) => event.type === "session.ready" && event.sessionId === input.sessionId,
        );
        if (mode === "live") {
          await connection.send({
            type: "session.prompt",
            sessionId: input.sessionId,
            prompt: {
              clientMessageId: "fixture",
              delivery: "auto",
              input: { type: "message", content: [{ type: "text", text: "Run fixture" }] },
            },
          });
          await waitForEvent(
            events,
            (event) =>
              event.type === "session.turn" &&
              event.sessionId === input.sessionId &&
              event.state === "completed",
          );
        }
        const children = events
          .filter((event) => event.type === "session.opened")
          .filter((event) => event.parentSessionId);
        expect(children).toHaveLength(1);
        const child = children[0];
        expect(child.parentSessionId).toBe(input.sessionId);
        expect(
          events.findIndex(
            (event) => event.type === "session.opened" && event.sessionId === input.sessionId,
          ),
        ).toBeLessThan(events.indexOf(child));
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "timeline.item",
            sessionId: child.sessionId,
            item: expect.objectContaining({ text: "fixture done" }),
          }),
        );
        expect(
          events.some(
            (event) =>
              event.type === "timeline.item" &&
              event.sessionId === input.sessionId &&
              event.item.type === "assistant_message" &&
              event.item.text === "fixture done",
          ),
        ).toBe(false);
        if (mode === "skip")
          expect(
            events.some(
              (event) => event.type === "timeline.item" && event.sessionId === input.sessionId,
            ),
          ).toBe(false);
        await connection.send({
          type: "session.close",
          sessionId: child.sessionId,
          requestId: "close-child",
        });
        expect(events.at(-1)).toMatchObject({
          type: "request.completed",
          requestId: "close-child",
        });
      } finally {
        await connection.close();
      }
    },
  );
});

async function contextProvider(env: NodeJS.ProcessEnv = {}) {
  const registration = createTraeQueueStatusProvider(
    {
      command: process.execPath,
      args: ["-e", FAKE_TRAE_ACP],
      env: { ...process.env, ...env },
    },
    null,
  );
  const connection = await registration.connect({
    versions: [1],
    capabilities: ["prompt.message", "session.configure", "session.persistence"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  return { connection, events };
}

async function modelLoadFixture(intervalMs = 80) {
  const directory = await mkdtemp(join(tmpdir(), "trae-model-load-test-"));
  const path = join(directory, "models.json");
  const requests = join(directory, "reads.txt");
  const write = async (percent: number) =>
    writeFile(
      path,
      JSON.stringify([
        { config_name: "alder", name: "Alder", _meta: { trae: { load: { percent } } } },
        {
          config_name: "fixed-model",
          name: "Fixed Model",
          _meta: { trae: { load: { percent: 140 } } },
        },
        { name: "Disabled model", _meta: { trae: { load: { percent: 99 } } } },
      ]),
    );
  await write(214);
  const refresh = new TraeModelLoadRefresh({
    command: process.execPath,
    args: [
      "-e",
      "const fs = require('node:fs'); fs.appendFileSync(process.argv[2], 'read\\n'); process.stdout.write(fs.readFileSync(process.argv[1]));",
      path,
      requests,
    ],
    env: process.env,
    intervalMs,
  });
  return {
    refresh,
    write,
    invalid: () => writeFile(path, "invalid json"),
    quota: (remainingPercent: number) =>
      writeFile(
        path,
        JSON.stringify([
          {
            name: "quota-model",
            _meta: {
              trae: {
                load: { percent: 257 },
                weeklyQuota: {
                  applies: true,
                  isDepleted: remainingPercent === 0,
                  remainingPercent,
                },
              },
            },
          },
        ]),
      ),
    reads: async () => (await readFile(requests, "utf8")).trim().split("\n"),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

async function questionProvider(env: NodeJS.ProcessEnv = {}) {
  const registration = createTraeQueueStatusProvider(
    {
      command: process.execPath,
      args: ["-e", FAKE_TRAE_ACP],
      env: { ...process.env, QUESTION_MODE: "1", ...env },
    },
    null,
  );
  const connection = await registration.connect({
    versions: [1],
    capabilities: ["prompt.message", "permission"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  await connection.send(openInput());
  await waitForEvent(events, (event) => event.type === "session.ready");
  await connection.send(promptInput("ask", "ask a question", "auto"));
  return { connection, events };
}
function questionAnswer(
  answers: Record<string, string>,
): Extract<ProviderInput, { type: "session.permission" }> {
  return {
    type: "session.permission",
    sessionId: "session-1",
    permissionId: "trae-question:string:question-1",
    response: { behavior: "allow", updatedInput: { answers } },
  };
}

function questionRpc(url: string, method: string, params?: unknown, origin?: string) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function configurePlan(
  connection: ProviderConnection,
  events: ProviderEvent[],
  requestId: string,
  changes: ProviderConfigChanges,
) {
  await connection.send({ type: "session.configure", requestId, sessionId: "session-1", changes });
  return waitForEvent(
    events,
    (event) =>
      (event.type === "request.completed" || event.type === "request.failed") &&
      event.requestId === requestId,
  );
}
