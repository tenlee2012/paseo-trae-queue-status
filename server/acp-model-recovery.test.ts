import { ReadableStream, WritableStream } from "node:stream/web";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { describe, expect, it, vi } from "vitest";
import { withStartupModelRecovery } from "./acp-model-recovery.js";
import { TraeQuestions } from "./questions.js";

const unavailable = {
  code: -32603,
  message: "Internal error: retired model",
  data: "model `retired` is unavailable because its metadata could not be resolved",
};

function fixture(
  fallback: () => Promise<string | undefined>,
  initializeFails: boolean | "transport" = false,
) {
  const starts: Array<string | undefined> = [];
  const closes: boolean[] = [];
  const connection = withStartupModelRecovery((model, isCurrent) => {
    starts.push(model);
    let output: ReadableStreamDefaultController<AcpStreamMessage>;
    return {
      stream: {
        readable: new ReadableStream<AcpStreamMessage>({
          start(controller) {
            output = controller;
          },
          cancel() {
            closes.push(isCurrent());
          },
        }),
        writable: new WritableStream<AcpStreamMessage>({
          write(message) {
            if (!("method" in message) || !("id" in message)) return;
            if (model && initializeFails === "transport") {
              output.error(new Error("Replacement process exited"));
              return;
            }
            if (message.method === "initialize")
              output.enqueue(
                model && initializeFails
                  ? {
                      jsonrpc: "2.0",
                      id: message.id,
                      error: { code: -32603, message: "Reinitialization refused" },
                    }
                  : { jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } },
              );
            else
              output.enqueue(
                model && message.method === "session/new"
                  ? { jsonrpc: "2.0", id: message.id, result: { sessionId: "s" } }
                  : { jsonrpc: "2.0", id: message.id, error: unavailable },
              );
          },
        }),
      },
      questions: new TraeQuestions(async () => {}, { question() {}, resolved() {} }),
      request: async () => ({}),
      supportsSteering: () => true,
      markSessionBound() {},
    };
  }, fallback);
  const reader = connection.stream.readable.getReader();
  const writer = connection.stream.writable.getWriter();
  return {
    reader,
    writer,
    starts,
    closes,
    async initialize() {
      await writer.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      expect((await reader.read()).value).toMatchObject({ id: 1, result: { protocolVersion: 1 } });
    },
    async open() {
      await writer.write({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: "/repo", mcpServers: [] },
      });
    },
  };
}

describe("ACP startup recovery lifecycle", () => {
  it("closes the old process silently, then preserves failures after session startup", async () => {
    const fallback = vi.fn(async () => "available");
    const f = fixture(fallback);
    try {
      await f.initialize();
      await f.open();
      expect((await f.reader.read()).value).toMatchObject({ id: 2, result: { sessionId: "s" } });
      await f.writer.write({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: {} });
      expect((await f.reader.read()).value).toMatchObject({ id: 3, error: unavailable });
      expect(f.starts).toEqual([undefined, "available"]);
      expect(f.closes).toEqual([false]);
      expect(fallback).toHaveBeenCalledExactlyOnceWith("retired");
    } finally {
      await f.reader.cancel();
    }
    expect(f.closes).toEqual([false, true]);
  });

  it("does not start a replacement after cancellation during model lookup", async () => {
    let resolve!: (value: string) => void;
    const fallback = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const f = fixture(fallback);
    await f.initialize();
    await f.open();
    await expect.poll(() => fallback.mock.calls.length).toBe(1);
    await f.reader.cancel();
    resolve("available");
    await Promise.resolve();
    expect(f.starts).toEqual([undefined]);
    expect(f.closes).toEqual([true]);
  });

  it("reports reinitialization failures and closes the replacement", async () => {
    const f = fixture(async () => "available", true);
    await f.initialize();
    await f.open();
    await expect(f.reader.read()).rejects.toThrow("Reinitialization refused");
    expect(f.starts).toEqual([undefined, "available"]);
    await expect.poll(() => f.closes).toEqual([false, true]);
  });

  it("surfaces replacement transport failure without an unhandled cleanup rejection", async () => {
    const f = fixture(async () => "available", "transport");
    await f.initialize();
    await f.open();
    await expect(f.reader.read()).rejects.toThrow("Replacement process exited");
    expect(f.starts).toEqual([undefined, "available"]);
  });
});
