import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessAcpConnector, createTraeAcpSteeringRegistry } from "./acp-connector.js";
import { modelStatusLabel } from "./model-status.js";
import { QUEUE_STATUS_VENDOR_METHOD } from "./queue-status.js";
import { createTraeCliCommand } from "./traecli-command.js";

describe.skipIf(process.platform === "win32")("TRAE CLI executable discovery", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });
  const fixture = () => {
    const home = mkdtempSync(join(tmpdir(), "trae cli discovery "));
    directories.push(home);
    const executable = (relative: string, mode = 0o755) => {
      const file = join(home, relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode });
      return file;
    };
    return { home, executable, env: { HOME: home, PATH: "", TRAECLI_BIN: "" } };
  };

  it("honors explicit launch commands and daemon TRAECLI_BIN before scanning", () => {
    const { env, executable } = fixture();
    executable(".local/bin/traecli");
    env.TRAECLI_BIN = "  /custom/missing/traecli  ";
    expect(createTraeCliCommand({ env })()).toBe("/custom/missing/traecli");
    expect(createTraeCliCommand({ command: process.execPath, env })()).toBe(process.execPath);
    env.TRAECLI_BIN = "~/custom/traecli";
    expect(createTraeCliCommand({ env })()).toBe(join(env.HOME, "custom/traecli"));
  });

  it("preserves PATH order before scanning installation directories", () => {
    const { env, executable, home } = fixture();
    executable("second/traecli");
    const first = executable("first/traecli");
    executable(".local/bin/traecli");
    env.PATH = `${join(home, "first")}:${join(home, "second")}`;
    expect(createTraeCliCommand({ env })()).toBe(first);
  });

  it.each(["", "/missing/daemon/path"])("finds a local installation with PATH=%j", (PATH) => {
    const { env, executable } = fixture();
    const binary = executable(".local/bin/traecli");
    expect(createTraeCliCommand({ env: { ...env, PATH } })()).toBe(binary);
    expect(createTraeCliCommand({ env: { HOME: env.HOME } })()).toBe(binary);
  });

  it("skips non-executable files, directories and broken symlinks", () => {
    const { env, executable, home } = fixture();
    executable("not executable/traecli", 0o644);
    mkdirSync(join(home, "directory/traecli"), { recursive: true });
    mkdirSync(join(home, "broken"));
    symlinkSync(join(home, "missing"), join(home, "broken/traecli"));
    const binary = executable(".local/bin/traecli");
    env.PATH = ["not executable", "directory", "broken"].map((name) => join(home, name)).join(":");
    expect(createTraeCliCommand({ env })()).toBe(binary);
  });

  it("retains an executable symlink path so installer updates keep working", () => {
    const { env, executable, home } = fixture();
    const target = executable("releases/current/traex");
    const binary = join(home, ".local/bin/traecli");
    mkdirSync(dirname(binary), { recursive: true });
    symlinkSync(target, binary);
    const command = createTraeCliCommand({ env });
    expect(command()).toBe(binary);
    chmodSync(target, 0o644);
    expect(command()).toBe(binary);
  });

  it("scans installed nvm versions in numeric descending order", () => {
    const { env, executable } = fixture();
    executable(".nvm/versions/node/v9.0.0/bin/traecli");
    const latest = executable(".nvm/versions/node/v22.0.0/bin/traecli");
    expect(createTraeCliCommand({ env })()).toBe(latest);
  });

  it("reports searched directories and allows retry after a failed lookup", () => {
    const { env, executable } = fixture();
    const command = createTraeCliCommand({ env, platform: "win32" });
    expect(() => command()).toThrow(/Searched daemon PATH.*TRAECLI_BIN/);
    env.TRAECLI_BIN = executable(".local/bin/traecli");
    expect(command()).toBe(env.TRAECLI_BIN);
  });
});

