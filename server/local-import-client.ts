import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHostClient, parseHostTarget } from "@getpaseo/client/node";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";

export type ImportClient = Pick<
  ReturnType<typeof createHostClient>,
  "connect" | "close" | "fetchRecentProviderSessions" | "importAgent" | "listHosts"
>;

// Paseo 0.13's plugin PaseoApi omits list/import of provider sessions. Keep the
// compatibility connection on the backend and use the official Node client for
// just these operations. Never connect to a different host or expose its token.
export function localImportEndpoint(listen: string): string {
  const target = parseHostTarget(listen);
  if (target.kind !== "socket" || target.offer || target.password)
    throw new Error("会话导入需要本机 Paseo 连接。");
  if (target.socketPath) return listen;
  const url = new URL(target.url);
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
  if (url.hostname === "[::]") url.hostname = "[::1]";
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("无法确定本机 Paseo 连接，请检查 daemon 的监听地址。");
  return url.toString();
}

export async function createLocalImportClient(
  paseo: PaseoApi,
  home = process.env.PASEO_HOME?.replace(/^~(?=\/)/, homedir()) ?? join(homedir(), ".paseo"),
): Promise<{ client: ImportClient; serverId: string }> {
  const { self } = await paseo.hosts.list();
  const lock = z
    .object({ serverId: z.string(), listen: z.string() })
    .parse(JSON.parse(await readFile(join(home, "paseo.pid"), "utf8")));
  if (lock.serverId !== self.serverId)
    throw new Error("导入服务与当前工作区不在同一 Paseo 主机，请检查 PASEO_HOME。");
  const endpoint = localImportEndpoint(lock.listen);
  const credential = await readFile(join(home, "local-credential"), "utf8")
    .then((value) => value.trim())
    .catch(() => undefined);
  if (credential !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(credential))
    throw new Error("无法读取本机 Paseo 凭据，请重新连接宿主后重试。");
  return {
    client: createHostClient(endpoint, {
      clientId: `trae-workspace-import-${randomUUID()}`,
      clientType: "cli",
      localCredential: () => credential,
      reconnect: { enabled: false },
      connectTimeoutMs: 10_000,
    }),
    serverId: self.serverId,
  };
}
