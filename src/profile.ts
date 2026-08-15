import { chmod, lstat, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppPaths } from "./paths";
import { assertContained, ensurePrivateDirectory, profilePath } from "./paths";
import type { ProfileMode } from "./types";

const SHARED_FILES = ["config.toml", "AGENTS.md"] as const;
const SHARED_DIRECTORIES = ["skills", "agents", "rules"] as const;

export async function ensureSharedArea(paths: AppPaths): Promise<void> {
  await ensurePrivateDirectory(paths.shared);
  for (const name of SHARED_FILES) {
    const target = join(paths.shared, name);
    try {
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Unsafe shared entry: ${target}`);
      await chmod(target, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(target, "", { mode: 0o600, flag: "wx" });
      await chmod(target, 0o600);
    }
  }
  for (const name of SHARED_DIRECTORIES) {
    const target = join(paths.shared, name);
    await ensurePrivateDirectory(target);
  }
}

export async function createStagedProfile(paths: AppPaths, alias: string, mode: ProfileMode): Promise<string> {
  await ensurePrivateDirectory(paths.profiles);
  const staged = join(paths.profiles, `.${alias}.${crypto.randomUUID()}.tmp`);
  assertContained(paths.profiles, staged);
  await mkdir(staged, { mode: 0o700 });
  await chmod(staged, 0o700);
  if (mode === "hybrid") {
    await ensureSharedArea(paths);
    for (const name of [...SHARED_FILES, ...SHARED_DIRECTORIES]) {
      await symlink(join(paths.shared, name), join(staged, name));
    }
  }
  return staged;
}

export async function publishProfile(paths: AppPaths, staged: string, alias: string): Promise<string> {
  const target = profilePath(paths, alias);
  assertContained(paths.profiles, staged);
  assertContained(paths.profiles, target);
  try {
    await lstat(target);
    throw new Error(`Profile path '${alias}' already exists.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(staged, target);
  return target;
}

export async function discardStagedProfile(paths: AppPaths, staged: string): Promise<void> {
  assertContained(paths.profiles, staged);
  await rm(staged, { recursive: true, force: true });
}

export async function removeProfileDirectory(paths: AppPaths, target: string): Promise<void> {
  assertContained(paths.profiles, target);
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Refusing to remove an unsafe profile path.");
  // Node removes symlinks themselves while traversing; it does not follow directory symlinks.
  await rm(target, { recursive: true, force: false });
}