describe("TRAE model status labels", () => {
  it.each([
    [0, "🟢 0%"],
    [99.9, "🟢 99.9%"],
    [100, "🟡 100%"],
    [140, "🟡 140%"],
    [150, "🟡 150%"],
    [150.1, "🔴 150.1%"],
    [214, "🔴 214%"],
  ])("shows the load color for %s percent without capping the value", (percent, suffix) => {
    expect(modelStatusLabel("Alder", { trae: { load: { percent } } })).toBe(`Alder ${suffix}`);
  });

  it.each([
    undefined,
    {},
    { trae: { load: null } },
    { trae: { load: { percent: -1 } } },
    { trae: { load: { percent: "140" } } },
  ])("leaves model names unchanged when load metadata is missing or invalid (%j)", (metadata) => {
    expect(modelStatusLabel("Alder", metadata)).toBe("Alder");
  });

  it.each([
    [{ applies: true, remainingPercent: 0, isDepleted: true }, " · 周剩余 0%"],
    [{ applies: true, remainingPercent: 35.5 }, " · 周剩余 35.5%"],
    [{ applies: true, remainingPercent: 100 }, " · 周剩余 100%"],
    [{ applies: true, usedPercent: 63.25 }, " · 周剩余 36.75%"],
    [{ applies: true, isDepleted: true }, " · 周剩余 0%"],
    [{ applies: true, isDepleted: true, remainingPercent: 25 }, " · 周剩余 0%"],
    [{ applies: false, remainingPercent: 0 }, ""],
    [{ applies: true }, ""],
    [{ applies: true, remainingPercent: -1 }, ""],
    [{ applies: true, remainingPercent: 101 }, ""],
    [{ applies: true, remainingPercent: "50" }, ""],
  ])("shows remaining quota only when applicable and known (%j)", (weeklyQuota, suffix) => {
    expect(
      modelStatusLabel("quota-model", { trae: { load: { percent: 257 }, weeklyQuota } }),
    ).toBe(`quota-model 🔴 257%${suffix}`);
  });

  it("shows quota independently of absent or invalid load data", () => {
    expect(
      modelStatusLabel("quota-model", {
        trae: { weeklyQuota: { applies: true, remainingPercent: 0 } },
      }),
    ).toBe("quota-model · 周剩余 0%");
    expect(
      modelStatusLabel("quota-model", {
        trae: { load: { percent: -1 }, weeklyQuota: { applies: true, remainingPercent: 40 } },
      }),
    ).toBe("quota-model · 周剩余 40%");
  });
});

