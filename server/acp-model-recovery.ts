/* eslint-disable no-await-in-loop -- ACP wire order and process replacement must remain sequential. */
import { ReadableStream, WritableStream } from "node:stream/web";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { TraeQuestions } from "./questions.js";

export interface ManagedAcpConnection {
  stream: AcpStream;
  questions: TraeQuestions;
  request(method: string, params: unknown): Promise<unknown>;
  supportsSteering(): boolean;
  markSessionBound(): void;
}

// Keep the SDK stream stable while replacing only a failed startup process.
// Never retry prompts or configuration changes: they may already have taken effect.
export function withStartupModelRecovery(
  connect: (model: string | undefined, isCurrent: () => boolean) => ManagedAcpConnection,
  fallback: (unavailableModel: string) => Promise<string | undefined>,
): ManagedAcpConnection {
  let generation = 0;
  const start = (model?: string) => {
    const currentGeneration = ++generation;
    return connect(model, () => generation === currentGeneration);
  };
  let current = start();
  let reader = current.stream.readable.getReader();
  let writer = current.stream.writable.getWriter();
  let initialize: AcpStreamMessage | undefined;
  let startup: AcpStreamMessage | undefined;
  let retried = false;
  let closed = false;
  let ready: Promise<void> = Promise.resolve();
  let reinitializing:
    | { id: string | number | null; resolve(): void; reject(error: Error): void }
    | undefined;

  const stop = async () => {
    closed = true;
    reinitializing?.reject(new Error("TRAE ACP transport closed"));
    // A failed read may already have errored the stream; cleanup must not reject it again.
    await reader.cancel().catch(() => undefined);
  };
  const readable = new ReadableStream<AcpStreamMessage>({
    start(controller) {
      void (async () => {
        for (;;) {
          if (closed) return;
          const next = await reader.read();
          if (closed) return;
          if (next.done) {
            reinitializing?.reject(new Error("TRAE ACP exited during model recovery"));
            controller.close();
            return;
          }
          let message = next.value;
          if (
            reinitializing &&
            "id" in message &&
            !("method" in message) &&
            message.id === reinitializing.id
          ) {
            if ("error" in message) reinitializing.reject(new Error(message.error.message));
            else reinitializing.resolve();
            reinitializing = undefined;
            continue;
          }
          const failedModel = unavailableStartupModel(message);
          if (
            !retried &&
            failedModel &&
            initialize &&
            startup &&
            "id" in startup &&
            "id" in message &&
            message.id === startup.id
          ) {
            retried = true;
            try {
              const replacement = await fallback(failedModel);
              if (closed) return;
              if (!replacement || replacement === failedModel)
                throw new Error("no available fallback model");
              // Suppress lifecycle callbacks from the process deliberately being replaced.
              ++generation;
              await reader.cancel();
              writer.releaseLock();
              if (closed) return;
              current = start(replacement);
              reader = current.stream.readable.getReader();
              writer = current.stream.writable.getWriter();
              const originalStartup = startup;
              let timeout: ReturnType<typeof setTimeout>;
              const initialized = new Promise<void>((resolve, reject) => {
                reinitializing = {
                  id: "id" in initialize! ? initialize!.id : null,
                  resolve,
                  reject,
                };
                timeout = setTimeout(
                  () => reject(new Error("TRAE ACP model recovery initialization timed out")),
                  10_000,
                );
              });
              ready = initialized
                .finally(() => clearTimeout(timeout))
                .then(async () => {
                  if (!closed) await writer.write(originalStartup);
                  return undefined;
                });
              void ready.catch((error: unknown) => {
                if (!closed) {
                  controller.error(error);
                  void stop();
                }
              });
              await writer.write(initialize);
              console.warn(
                `TRAE ACP startup model ${failedModel} is unavailable; retrying with ${replacement}`,
              );
              continue;
            } catch (error) {
              if (closed) return;
              if ("error" in message)
                message = {
                  ...message,
                  error: {
                    ...message.error,
                    message: `${message.error.message}; model recovery failed: ${error instanceof Error ? error.message : String(error)}`,
                  },
                };
            }
          }
          if (
            startup &&
            "id" in startup &&
            "id" in message &&
            !("method" in message) &&
            message.id === startup.id
          )
            startup = undefined;
          controller.enqueue(message);
        }
      })().catch((error: unknown) => {
        reinitializing?.reject(error instanceof Error ? error : new Error(String(error)));
        if (!closed) {
          controller.error(error);
          void stop();
        }
      });
    },
    cancel: stop,
  });
  return {
    stream: {
      readable,
      writable: new WritableStream<AcpStreamMessage>({
        async write(message) {
          await ready;
          if (closed) throw new Error("TRAE ACP transport closed");
          if ("method" in message) {
            if (message.method === "initialize") initialize = message;
            if (message.method === "session/new" || message.method === "session/load")
              startup = message;
          }
          await writer.write(message);
        },
        close: stop,
        abort: stop,
      }),
    },
    get questions() {
      return current.questions;
    },
    async request(method, params) {
      await ready;
      return current.request(method, params);
    },
    supportsSteering: () => current.supportsSteering(),
    markSessionBound: () => current.markSessionBound(),
  };
}

function unavailableStartupModel(message: AcpStreamMessage): string | undefined {
  if (!("error" in message) || message.error.code !== -32603) return undefined;
  const detail = message.error.data;
  if (typeof detail !== "string") return undefined;
  return /model `([^`]+)` is unavailable because its metadata could not be resolved/.exec(
    detail,
  )?.[1];
}
