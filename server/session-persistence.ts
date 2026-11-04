import { realpath } from "node:fs/promises";
import { normalize } from "node:path";
import type { ProviderPersistence } from "@getpaseo/plugin/server/provider";

export function nativeSessionIdFromHandle(handle: string | null | undefined): string | undefined {
  if (!handle) return undefined;
  if (!handle.startsWith("plugin:")) return handle;
  try {
    const persistence = JSON.parse(handle.slice("plugin:".length));
    return typeof persistence?.data?.sessionId === "string"
      ? persistence.data.sessionId
      : undefined;
  } catch {
    return undefined;
  }
}

export async function canonicalSessionCwd(cwd: string): Promise<string> {
  const path = await realpath(cwd).catch(() => normalize(cwd));
  return process.platform === "win32" ? path.toLowerCase() : path;
}

// Paseo treats the entire opaque persistence value as the import handle. A
// native ID alone makes a closed session in A match A's archived agent when
// importing into B, before the provider ever receives session.open. Include
// the launch directory in both listing and saved persistence to bind reopening
// to the destination workspace. Native ACP still receives the same session ID.
export function workspaceSessionPersistence(
  persistence: ProviderPersistence,
  canonicalCwd: string,
): ProviderPersistence {
  const data = persistence.data;
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    typeof data.sessionId !== "string"
  )
    return persistence;
  return { version: 2, data: { sessionId: data.sessionId, workspaceCwd: canonicalCwd } };
}
