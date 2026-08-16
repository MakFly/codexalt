import { access, chmod, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import type { AppPaths } from "./paths";
import { findExecutable } from "./paths";
import type { Registry } from "./types";

const FILE_CREDENTIAL_OVERRIDE = 'cli_auth_credentials_store="file"';

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
      if (selfPaths.has(await realpath(candidate))) continue;
      return candidate;
    } catch {
      // Continue to the next candidate.
    }
  }
  throw new Error("Cannot find the real Codex CLI. Set CX_CODEX_BIN to its absolute path.");
}

export async function runCodex(
  binary: string,
  codexHome: string,
  args: string[],
  options: { quiet?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  assertNoCredentialStoreOverride(args);
  // Codex uses last-write-wins for repeated -c flags. Insert immediately before
  // an argument separator so exec-style child arguments still remain untouched.
  const separator = args.indexOf("--");
  const insertion = separator === -1 ? args.length : separator;
  const safeArgs = [...args.slice(0, insertion), "-c", FILE_CREDENTIAL_OVERRIDE, ...args.slice(insertion)];
  const child = Bun.spawn([binary, ...safeArgs], {
    env: { ...(options.env || process.env), CODEX_HOME: codexHome },
    stdin: options.quiet ? "ignore" : "inherit",
    stdout: options.quiet ? "ignore" : "inherit",
    stderr: options.quiet ? "ignore" : "inherit",
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

export function assertNoCredentialStoreOverride(args: string[]): void {
  for (let index = 0; index < args.length; index += 1) {
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