describe("ACP process connector", () => {
  it("retains error data on internal session listing requests", async () => {
    const registry = createTraeAcpSteeringRegistry({
      command: process.execPath,
      args: [
        "-e",
        `
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,...(request.method === 'initialize'
          ? { result: {} } : { error: {code:-32603,message:'Internal error',data:'History database unavailable'} })})+'\\n');
      });`,
      ],
    });
    try {
      await expect(registry.listSessions({ type: "sessions", requestId: "list" })).rejects.toThrow(
        "Internal error: History database unavailable",
      );
    } finally {
      await registry.dispose();
    }
  });

  it("does not replace a model explicitly supplied in launch arguments", async () => {
    const fallbackModel = vi.fn(async () => "replacement");
    const error = {
      code: -32603,
      message: "Internal error",
      data: "model `retired` is unavailable because its metadata could not be resolved",
    };
    const connector = createProcessAcpConnector({
      command: process.execPath,
      fallbackModel,
      args: [
        "-e",
        `require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,...(request.method === 'initialize'
          ? { result: {} } : { error: ${JSON.stringify(error)} })})+'\\n');
      });`,
        "--",
        'model="retired"',
      ],
    });
    const reader = connector.readable.getReader();
    const writer = connector.writable.getWriter();
    try {
      await writer.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      await reader.read();
      await writer.write({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
      expect((await reader.read()).value).toMatchObject({ id: 2, error: { data: error.data } });
      expect(fallbackModel).not.toHaveBeenCalled();
    } finally {
      await reader.cancel();
      writer.releaseLock();
    }
  });

  it.each([
    ["model missing", "Internal error: model missing"],
    [{ message: "model missing" }, "Internal error: model missing"],
    [{ other: "detail" }, "Internal error"],
    ["  ", "Internal error"],
    ["Internal error", "Internal error"],
  ])("preserves useful RPC error details (%j)", async (data, message) => {
    const error = { code: -32603, message: "Internal error", data };
    const connector = createProcessAcpConnector({
      command: process.execPath,
      args: [
        "-e",
        `require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:${JSON.stringify(error)}})+'\\n');
      });`,
      ],
    });
    const reader = connector.readable.getReader();
    const writer = connector.writable.getWriter();
    try {
      await writer.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      expect((await reader.read()).value).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { ...error, message },
      });
    } finally {
      await reader.cancel();
      writer.releaseLock();
    }
  });

  it("forwards ACP messages and injects a queue-status vendor notification", async () => {
    const queueUpdate = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "native-1",
        update: {
          sessionUpdate: "session_info_update",
          _meta: { trae: { queueStatus: { state: "queued", position: 4 } } },
        },
      },
    });
    const connector = createProcessAcpConnector({
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(`${queueUpdate}\n`)});`],
    });
    const reader = connector.readable.getReader();

    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: JSON.parse(queueUpdate),
    });
    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: { method: QUEUE_STATUS_VENDOR_METHOD },
    });
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it("exposes context choices and sends Max through TRAE's advertised model ID", async () => {
    const connector = createProcessAcpConnector({
      command: process.execPath,
      args: ["-e", CONTEXT_ACP],
    });
    const reader = connector.readable.getReader();
    const writer = connector.writable.getWriter();
    try {
      await writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: { cwd: "/tmp", mcpServers: [] },
      });
      const opened = await reader.read();
      expect(opened.value).toMatchObject({
        result: {
          configOptions: [
            { id: "model", currentValue: "alder" },
            {
              id: "trae_context_mode",
              currentValue: "standard",
              options: [
                { value: "standard", name: "Standard" },
                { value: "max", name: "Max" },
              ],
            },
            { id: "effort", currentValue: "high" },
          ],
        },
      });
      await writer.write({
        jsonrpc: "2.0",
        id: 2,
        method: "session/set_config_option",
        params: { sessionId: "native-1", configId: "trae_context_mode", value: "max" },
      });
      expect((await reader.read()).value).toMatchObject({
        id: 2,
        result: {
          nativeModelId: "alder/max/high",
          configOptions: [
            { id: "model", currentValue: "alder" },
            { id: "trae_context_mode", currentValue: "max" },
            { id: "effort", currentValue: "high" },
          ],
        },
      });
    } finally {
      await reader.cancel();
      writer.releaseLock();
    }
  });

  it("terminates a running child when Paseo cancels the connector", async () => {
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const connector = createProcessAcpConnector({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      onExit: () => resolveExit(),
    });
    const reader = connector.readable.getReader();

    await reader.cancel("test complete");
    await expect(Promise.race([exited.then(() => true), timeout(false, 2_000)])).resolves.toBe(
      true,
    );
  });

  it("surfaces an unexpected child exit", async () => {
    const connector = createProcessAcpConnector({
      command: process.execPath,
      args: ["-e", "process.exit(7)"],
    });
    const reader = connector.readable.getReader();

    await expect(reader.read()).rejects.toThrow("TRAE ACP process exited (7)");
  });

  it.each([
    "Fatal error: Failed to initialize session: thread-store conflict: thread native-1 already has an active writer (owner PID 123)",
    { message: "thread-store conflict: thread native-1 already has an active writer" },
  ])("translates native writer conflicts into an actionable import error", async (data) => {
    const error = { code: -32603, message: "Internal error", data };
    const connector = createProcessAcpConnector({
      command: process.execPath,
      args: [
        "-e",
        `require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:${JSON.stringify(error)}})+'\\n');
      });`,
      ],
    });
    const reader = connector.readable.getReader();
    const writer = connector.writable.getWriter();
    try {
      await writer.write({
        jsonrpc: "2.0",
        id: "restore",
        method: "session/load",
        params: { sessionId: "native-1", cwd: "/tmp", mcpServers: [] },
      });
      expect((await reader.read()).value).toMatchObject({
        id: "restore",
        error: {
          code: -32603,
          message: "该会话仍被 TRAE CLI 或其他客户端占用，请先关闭原会话后重试导入。",
        },
      });
    } finally {
      await reader.cancel();
      writer.releaseLock();
    }
  });
});

function timeout<T>(value: T, timeoutMs: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), timeoutMs));
}

const CONTEXT_ACP = String.raw`
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const configOptions = [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "alder", options: [
    { value: "alder", name: "Alder", _meta: { trae: { supportsMaxMode: true } } },
    { value: "small", name: "Small", _meta: { trae: { supportsMaxMode: false } } },
    { value: "router", name: "Router", _meta: { trae: { supportsMaxMode: true } } },
  ] },
  { id: "effort", name: "Thinking", category: "thought_level", type: "select", currentValue: "high", options: [
    { value: "low", name: "Low" }, { value: "high", name: "High" },
  ] },
];
if (process.env.MODEL_LOAD) configOptions[0].options[0]._meta.trae.load = { percent: 150 };
if (process.env.GROUP_MODELS) configOptions[0].options = [{ group: "available", name: "Available", options: configOptions[0].options }];
if (process.env.NATIVE_CONTEXT) configOptions.push({ id: "native_context", name: "Context", category: "model_config", type: "select", currentValue: "standard", options: [{value:"standard",name:"Standard"},{value:"max",name:"Max"}] });
let currentModelId = process.env.INITIAL_MODEL || "alder/high";
const ids = ["alder/low", "alder/high", "alder/max/low", "alder/max/high", "small", "router/high", "router/max", "router/max/high", "router/max/max"];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "session/new") send({ jsonrpc: "2.0", id: request.id, result: {
    sessionId: "native-1", configOptions,
    models: { currentModelId, availableModels: ids.map((modelId) => ({ modelId, name: modelId })) },
  } });
  else if (request.method === "session/set_model") {
    if (request.params.modelId === process.env.REJECT_MODEL) send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Max temporarily unavailable" } });
    else if (!ids.includes(request.params.modelId)) send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Invalid model" } });
    else {
      currentModelId = request.params.modelId;
      send({ jsonrpc: "2.0", id: request.id, result: { nativeModelId: currentModelId } });
    }
  } else if (request.method === "session/set_config_option" && ["speed", "native_context"].includes(request.params.configId)) {
    const updated = structuredClone(configOptions);
    if (request.params.configId === "speed") updated.push({ id: "speed", name: "Speed", type: "boolean", currentValue: request.params.value });
    else updated.find((option) => option.id === "native_context").currentValue = request.params.value;
    send({ jsonrpc: "2.0", id: request.id, result: { configOptions: updated } });
  } else send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Unsupported config option" } });
});
`;

async function withContextConnector(
  run: (
    request: (message: import("@getpaseo/plugin/server/acp").AcpStreamMessage) => Promise<unknown>,
  ) => Promise<void>,
  env: NodeJS.ProcessEnv = {},
): Promise<void> {
  const stream = createProcessAcpConnector({
    command: process.execPath,
    args: ["-e", CONTEXT_ACP],
    env: { ...process.env, ...env },
  });
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  const request = async (
    message: import("@getpaseo/plugin/server/acp").AcpStreamMessage,
  ): Promise<unknown> => {
    await writer.write(message);
    return (await reader.read()).value;
  };
  try {
    await request({
      jsonrpc: "2.0",
      id: "open",
      method: "session/new",
      params: { cwd: "/tmp", mcpServers: [] },
    });
    await run(request);
  } finally {
    await reader.cancel();
    writer.releaseLock();
  }
}

function setting(
  id: string | number,
  configId: string,
  value: string | boolean,
): import("@getpaseo/plugin/server/acp").AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/set_config_option",
    params: { sessionId: "native-1", configId, value },
  };
}

describe("TRAE context mode configuration", () => {
  it.each([false, true])(
    "preserves load labels through fresh snapshots and Max changes (grouped: %s)",
    async (grouped) => {
      await withContextConnector(
        async (request) => {
          const alder = {
            value: "alder",
            name: "Alder 🟡 150%",
            _meta: { trae: { load: { percent: 150 } } },
          };
          const options = grouped
            ? [{ group: "available", options: [alder, { name: "Small" }, { name: "Router" }] }]
            : [alder, { name: "Small" }, { name: "Router" }];
          expect(await request(setting(2, "speed", true))).toMatchObject({
            result: {
              configOptions: [
                { id: "model", options },
                { id: "trae_context_mode" },
                { id: "effort" },
                { id: "speed" },
              ],
            },
          });
          expect(await request(setting(3, "trae_context_mode", "max"))).toMatchObject({
            result: {
              configOptions: [
                { id: "model", options },
                { id: "trae_context_mode", currentValue: "max" },
                { id: "effort" },
                { id: "speed" },
              ],
            },
          });
        },
        { MODEL_LOAD: "true", GROUP_MODELS: grouped ? "true" : "" },
      );
    },
  );

  it("preserves Max when changing thinking, returns to Standard, and normalizes unsupported models", async () => {
    await withContextConnector(async (request) => {
      expect(await request(setting(2, "trae_context_mode", "max"))).toMatchObject({
        result: { nativeModelId: "alder/max/high" },
      });
      expect(await request(setting(3, "effort", "low"))).toMatchObject({
        result: {
          nativeModelId: "alder/max/low",
          configOptions: [
            { currentValue: "alder" },
            { currentValue: "max" },
            { currentValue: "low" },
          ],
        },
      });
      expect(await request(setting(4, "trae_context_mode", "standard"))).toMatchObject({
        result: { nativeModelId: "alder/low" },
      });
      await request(setting(5, "trae_context_mode", "max"));
      expect(await request(setting(6, "model", "small"))).toMatchObject({
        result: {
          nativeModelId: "small",
          configOptions: [
            { id: "model", currentValue: "small" },
            {
              id: "trae_context_mode",
              currentValue: "standard",
              options: [{ value: "standard", name: "Standard" }],
            },
          ],
        },
      });
      expect(await request(setting(7, "trae_context_mode", "max"))).toMatchObject({
        id: 7,
        error: { code: -32602 },
      });
      expect(await request(setting(8, "model", "alder"))).toMatchObject({
        result: {
          nativeModelId: "alder/low",
          configOptions: [
            { currentValue: "alder" },
            { currentValue: "standard" },
            { currentValue: "low" },
          ],
        },
      });
    });
  });

  it("distinguishes Max context from a reasoning level also named max", async () => {
    await withContextConnector(async (request) => {
      await request(setting(2, "model", "router"));
      expect(await request(setting(3, "effort", "max"))).toMatchObject({
        result: {
          nativeModelId: "router/max",
          configOptions: [
            { currentValue: "router" },
            { currentValue: "standard" },
            { currentValue: "max" },
          ],
        },
      });
      expect(await request(setting(4, "trae_context_mode", "max"))).toMatchObject({
        result: {
          nativeModelId: "router/max/max",
          configOptions: [
            { currentValue: "router" },
            { currentValue: "max" },
            { currentValue: "max" },
          ],
        },
      });
      expect(await request(setting(5, "trae_context_mode", "standard"))).toMatchObject({
        result: { nativeModelId: "router/max" },
      });
    });
  });

  it("keeps the previous selection after a native refusal", async () => {
    await withContextConnector(
      async (request) => {
        expect(await request(setting(2, "trae_context_mode", "max"))).toEqual({
          jsonrpc: "2.0",
          id: 2,
          error: { code: -32000, message: "Max temporarily unavailable" },
        });
        expect(await request(setting(3, "effort", "low"))).toMatchObject({
          result: {
            nativeModelId: "alder/low",
            configOptions: [
              { currentValue: "alder" },
              { currentValue: "standard" },
              { currentValue: "low" },
            ],
          },
        });
      },
      { REJECT_MODEL: "alder/max/high" },
    );
  });

  it("restores Max from the native session instead of assuming Standard", async () => {
    await withContextConnector(
      async (request) => {
        expect(await request(setting(2, "effort", "low"))).toMatchObject({
          result: {
            nativeModelId: "alder/max/low",
            configOptions: [
              { currentValue: "alder" },
              { currentValue: "max" },
              { currentValue: "low" },
            ],
          },
        });
      },
      { INITIAL_MODEL: "alder/max/high" },
    );
  });

  it("retains context controls when an unrelated configuration returns a new snapshot", async () => {
    await withContextConnector(async (request) => {
      await request(setting(2, "trae_context_mode", "max"));
      expect(await request(setting(3, "speed", true))).toMatchObject({
        result: {
          configOptions: [
            { id: "model", currentValue: "alder" },
            { id: "trae_context_mode", currentValue: "max" },
            { id: "effort", currentValue: "high" },
            { id: "speed", currentValue: true },
          ],
        },
      });
    });
  });

  it("passes through agents that already expose native context controls", async () => {
    await withContextConnector(
      async (request) => {
        expect(await request(setting(2, "native_context", "max"))).toMatchObject({
          result: {
            configOptions: [
              { id: "model" },
              { id: "effort" },
              { id: "native_context", currentValue: "max" },
            ],
          },
        });
      },
      { NATIVE_CONTEXT: "true" },
    );
  });
});
