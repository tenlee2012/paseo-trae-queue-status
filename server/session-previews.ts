import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { cleanTraePrompt } from "./prompt-text.js";

const recordSchema = z.object({ type: z.string(), payload: z.record(z.string(), z.unknown()) });
const messageSchema = z.object({
  type: z.literal("message"),
  role: z.literal("user"),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});
const MAX_PREVIEW_BYTES = 1024 * 1024;

// ACP's list response has no prompt preview. Read only a bounded prefix of the
// corresponding local rollout, including both legacy and paginated histories.
// These files are metadata enrichment, never the authority for import handles.
export class TraeSessionPreviews {
  private readonly root: string;
  private paths: Promise<Map<string, string>> | undefined;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.root = resolve(
      env.TRAECLI_HOME || join(env.TRAE_HOME || join(homedir(), ".trae"), "cli"),
      "sessions",
    );
  }

  async read(sessionId: string): Promise<string | undefined> {
    try {
      this.paths ??= this.index();
      const path = (await this.paths).get(sessionId);
      if (!path) return undefined;
      let remainder = "";
      let identified = false;
      const stream = createReadStream(path, {
        encoding: "utf8",
        highWaterMark: 16 * 1024,
        end: MAX_PREVIEW_BYTES - 1,
      });
      for await (const chunk of stream) {
        remainder += chunk;
        let newline: number;
        while ((newline = remainder.indexOf("\n")) !== -1) {
          const line = remainder.slice(0, newline);
          remainder = remainder.slice(newline + 1);
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            continue;
          }
          const record = recordSchema.safeParse(value);
          if (!record.success) continue;
          const { type, payload } = record.data;
          if (type === "session_meta") {
            if ((payload.id ?? payload.session_id) !== sessionId) return undefined;
            identified = true;
          }
          if (!identified) continue;
          if (type === "event_msg" && payload.type === "user_message") {
            if (typeof payload.message === "string") {
              const text = previewText(payload.message);
              if (text) return text;
            }
          }
          const items =
            type === "history_mutation" && Array.isArray(payload.items)
              ? payload.items
              : type === "response_item"
                ? [payload]
                : [];
          for (const item of items) {
            const message = messageSchema.safeParse(item);
            if (!message.success) continue;
            const text = previewText(
              message.data.content
                .filter((part) => part.type === "input_text" || part.type === "text")
                .map((part) => previewText(part.text ?? ""))
                .join("\n"),
            );
            if (text) return text;
            if (!text && message.data.content.some((part) => /image/.test(part.type)))
              return "[图片]";
          }
        }
      }
    } catch {
      // A missing, moved, unreadable or newer-format rollout must not hide an
      // otherwise importable native session or manufacture a prompt preview.
    }
    return undefined;
  }

  private async index(): Promise<Map<string, string>> {
    const paths = new Map<string, string>();
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory() && !entry.name.endsWith(".artifacts")) {
          // oxlint-disable-next-line no-await-in-loop
          await walk(path);
        } else if (entry.isFile()) {
          const id = /-([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\.jsonl$/i.exec(entry.name)?.[1];
          if (id) paths.set(id, path);
        }
      }
    };
    await walk(this.root);
    return paths;
  }
}

function previewText(text: string): string {
  const cleaned = cleanTraePrompt(text).replace(
    /^(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*|<environment_context>[\s\S]*?<\/environment_context>\s*)+/,
    "",
  );
  return /^(?:<environment_context>|<system-reminder>|# AGENTS\.md instructions|<permissions instructions>)/.test(
    cleaned,
  )
    ? ""
    : cleaned;
}
