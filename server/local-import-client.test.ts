import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { createHostClient } from "@getpaseo/client/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalImportClient, localImportEndpoint } from "./local-import-client.js";

vi.mock("@getpaseo/client/node", async (original) => ({
  ...(await original<typeof import("@getpaseo/client/node")>()),
  createHostClient: vi.fn().mockReturnValue({}),
}));

let home: string | undefined;
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
  vi.clearAllMocks();
});

describe("local import connection", () => {
  it.each([
    ["0.0.0.0:6767", "ws://127.0.0.1:6767/ws"],
    ["[::]:6767", "ws://[::1]:6767/ws"],
    ["localhost:6767", "ws://localhost:6767/ws"],
    ["unix:///tmp/paseo.sock", "unix:///tmp/paseo.sock"],
  ])("uses a local endpoint for %s", (listen, endpoint) => {
    expect(localImportEndpoint(listen)).toBe(endpoint);
  });

  it.each(["ssh://other-host", "remote.example:6767", "ws://192.0.2.1:6767/ws"])(
    "never sends the local credential to %s",
    (listen) => {
      expect(() => localImportEndpoint(listen)).toThrow();
    },
  );

  async function fixture(serverId = "this-host") {
    home = await mkdtemp(join(tmpdir(), "trae-import-connection-"));
    await writeFile(join(home, "paseo.pid"), JSON.stringify({ serverId, listen: "0.0.0.0:6767" }));
    await writeFile(join(home, "local-credential"), "a".repeat(43) + "\n", { mode: 0o600 });
    return {
      hosts: { list: async () => ({ self: { serverId: "this-host" } }) },
    } as unknown as PaseoApi;
  }

  it("authenticates only to the daemon that owns the panel's SDK", async () => {
    const paseo = await fixture();
    expect((await createLocalImportClient(paseo, home)).serverId).toBe("this-host");
    const [endpoint, config] = vi.mocked(createHostClient).mock.calls[0];
    expect(endpoint).toBe("ws://127.0.0.1:6767/ws");
    expect(config.localCredential?.()).toBe("a".repeat(43));
    expect(config.reconnect).toEqual({ enabled: false });
  });

  it("rejects a PASEO_HOME belonging to another host without opening a connection", async () => {
    const paseo = await fixture("another-host");
    await expect(createLocalImportClient(paseo, home)).rejects.toThrow("不在同一 Paseo 主机");
    expect(createHostClient).not.toHaveBeenCalled();
  });

  it("keeps concurrent workspace requests on separate daemon sessions", async () => {
    const paseo = await fixture();
    await Promise.all([createLocalImportClient(paseo, home), createLocalImportClient(paseo, home)]);
    const ids = vi.mocked(createHostClient).mock.calls.map((call) => call[1].clientId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
