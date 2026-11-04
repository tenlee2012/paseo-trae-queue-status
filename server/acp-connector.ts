import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ReadableStream, WritableStream } from "node:stream/web";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { AcpConnector, AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type {
  ProviderEvent,
  ProviderPermissionResponse,
  ProviderModel,
  ProviderInput,
  ProviderSessionSummary,
} from "@getpaseo/plugin/server/provider";
import { TraeQuestions, type TraeQuestionEvents } from "./questions.js";
import { TraeContextModeBridge } from "./context-mode.js";
import { COLLABORATION_MODE_ID, TraePlanModeBridge } from "./plan-mode.js";
import { TraePermissionModeBridge } from "./permission-mode.js";
import { TraeHistoryReplayBridge } from "./history-replay.js";
import { toQueueStatusVendorNotification } from "./queue-status.js";
import { createTraeCliCommand } from "./traecli-command.js";
import { listTraeSessions } from "./session-list.js";
import { withStartupModelRecovery, type ManagedAcpConnection } from "./acp-model-recovery.js";
import { TraeQuestionToolApproval } from "./question-tool-approval.js";

const DEFAULT_TRAECLI_ARGS = ["acp", "serve", "--enable", "headless_queue_status"];
const STEERING_METHOD = "_session/steering";
const INTERNAL_REQUEST_TIMEOUT_MS = 10_000;

export interface TraeAcpLaunchOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

interface ProcessConnectorOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onNativeSession?: (sessionId: string) => void;
  onModelCatalog?: (models: readonly ProviderModel[]) => void;
  onSteeringSupport?: (supported: boolean) => void;
  onClose?: () => void;
  onSubagentMessage?: (message: AcpStreamMessage) => boolean;
  questionEvents?: TraeQuestionEvents;
  deferInitialCommandsUntilBound?: boolean;
  fallbackModel?: (unavailableModel: string) => Promise<string | undefined>;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface TraeAcpSteeringRegistry {
  modelCatalog(): readonly ProviderModel[];
  onQuestionEvent(listener: (event: ProviderEvent) => void): () => void;
  respondToQuestion(
    sessionId: string,
    id: string,
    response: ProviderPermissionResponse,
  ): Promise<boolean>;
  connector: AcpConnector;
  listSessions(
    input: Extract<ProviderInput, { type: "sessions" }>,
  ): Promise<ProviderSessionSummary[]>;
  dispose(): Promise<void>;
  supportsSteering(): boolean;
  bindSession(boundarySessionId: string, nativeSessionId: string): boolean;
  unbindSession(boundarySessionId: string): void;
  steer(boundarySessionId: string, prompt: unknown[]): Promise<unknown>;
}

export function createTraeAcpSteeringRegistry(
  launch: TraeAcpLaunchOptions = {},
  command: () => string = createTraeCliCommand(launch),
  fallbackModel?: ProcessConnectorOptions["fallbackModel"],
  onSubagentMessage?: ProcessConnectorOptions["onSubagentMessage"],
): TraeAcpSteeringRegistry {
  const nativeConnections = new Map<string, ManagedAcpConnection>();
  const boundaryConnections = new Map<
    string,
    { connection: ManagedAcpConnection; nativeSessionId: string }
  >();
  const questionListeners = new Set<(event: ProviderEvent) => void>();
  const listings = new Set<AcpStream>();
  let disposed = false;
  let steeringSupported = false;
  let modelCatalog: readonly ProviderModel[] = [];

  const connector: AcpConnector = () => {
    let managed!: ManagedAcpConnection;
    managed = createManagedProcessAcpConnection({
      command: command(),
      args: launch.args ?? DEFAULT_TRAECLI_ARGS,
      env: launch.env ?? process.env,
      deferInitialCommandsUntilBound: true,
      fallbackModel,
      onSubagentMessage,
      questionEvents: {
        question(nativeSessionId, request) {
          for (const [sessionId, binding] of boundaryConnections) {
            if (binding.nativeSessionId !== nativeSessionId || binding.connection !== managed)
              continue;
            for (const listener of questionListeners)
              listener({ type: "session.permission", sessionId, request });
          }
        },
        resolved(nativeSessionId, permissionId) {
          for (const [sessionId, binding] of boundaryConnections) {
            if (binding.nativeSessionId !== nativeSessionId || binding.connection !== managed)
              continue;
            for (const listener of questionListeners)
              listener({ type: "session.permission_resolved", sessionId, permissionId });
          }
        },
      },
      onNativeSession(sessionId) {
        nativeConnections.set(sessionId, managed);
      },
      onModelCatalog(models) {
        modelCatalog = models;
      },
      onSteeringSupport(supported) {
        steeringSupported ||= supported;
      },
      onClose() {
        for (const [sessionId, connection] of nativeConnections) {
          if (connection === managed) nativeConnections.delete(sessionId);
        }
        for (const [sessionId, binding] of boundaryConnections) {
          if (binding.connection === managed) boundaryConnections.delete(sessionId);
        }
      },
    });
    return managed.stream;
  };

  return {
    modelCatalog: () => modelCatalog,
    onQuestionEvent(listener) {
      questionListeners.add(listener);
      return () => questionListeners.delete(listener);
    },
    async respondToQuestion(sessionId, id, response) {
      const binding = boundaryConnections.get(sessionId);
      if (!binding?.connection.questions.has(id)) return false;
      await binding.connection.questions.respond(id, response);
      return true;
    },
    connector,
    async listSessions(input) {
      if (disposed) throw new Error("TRAE provider connection is closed");
      const connection = createManagedProcessAcpConnection({
        command: command(),
        args: launch.args ?? DEFAULT_TRAECLI_ARGS,
        env: launch.env ?? process.env,
      });
      listings.add(connection.stream);
      try {
        await connection.request("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "paseo", version: "1" },
          clientCapabilities: {},
        });
        return await listTraeSessions(connection.request, input, launch.env);
      } finally {
        listings.delete(connection.stream);
        await connection.stream.readable.cancel();
      }
    },
    async dispose() {
      disposed = true;
      await Promise.all([...listings].map((stream) => stream.readable.cancel()));
      listings.clear();
    },
    supportsSteering: () => steeringSupported,
    bindSession(boundarySessionId, nativeSessionId) {
      const connection = nativeConnections.get(nativeSessionId);
      if (!connection) return false;
      boundaryConnections.set(boundarySessionId, { connection, nativeSessionId });
      connection.markSessionBound();
      return true;
    },
    unbindSession(boundarySessionId) {
      boundaryConnections.delete(boundarySessionId);
    },
    async steer(boundarySessionId, prompt) {
      const binding = boundaryConnections.get(boundarySessionId);
      if (!binding) throw new Error(`TRAE ACP session is not bound: ${boundarySessionId}`);
      if (!binding.connection.supportsSteering()) {
        throw new Error("TRAE ACP session does not advertise steering support");
      }
      return binding.connection.request(STEERING_METHOD, {
        sessionId: binding.nativeSessionId,
        prompt,
      });
    },
  };
}

