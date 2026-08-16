import { access, chmod, lstat, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import type { AppPaths } from "./paths";
import { findExecutable } from "./paths";
import type { Registry } from "./types";

const FILE_CREDENTIAL_OVERRIDE = 'cli_auth_credentials_store="file"';

// A third-party wrapper named 'codex' earlier on PATH can call back into cx.
// That cannot be detected by inspecting the file, so bound the chain instead:
// unbounded recursion becomes one actionable error a few levels down.
const SPAWN_DEPTH_VARIABLE = "CX_SPAWN_DEPTH";
const MAX_SPAWN_DEPTH = 8;

function nextSpawnDepth(binary: string, env: NodeJS.ProcessEnv): string {
  const parsed = Number.parseInt(env[SPAWN_DEPTH_VARIABLE] || "0", 10);
  const depth = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  if (depth >= MAX_SPAWN_DEPTH) {
    throw new Error(
      `Refusing to spawn '${binary}' ${MAX_SPAWN_DEPTH} levels deep; it probably wraps cx instead of being the real Codex CLI. Set CX_CODEX_BIN to the real executable.`,
    );
  }
  return String(depth + 1);
}

export async function resolveCodexBinary(registry: Registry, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const choices = [env.CX_CODEX_BIN, registry.codexBinary, ...findExecutable("codex", env)].filter(
    (value): value is string => Boolean(value),
  );
  const selfPaths = new Set<string>();
  for (const self of [process.execPath, process.argv[1]]) {
    if (!self) continue;
    try { selfPaths.add(await realpath(self)); } catch { /* ignore non-files */ }
  }
  for (const choice of choices) {
    const candidate = resolve(choice);
    try {
      await access(candidate, constants.X_OK);
      // Directories are executable too, so X_OK alone is not enough.
      if (!(await stat(candidate)).isFile()) continue;
      if (selfPaths.has(await realpath(candidate))) continue;
      return candidate;
    } catch {
      // Continue to the next candidate.
    }
  }
  throw new Error("Cannot find the real Codex CLI. Set CX_CODEX_BIN to its absolute path.");
}

interface RunOptions { quiet?: boolean; env?: NodeJS.ProcessEnv }

async function spawnAndWait(binary: string, args: string[], env: NodeJS.ProcessEnv, quiet: boolean): Promise<number> {
  const child = Bun.spawn([binary, ...args], {
    env: { ...env, [SPAWN_DEPTH_VARIABLE]: nextSpawnDepth(binary, env) },
    stdin: quiet ? "ignore" : "inherit",
    stdout: quiet ? "ignore" : "inherit",
    stderr: quiet ? "ignore" : "inherit",
  });

  const forward = (signal: NodeJS.Signals) => {
    try { child.kill(signal); } catch { /* child already exited */ }
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, forward);
  try {
    return await child.exited;
  } finally {
    for (const signal of signals) process.off(signal, forward);
  }
}

export async function runCodex(
  binary: string,
  codexHome: string,
  args: string[],
  options: RunOptions = {},
): Promise<number> {
  assertNoCredentialStoreOverride(args);
  // Codex uses last-write-wins for repeated -c flags. Insert immediately before
  // an argument separator so exec-style child arguments still remain untouched.
  const insertion = argumentLimit(args);
  const safeArgs = [...args.slice(0, insertion), "-c", FILE_CREDENTIAL_OVERRIDE, ...args.slice(insertion)];
  return spawnAndWait(binary, safeArgs, { ...(options.env || process.env), CODEX_HOME: codexHome }, Boolean(options.quiet));
}

// Runs the real Codex CLI untouched: no CODEX_HOME override and no injected
// credential store. Only used when the shell hook shadows `codex` and no
// CodexAlt account exists yet, so the plain command keeps working.
export async function runCodexPassthrough(binary: string, args: string[], options: RunOptions = {}): Promise<number> {
  return spawnAndWait(binary, args, { ...(options.env || process.env) }, Boolean(options.quiet));
}

// Arguments after a '--' separator belong to a child process, not to Codex.
function argumentLimit(args: string[]): number {
  const separator = args.indexOf("--");
  return separator === -1 ? args.length : separator;
}

export function assertNoCredentialStoreOverride(args: string[]): void {
  const limit = argumentLimit(args);
  for (let index = 0; index < limit; index += 1) {
    const argument = args[index]!;
    let value: string | undefined;
    if (argument === "-c" || argument === "--config") value = args[index + 1];
    else if (argument.startsWith("--config=")) value = argument.slice("--config=".length);
    if (value && /^\s*cli_auth_credentials_store\s*=/.test(value)) {
      throw new Error("cli_auth_credentials_store is managed by CodexAlt and cannot be overridden.");
    }
  }
}

export function codexHomeFor(paths: AppPaths, alias: string): string {
  return `${paths.profiles}/${alias}`;
}

export async function secureAuthFile(codexHome: string): Promise<boolean> {
  const authFile = `${codexHome}/auth.json`;
  try {
    const metadata = await lstat(authFile);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("auth.json is not a safe regular file.");
    await chmod(authFile, 0o600);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
