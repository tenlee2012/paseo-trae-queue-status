import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QUESTION_TOOL_GUIDANCE, cleanTraePrompt } from "./prompt-text.js";
import { listTraeSessions } from "./session-list.js";
import { TraeSessionPreviews } from "./session-previews.js";

const ID = "01a17663-4bf7-78c3-b7ce-30feff5fac35";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(records: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), "trae-session-list-"));
  directories.push(root);
  const day = join(root, "sessions", "2026", "10", "26");
  await mkdir(day, { recursive: true });
  await writeFile(
    join(day, `rollout-2026-10-26T12-00-00-${ID}.jsonl`),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  return {
    root,
    env: { TRAECLI_HOME: root },
    previews: new TraeSessionPreviews({ TRAECLI_HOME: root }),
  };
}

describe("TRAE session import listing", () => {
  it("shows real prompt previews from paginated rollouts, cleans old titles, and filters internal sessions", async () => {
    const { env } = await fixture([
      { type: "session_meta", payload: { id: ID } },
      {
        type: "history_mutation",
        payload: {
          operation: "append",
          items: [
            {
              type: "message",
              role: "developer",
              content: [{ type: "input_text", text: "System instructions" }],
            },
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: "Find the alarm" },
                { type: "input_text", text: QUESTION_TOOL_GUIDANCE },
              ],
            },
          ],
        },
      },
    ]);
    const request = vi.fn().mockResolvedValue({
      sessions: [
        {
          sessionId: "internal",
          cwd: "/repo",
          title: "Generate a title and git branch name for a coding agent based on the prompt",
        },
        {
          sessionId: ID,
          cwd: "/repo",
          title: `Find the alarm${QUESTION_TOOL_GUIDANCE.slice(0, 90)}...`,
        },
      ],
    });
    expect(
      await listTraeSessions(request, { type: "sessions", requestId: "list", limit: 1 }, env),
    ).toEqual([
      {
        persistence: { version: 2, data: { sessionId: ID, workspaceCwd: "/repo" } },
        cwd: "/repo",
        title: "Find the alarm",
        description: "Find the alarm",
        updatedAt: undefined,
      },
    ]);
  });

  it("reads legacy message and user-event previews, skipping injected environment context", async () => {
    const { previews } = await fixture([
      { type: "session_meta", payload: { id: ID } },
      {
        type: "history_mutation",
        payload: {
          operation: "append",
          items: [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "<system-reminder>Injected Git status and date</system-reminder>",
                },
              ],
            },
          ],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<environment_context>ignored</environment_context>" },
          ],
        },
      },
      { type: "event_msg", payload: { type: "user_message", message: "A legacy prompt" } },
    ]);
    expect(await previews.read(ID)).toBe("A legacy prompt");
  });

  it("supports legacy response items and TRAE_HOME overrides", async () => {
    const { root } = await fixture([
      { type: "session_meta", payload: { session_id: ID } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Read this" }],
        },
      },
    ]);
    const traeHome = join(root, "trae");
    await mkdir(traeHome);
    await symlink(root, join(traeHome, "cli"), process.platform === "win32" ? "junction" : "dir");
    expect(await new TraeSessionPreviews({ TRAE_HOME: traeHome }).read(ID)).toBe("Read this");
  });

  it("never reads a different session's prompt or treats missing previews as empty conversations", async () => {
    const { env, previews } = await fixture([
      { type: "session_meta", payload: { id: "different-session" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Private unrelated content" }],
        },
      },
    ]);
    expect(await previews.read(ID)).toBeUndefined();
    expect(
      await listTraeSessions(
        async () => ({ sessions: [{ sessionId: ID, cwd: "/repo", title: "Still importable" }] }),
        { type: "sessions", requestId: "list" },
        env,
      ),
    ).toMatchObject([{ title: "Still importable", description: undefined }]);
  });

  it("finds matches in prompt previews on later pages, deduplicating native IDs", async () => {
    const { env } = await fixture([
      { type: "session_meta", payload: { id: ID } },
      { type: "event_msg", payload: { type: "user_message", message: "A hidden needle" } },
    ]);
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [{ sessionId: "other", cwd: "/repo", title: "Other" }],
        nextCursor: "page2",
      })
      .mockResolvedValueOnce({
        sessions: [
          { sessionId: "other", cwd: "/repo", title: "Other" },
          { sessionId: ID, cwd: "/repo", title: "Renamed session" },
        ],
        nextCursor: "page3",
      });
    expect(
      await listTraeSessions(
        request,
        { type: "sessions", requestId: "list", query: "needle", limit: 1 },
        env,
      ),
    ).toMatchObject([{ title: "Renamed session", description: "A hidden needle" }]);
    expect(request.mock.calls[1]).toEqual(["session/list", { cursor: "page2" }]);
  });

  it("rejects a repeated pagination cursor instead of looping or reporting a complete list", async () => {
    const request = vi.fn().mockResolvedValue({ sessions: [], nextCursor: "same" });
    await expect(
      listTraeSessions(request, { type: "sessions", requestId: "list" }),
    ).rejects.toThrow("repeated session cursor");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.skipIf(process.platform === "win32")(
    "keeps the selected workspace alias as the import destination without a false relocation label",
    async () => {
      const { root, env } = await fixture([]);
      const workspace = join(root, "workspace");
      const alias = join(root, "workspace-alias");
      await mkdir(workspace);
      await symlink(workspace, alias);
      const request = vi.fn().mockResolvedValue({
        sessions: [{ sessionId: "native", cwd: workspace, title: "Found through alias" }],
      });
      expect(
        await listTraeSessions(request, { type: "sessions", requestId: "list", cwd: alias }, env),
      ).toMatchObject([{ title: "Found through alias", cwd: alias, description: undefined }]);
      expect(request).toHaveBeenCalledWith("session/list", { cursor: undefined });
    },
  );

  it("limits This workspace to the source directory while Show all preserves original directories", async () => {
    const { root, env } = await fixture([]);
    const workspace = join(root, "destination");
    await mkdir(workspace);
    const request = vi.fn().mockResolvedValue({
      sessions: [
        { sessionId: "one", cwd: "/old/project-one", title: "First" },
        { sessionId: "two", cwd: workspace, title: "Second" },
      ],
    });
    const scoped = await listTraeSessions(
      request,
      { type: "sessions", requestId: "scoped", cwd: workspace },
      env,
    );
    const unscoped = await listTraeSessions(
      request,
      { type: "sessions", requestId: "unscoped" },
      env,
    );
    expect(scoped).toMatchObject([{ cwd: workspace, title: "Second", description: undefined }]);
    expect(unscoped.map((session) => session.cwd)).toEqual(["/old/project-one", workspace]);
    expect(scoped.map((session) => session.persistence.data)).toEqual([
      { sessionId: "two", workspaceCwd: workspace },
    ]);
    expect(unscoped[0].persistence.data).toEqual({
      sessionId: "one",
      workspaceCwd: "/old/project-one",
    });
    expect(scoped[0].persistence).toEqual(unscoped[1].persistence);
    expect(
      await listTraeSessions(
        request,
        { type: "sessions", requestId: "again", cwd: workspace },
        env,
      ),
    ).toEqual(scoped);
    expect(
      await listTraeSessions(
        request,
        { type: "sessions", requestId: "search", cwd: workspace, query: "First" },
        env,
      ),
    ).toEqual([]);
  });

  it("filters source directories before the limit and continues through unrelated and empty pages", async () => {
    const { root, env } = await fixture([]);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [{ sessionId: "foreign", cwd: root, title: "Matching foreign title" }],
        nextCursor: "page2",
      })
      .mockResolvedValueOnce({ sessions: [], nextCursor: "page3" })
      .mockResolvedValueOnce({
        sessions: [
          { sessionId: "nested", cwd: join(workspace, "child"), title: "Matching child directory" },
          { sessionId: "local", cwd: workspace, title: "Matching local title" },
        ],
        nextCursor: "page4",
      });
    expect(
      await listTraeSessions(
        request,
        { type: "sessions", requestId: "scoped", cwd: workspace, query: "Matching", limit: 1 },
        env,
      ),
    ).toMatchObject([
      {
        cwd: workspace,
        title: "Matching local title",
        persistence: { data: { sessionId: "local" } },
      },
    ]);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("removes only the known appended instruction, preserving ordinary user text", () => {
    expect(cleanTraePrompt(`你好${QUESTION_TOOL_GUIDANCE}`)).toBe("你好");
    expect(cleanTraePrompt("For questions about this project, ask me first.")).toBe(
      "For questions about this project, ask me first.",
    );
    expect(
      cleanTraePrompt(
        "Review this quote: For questions that need the user's choice in Paseo, something else.",
      ),
    ).toContain("something else.");
  });
});