export const createTraeAcpConnector: AcpConnector = createTraeAcpSteeringRegistry().connector;

export function createProcessAcpConnector(options: ProcessConnectorOptions): AcpStream {
  return createManagedProcessAcpConnection(options).stream;
}

function createManagedProcessAcpConnection(options: ProcessConnectorOptions): ManagedAcpConnection {
  if (
    !options.fallbackModel ||
    options.args.some((arg) => /^(?:model\s*=|-m$|--model(?:=|$))/.test(arg))
  )
    return createSingleProcessAcpConnection(options);
  return withStartupModelRecovery(
    (model, isCurrent) =>
      createSingleProcessAcpConnection({
        ...options,
        args: model ? [...options.args, "-c", `model=${JSON.stringify(model)}`] : options.args,
        onClose: () => {
          if (isCurrent()) options.onClose?.();
        },
        onExit: (code, signal) => {
          if (isCurrent()) options.onExit?.(code, signal);
        },
      }),
    options.fallbackModel,
  );
}

function createSingleProcessAcpConnection(options: ProcessConnectorOptions): ManagedAcpConnection {
  const child = spawnProcess(options.command, options.args, {
    env: options.env,
    stdio: "pipe",
  });
  child.stderr.resume();

  // Only SDK-managed sessions have a bind callback that ends initial config.
  const contextMode = new TraeContextModeBridge(options.deferInitialCommandsUntilBound === true);
  const questionEvents = options.questionEvents ?? { question() {}, resolved() {} };
  const questions = new TraeQuestions((message) => enqueueWrite(message, false), questionEvents);
  const planMode = new TraePlanModeBridge();
  const permissionMode = new TraePermissionModeBridge();
  const historyReplay = new TraeHistoryReplayBridge();
  const questionApproval = new TraeQuestionToolApproval();
  let output: ReadableStreamDefaultController<AcpStreamMessage>;
  const baseRequests = new Map<string, string>();
  const loadingSessions = new Map<string, string>();
  const pendingRequests = new Map<string, PendingRequest>();
  let stdoutBuffer = "";
  let readableActive = true;
  let expectedShutdown = false;
  let steeringSupported = false;
  let shutdownPromise: Promise<void> | null = null;
  let writeLane = Promise.resolve();
  let internalRequestSequence = 0;
  let initializingPermission = false;
  const deferredMessages: AcpStreamMessage[] = [];
  let initialCommands: AcpStreamMessage | undefined;
  let initialCommandsSent = false;
  let sessionBound = false;
  let commandsTimer: ReturnType<typeof setTimeout> | undefined;

  const shutdown = (graceful: boolean): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    expectedShutdown = true;
    if (commandsTimer) clearTimeout(commandsTimer);
    initialCommands = undefined;
    questions.close();
    rejectPendingRequests(new Error("TRAE ACP transport closed"));
    shutdownPromise = stopChild(child, graceful);
    return shutdownPromise;
  };

  const enqueueWrite = async (
    message: AcpStreamMessage,
    observeBaseRequest = true,
  ): Promise<void> => {
    if (observeBaseRequest) {
      historyReplay.outgoing(message);
      questionApproval.outgoing(message);
      if (
        "method" in message &&
        "id" in message &&
        message.id !== null &&
        message.method === "session/load"
      ) {
        const sessionId = asRecord(message.params)?.sessionId;
        if (typeof sessionId === "string") loadingSessions.set(requestKey(message.id), sessionId);
      }
      message = advertiseQuestions(message);
      if ("method" in message && message.method === "session/cancel") {
        const params = asRecord(message.params);
        if (typeof params?.sessionId === "string") await questions.cancel(params.sessionId);
      }
      observeOutgoingMessage(message, baseRequests);
    }
    const planned = observeBaseRequest ? planMode.outgoing(message) : { message };
    if ("responses" in planned) {
      for (const response of planned.responses) {
        responseMethod(response, baseRequests);
        output.enqueue(response);
      }
      return Promise.resolve();
    }
    const outgoing = observeBaseRequest ? contextMode.outgoing(planned.message) : planned;
    if ("response" in outgoing) {
      responseMethod(outgoing.response, baseRequests);
      for (const response of planMode.incoming(outgoing.response)) output.enqueue(response);
      return Promise.resolve();
    }
    const nativeMessage = observeBaseRequest
      ? permissionMode.outgoing(outgoing.message)
      : outgoing.message;
    const operation = writeLane.then(() => writeMessage(child, nativeMessage));
    writeLane = operation.catch(() => undefined);
    return operation;
  };

  const readable = new ReadableStream<AcpStreamMessage>({
    start(controller) {
      output = controller;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (!readableActive) return;
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        try {
          for (const line of lines) handleLine(line, controller);
        } catch (error) {
          readableActive = false;
          controller.error(error);
          void shutdown(false);
        }
      });
      child.once("error", (error) => {
        rejectPendingRequests(error);
        if (!readableActive) return;
        readableActive = false;
        controller.error(error);
      });
      child.once("close", (code, signal) => {
        questions.close();
        options.onExit?.(code, signal);
        options.onClose?.();
        rejectPendingRequests(
          new Error(`TRAE ACP process exited (${signal ?? code ?? "unknown"})`),
        );
        if (!readableActive) return;
        readableActive = false;
        try {
          if (stdoutBuffer.trim()) handleLine(stdoutBuffer, controller);
          if (expectedShutdown || code === 0) controller.close();
          else
            controller.error(new Error(`TRAE ACP process exited (${signal ?? code ?? "unknown"})`));
        } catch (error) {
          controller.error(error);
        }
      });
    },
    cancel() {
      readableActive = false;
      return shutdown(false);
    },
  });

  const writable = new WritableStream<AcpStreamMessage>({
    write(message) {
      return enqueueWrite(message);
    },
    close() {
      if (!child.stdin.destroyed) child.stdin.end();
    },
    abort() {
      return shutdown(false);
    },
  });

  function handleLine(
    line: string,
    controller: ReadableStreamDefaultController<AcpStreamMessage>,
  ): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: AcpStreamMessage;
    try {
      message = JSON.parse(trimmed) as AcpStreamMessage;
    } catch (error) {
      throw new Error("TRAE ACP emitted invalid JSON on stdout", { cause: error });
    }

    if ("error" in message) {
      const detail =
        typeof message.error.data === "string"
          ? message.error.data
          : asRecord(message.error.data)?.message;
      if (typeof detail === "string" && /thread-store conflict:.*active writer/.test(detail))
        message = {
          ...message,
          error: {
            ...message.error,
            message: "该会话仍被 TRAE CLI 或其他客户端占用，请先关闭原会话后重试导入。",
          },
        };
      else if (
        typeof detail === "string" &&
        detail.trim() &&
        !message.error.message.includes(detail.trim())
      )
        message = {
          ...message,
          error: { ...message.error, message: `${message.error.message}: ${detail.trim()}` },
        };
    }

    if (options.onSubagentMessage?.(message)) return;
    for (const incoming of historyReplay.incoming(message)) forwardMessage(incoming, controller);
  }

  function forwardMessage(
    message: AcpStreamMessage,
    controller: ReadableStreamDefaultController<AcpStreamMessage>,
  ): void {
    if (settleInternalRequest(message, pendingRequests)) return;
    if (initializingPermission) {
      deferredMessages.push(message);
      return;
    }
    const questionResult = questionApproval.incoming(message) ?? questions.incoming(message);
    if (questionResult) {
      if (questionResult !== true) {
        void enqueueWrite(questionResult, false).catch((error: unknown) => {
          if (!readableActive) return;
          readableActive = false;
          controller.error(error);
          void shutdown(false);
        });
      }
      return;
    }
    const loadedSessionId =
      "id" in message && message.id !== null && !("method" in message)
        ? loadingSessions.get(requestKey(message.id))
        : undefined;
    if ("id" in message && message.id !== null && !("method" in message))
      loadingSessions.delete(requestKey(message.id));
    const baseMethod = responseMethod(message, baseRequests);
    if (baseMethod === "initialize") {
      steeringSupported = readSteeringSupport(message);
      options.onSteeringSupport?.(steeringSupported);
    } else if (baseMethod === "session/new" || baseMethod === "session/load") {
      // ACP session/load normally omits sessionId. Bind the requested native ID
      // only after a successful load so imported questions and steering work too.
      const nativeSessionId =
        "result" in message ? (readResultSessionId(message) ?? loadedSessionId) : undefined;
      if (nativeSessionId) options.onNativeSession?.(nativeSessionId);
    }

    const planFallback = planMode.initialMode(message);
    const fallback = planFallback;
    if (fallback && "result" in message) {
      // Confirm missing permissions or migrate a legacy read-only Plan session
      // before publishing it. Paseo then applies saved settings as usual.
      initializingPermission = true;
      const setPermission = (modeId: string) =>
        planFallback?.permissionConfigId
          ? requestNative("session/set_config_option", {
              sessionId: fallback.sessionId,
              configId: planFallback.permissionConfigId,
              value: modeId,
            })
          : requestNative("session/set_mode", { sessionId: fallback.sessionId, modeId });
      const initialize = async () => {
        try {
          const permissionResponse = asRecord(await setPermission(fallback.modes.currentModeId));
          const result: Record<string, unknown> = { ...asRecord(message.result) };
          if (planFallback?.permissionConfigId) {
            const configOptions = permissionResponse?.configOptions;
            if (
              !Array.isArray(configOptions) ||
              !configOptions.some(
                (option: unknown) =>
                  asRecord(option)?.id === planFallback.permissionConfigId &&
                  asRecord(option)?.currentValue === fallback.modes.currentModeId,
              )
            )
              throw new Error("TRAE CLI did not confirm the selected permission mode");
            result.configOptions = configOptions;
          } else {
            result.modes = fallback.modes;
          }
          if (planFallback && planFallback.previousCollaboration !== "plan") {
            const response = asRecord(
              await requestNative("session/set_config_option", {
                sessionId: planFallback.sessionId,
                configId: COLLABORATION_MODE_ID,
                value: "plan",
              }),
            );
            if (
              !Array.isArray(response?.configOptions) ||
              !response.configOptions.some(
                (option: unknown) =>
                  asRecord(option)?.id === COLLABORATION_MODE_ID &&
                  asRecord(option)?.currentValue === "plan",
              )
            )
              throw new Error("TRAE CLI did not confirm collaboration configuration");
            result.configOptions = response.configOptions;
          }
          return result;
        } catch (error) {
          if (planFallback) {
            // Keep an imported legacy Plan session read-only if migration fails.
            try {
              await setPermission("plan");
            } catch (rollbackError) {
              throw new Error(
                `Plan migration failed: ${toError(error).message}; permission rollback failed: ${toError(rollbackError).message}`,
                { cause: rollbackError },
              );
            }
          }
          throw error;
        }
      };
      void initialize()
        .then((result) => {
          if (readableActive) forwardNormalized({ ...message, result }, baseMethod, controller);
          return undefined;
        })
        .catch((error: unknown) => {
          if (!readableActive) return;
          forwardNormalized(
            {
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32603,
                message: `TRAE CLI ${planFallback ? "Plan migration" : "permission fallback"} failed: ${toError(error).message}`,
              },
            },
            baseMethod,
            controller,
          );
        })
        .finally(() => {
          initializingPermission = false;
          try {
            for (const deferred of deferredMessages.splice(0)) {
              if (readableActive) forwardMessage(deferred, controller);
            }
          } catch (error) {
            if (!readableActive) return;
            readableActive = false;
            controller.error(error);
            void shutdown(false);
          }
        });
      return;
    }
    forwardNormalized(message, baseMethod, controller);
  }

  function forwardNormalized(
    message: AcpStreamMessage,
    baseMethod: string | undefined,
    controller: ReadableStreamDefaultController<AcpStreamMessage>,
  ): void {
    if (
      !initialCommandsSent &&
      "method" in message &&
      message.method === "session/update" &&
      asRecord(asRecord(message.params)?.update)?.sessionUpdate === "available_commands_update"
    ) {
      initialCommands = message;
      flushInitialCommands(controller);
      return;
    }
    for (const permission of permissionMode.incoming(message)) {
      for (const incoming of contextMode.incoming(permission)) {
        for (const planned of planMode.incoming(incoming)) controller.enqueue(planned);
      }
    }
    if (baseMethod === "session/new" || baseMethod === "session/load") {
      options.onModelCatalog?.(contextMode.modelCatalog());
    }
    const queueStatus = toQueueStatusVendorNotification(message);
    if (queueStatus) controller.enqueue(queueStatus);
    flushInitialCommands(controller);
  }

  // The adapter drains replay notifications and applies initial configuration
  // before installing its command waiter. session.opened binds the native
  // connection at that boundary; publish on the next tick once the waiter exists.
  function flushInitialCommands(
    controller: ReadableStreamDefaultController<AcpStreamMessage>,
  ): void {
    if (
      !initialCommands ||
      commandsTimer ||
      expectedShutdown ||
      (options.deferInitialCommandsUntilBound && !sessionBound)
    )
      return;
    commandsTimer = setTimeout(() => {
      commandsTimer = undefined;
      if (
        !readableActive ||
        expectedShutdown ||
        initializingPermission ||
        baseRequests.size ||
        pendingRequests.size ||
        !initialCommands
      )
        return;
      const commands = initialCommands;
      initialCommands = undefined;
      initialCommandsSent = true;
      forwardNormalized(commands, undefined, controller);
    }, 0);
  }

  function rejectPendingRequests(error: Error): void {
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      pendingRequests.delete(id);
    }
  }

  function requestNative(method: string, params: unknown): Promise<unknown> {
    internalRequestSequence += 1;
    const id = `paseo-steer:${internalRequestSequence}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`TRAE ACP request timed out: ${method}`));
      }, INTERNAL_REQUEST_TIMEOUT_MS);
      pendingRequests.set(id, { resolve, reject, timeout });
      void enqueueWrite({ jsonrpc: "2.0", id, method, params }, false).catch((error: unknown) => {
        const pending = pendingRequests.get(id);
        if (!pending) return;
        pendingRequests.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(toError(error));
      });
    });
  }

  return {
    stream: { readable, writable },
    questions,
    supportsSteering: () => steeringSupported,
    request: requestNative,
    markSessionBound() {
      sessionBound = true;
      contextMode.markSessionBound();
      flushInitialCommands(output);
    },
  };
}

function observeOutgoingMessage(message: AcpStreamMessage, requests: Map<string, string>): void {
  if (!("method" in message) || !("id" in message) || message.id === null) return;
  requests.set(requestKey(message.id), message.method);
}

function responseMethod(
  message: AcpStreamMessage,
  requests: Map<string, string>,
): string | undefined {
  if (!("id" in message) || "method" in message || message.id === null) return undefined;
  const key = requestKey(message.id);
  const method = requests.get(key);
  requests.delete(key);
  return method;
}

function settleInternalRequest(
  message: AcpStreamMessage,
  pendingRequests: Map<string, PendingRequest>,
): boolean {
  if (!("id" in message) || "method" in message || typeof message.id !== "string") return false;
  if (!message.id.startsWith("paseo-steer:")) return false;
  const pending = pendingRequests.get(message.id);
  if (!pending) return true;
  pendingRequests.delete(message.id);
  clearTimeout(pending.timeout);
  if ("error" in message) pending.reject(new Error(message.error.message));
  else pending.resolve(message.result);
  return true;
}

function readSteeringSupport(message: AcpStreamMessage): boolean {
  if (!("result" in message)) return false;
  const result = asRecord(message.result);
  const meta = asRecord(result?._meta);
  const steering = asRecord(meta?.steering);
  return steering?.supported === true;
}

function readResultSessionId(message: AcpStreamMessage): string | null {
  if (!("result" in message)) return null;
  const result = asRecord(message.result);
  return typeof result?.sessionId === "string" ? result.sessionId : null;
}

function requestKey(id: string | number): string {
  return `${typeof id}:${id}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function writeMessage(
  child: ChildProcessWithoutNullStreams,
  message: AcpStreamMessage,
): Promise<void> {
  if (child.stdin.destroyed || !child.stdin.writable) {
    return Promise.reject(new Error("TRAE ACP stdin is closed"));
  }
  return new Promise((resolve, reject) => {
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams, graceful: boolean): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  if (graceful && !child.stdin.destroyed) child.stdin.end();
  if (graceful && (await settlesWithin(exited, 250))) return;
  await terminateProcess(child, "SIGTERM");
  if (await settlesWithin(exited, 750)) return;
  await terminateProcess(child);
  await settlesWithin(exited, 750);
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = await Promise.race([promise.then(() => true), timedOut]);
  if (timeout) clearTimeout(timeout);
  return settled;
}

function advertiseQuestions(message: AcpStreamMessage): AcpStreamMessage {
  if (!("method" in message) || message.method !== "initialize") return message;
  const params = asRecord(message.params);
  const capabilities = asRecord(params?.clientCapabilities);
  return {
    ...message,
    params: { ...params, clientCapabilities: { ...capabilities, elicitation: { form: {} } } },
  };
}
