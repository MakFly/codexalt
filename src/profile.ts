import { chmod, lstat, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppPaths } from "./paths";
import { assertContained, ensurePrivateDirectory, profilePath } from "./paths";
import type { ProfileMode } from "./types";

// A blank seed has to be valid for the format Codex expects, otherwise a fresh
// hybrid profile hands it a file it cannot parse. Empty is valid TOML and valid
// Markdown; it is not valid JSON.
const SHARED_FILE_SEEDS = {
  "config.toml": "",
  "AGENTS.md": "",
  "CLAUDE.md": "",
  "hooks.json": '{"hooks":{}}\n',
} as const;
const SHARED_FILES = Object.keys(SHARED_FILE_SEEDS) as (keyof typeof SHARED_FILE_SEEDS)[];
const SHARED_DIRECTORIES = ["skills", "agents", "rules"] as const;

export const SHARED_FILE_NAMES: readonly string[] = SHARED_FILES;
export const SHARED_ENTRIES: readonly string[] = [...SHARED_FILES, ...SHARED_DIRECTORIES];

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
      await writeFile(target, SHARED_FILE_SEEDS[name], { mode: 0o600, flag: "wx" });
      await chmod(target, 0o600);
    }
  }
  for (const name of SHARED_DIRECTORIES) {
    const target = join(paths.shared, name);
    await ensurePrivateDirectory(target);
  }
}

// The shared set grows over time. Profiles created before an entry existed lack
// its link, so relink adds only what is missing and never replaces anything the
// user put there by hand.
export async function relinkSharedEntries(paths: AppPaths, home: string): Promise<string[]> {
  await ensureSharedArea(paths);
  const added: string[] = [];
  for (const name of SHARED_ENTRIES) {
    const link = join(home, name);
    const expected = join(paths.shared, name);
    try {
      const metadata = await lstat(link);
      if (!metadata.isSymbolicLink()) throw new Error(`'${name}' already exists in the profile and is not a link to the shared area.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await symlink(expected, link);
      added.push(name);
    }
  }
  return added;
}

export async function createStagedProfile(paths: AppPaths, alias: string, mode: ProfileMode): Promise<string> {
  await ensurePrivateDirectory(paths.profiles);
  const staged = join(paths.profiles, `.${alias}.${crypto.randomUUID()}.tmp`);
  assertContained(paths.profiles, staged);
  await mkdir(staged, { mode: 0o700 });
  await chmod(staged, 0o700);
  if (mode === "hybrid") {
    await ensureSharedArea(paths);
    for (const name of SHARED_ENTRIES) {
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
