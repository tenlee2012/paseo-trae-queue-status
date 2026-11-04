import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

interface TraeCliCommandOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

// Resolve lazily so a missing installation fails provider discovery, not plugin
// registration. Cache only success so installing the CLI and retrying can recover.
export function createTraeCliCommand(options: TraeCliCommandOptions = {}): () => string {
  let resolved: string | undefined;
  return () => {
    resolved ??= resolveTraeCliCommand(options);
    return resolved;
  };
}

function resolveTraeCliCommand(options: TraeCliCommandOptions): string {
  const env = options.env ?? process.env;
  const windows = (options.platform ?? process.platform) === "win32";
  const path = windows ? win32 : posix;
  const home = (windows ? env.USERPROFILE : env.HOME) || homedir();
  const configured = options.command ?? env.TRAECLI_BIN?.trim();
  // Explicit commands retain their existing semantics and never silently fall
  // back to another installation when the configured executable is unavailable.
  if (configured)
    return configured.startsWith("~/") ? path.join(home, configured.slice(2)) : configured;

  const pathValue = Object.entries(env).find(([key]) =>
    windows ? key.toLowerCase() === "path" : key === "PATH",
  )?.[1];
  const pathDirectories = (pathValue ?? "")
    .split(path.delimiter)
    .map((directory) => directory.replace(/^"(.*)"$/, "$1"))
    .filter((directory) => path.isAbsolute(directory));
  const fallbackDirectories = windows
    ? [
        path.join(home, ".local", "bin"),
        path.join(home, "bin"),
        ...(env.APPDATA ? [path.join(env.APPDATA, "npm")] : []),
        path.join(home, "scoop", "shims"),
      ]
    : [
        path.join(home, ".local", "bin"),
        path.join(home, "bin"),
        path.join(home, ".trae", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        path.join(home, ".npm-global", "bin"),
        path.join(home, ".npm", "bin"),
        path.join(home, ".volta", "bin"),
        path.join(home, ".asdf", "shims"),
        ...nodeVersionBins(env.NVM_DIR || path.join(home, ".nvm")),
      ];
  const directories = [...new Set([...pathDirectories, ...fallbackDirectories])];
  const names = windows
    ? [
        ...new Set([
          ...(env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
            .split(";")
            .filter(Boolean)
            .map((extension) => `traecli${extension.toLowerCase()}`),
          "traecli",
        ]),
      ]
    : ["traecli"];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, windows ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        // Missing files, broken symlinks and inaccessible directories are normal.
      }
    }
  }
  throw new Error(
    `TRAE CLI executable not found. Searched daemon PATH and installation directories: ${directories.join(", ")}. Install traecli or set TRAECLI_BIN to its absolute path in the Paseo daemon environment.`,
  );
}

function nodeVersionBins(nvmDirectory: string): string[] {
  const versions = posix.join(nvmDirectory, "versions", "node");
  try {
    // Inspect only installed version directories, never recursively walk home.
    return readdirSync(versions, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^v\d/.test(entry.name))
      .map((entry) => entry.name)
      .toSorted((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .map((version) => posix.join(versions, version, "bin"));
  } catch {
    return [];
  }
}
