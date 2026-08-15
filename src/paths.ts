import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { platform } from "node:os";

export interface AppPaths {
  root: string;
  registry: string;
  profiles: string;
  shared: string;
}

export function getAppPaths(env: NodeJS.ProcessEnv = process.env): AppPaths {
  const explicit = env.CX_DATA_HOME;
  const home = env.HOME;
  if (!explicit && !home) throw new Error("HOME is not set; set CX_DATA_HOME explicitly.");

  const root = explicit
    ? resolve(explicit)
    : platform() === "darwin"
      ? join(home!, "Library", "Application Support", "codexplusplus")
      : join(env.XDG_DATA_HOME || join(home!, ".local", "share"), "codexplusplus");

  return {
    root,
    registry: join(root, "registry.json"),
    profiles: join(root, "profiles"),
    shared: join(root, "shared"),
  };
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Refusing unsafe data directory: ${path}`);
  }
  await chmod(path, 0o700);
}

export function profilePath(paths: AppPaths, alias: string): string {
  return join(paths.profiles, alias);
}

export function assertContained(parent: string, child: string): void {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  if (childPath === parentPath || !childPath.startsWith(`${parentPath}/`)) {
    throw new Error(`Unsafe path outside ${parentPath}`);
  }
}

export async function assertSafeProfileDirectory(paths: AppPaths, alias: string): Promise<string> {
  const target = profilePath(paths, alias);
  assertContained(paths.profiles, target);
  for (const [directory, label] of [[paths.root, "data root"], [paths.profiles, "profiles root"]] as const) {
    const parentStat = await lstat(directory);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error(`Unsafe ${label}: ${directory}`);
  }
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe profile directory: ${target}`);
  const actualParent = await realpath(dirname(target));
  const expectedParent = await realpath(paths.profiles);
  if (actualParent !== expectedParent) throw new Error(`Unsafe profile parent: ${actualParent}`);
  return target;
}

export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const pathValue = env.PATH || "";
  const current = resolve(process.execPath);
  const candidates: string[] = [];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, name);
    if (candidate === current || candidates.includes(candidate)) continue;
    try {
      if (Bun.file(candidate).size > 0) candidates.push(candidate);
    } catch {
      // Ignore unreadable PATH entries.
    }
  }
  return candidates;
}
