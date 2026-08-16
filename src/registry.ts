import { chmod, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { PROFILE_MODES, type ProfileMode, type ProfileRecord, type Registry } from "./types";
import { ensurePrivateDirectory, type AppPaths } from "./paths";
import { validateAlias, validateLabel } from "./validation";

// Profiles are keyed by user-supplied aliases, so the map must not inherit from
// Object.prototype: 'constructor' would otherwise read as an existing account.
export function emptyProfiles(): Registry["profiles"] {
  return Object.create(null) as Registry["profiles"];
}

export function emptyRegistry(): Registry {
  return { version: 1, active: null, codexBinary: null, profiles: emptyProfiles() };
}

export function hasProfile(registry: Registry, alias: string | null | undefined): boolean {
  return typeof alias === "string" && Object.hasOwn(registry.profiles, alias);
}

function parseProfiles(raw: object): Registry["profiles"] {
  const profiles = emptyProfiles();
  for (const alias of Object.keys(raw)) {
    const entry = (raw as Record<string, unknown>)[alias];
    const invalid = (reason: string): never => {
      throw new Error(`profile '${alias}' is invalid (${reason})`);
    };
    if (typeof entry !== "object" || entry === null) invalid("not an object");
    const record = entry as Record<string, unknown>;
    try { validateAlias(alias); } catch (error) { invalid((error as Error).message); }
    if (record.alias !== alias) invalid("alias key and value disagree");
    if (typeof record.mode !== "string" || !PROFILE_MODES.includes(record.mode as ProfileMode)) invalid("unknown mode");
    if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) invalid("unreadable createdAt");
    let label: string | undefined;
    if (record.label !== undefined) {
      if (typeof record.label !== "string") invalid("label is not a string");
      try { label = validateLabel(record.label as string); } catch (error) { invalid((error as Error).message); }
    }
    profiles[alias] = {
      alias,
      ...(label === undefined ? {} : { label }),
      mode: record.mode as ProfileMode,
      createdAt: record.createdAt as string,
    } satisfies ProfileRecord;
  }
  return profiles;
}

export async function readRegistry(paths: AppPaths): Promise<Registry> {
  let raw: string;
  try {
    raw = await readFile(paths.registry, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
    throw new Error(`Cannot read ${basename(paths.registry)}: ${(error as Error).message}`);
  }
  try {
    const value = JSON.parse(raw) as Partial<Registry>;
    if (value.version !== 1 || typeof value.profiles !== "object" || value.profiles === null) {
      throw new Error("unsupported registry structure");
    }
    return {
      version: 1,
      active: typeof value.active === "string" ? value.active : null,
      codexBinary: typeof value.codexBinary === "string" ? value.codexBinary : null,
      profiles: parseProfiles(value.profiles),
    };
  } catch (error) {
    throw new Error(`Cannot read ${basename(paths.registry)}: ${(error as Error).message}`);
  }
}

export async function writeRegistry(paths: AppPaths, registry: Registry): Promise<void> {
  await ensurePrivateDirectory(paths.root);
  const temporary = join(paths.root, `.registry.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, paths.registry);
  } catch (error) {
    try { await Bun.file(temporary).delete(); } catch { /* best effort */ }
    throw error;
  }
}

export async function updateRegistry(
  paths: AppPaths,
  update: (registry: Registry) => Registry | void,
): Promise<Registry> {
  return withRegistryLock(paths, async () => {
    const registry = await readRegistry(paths);
    const result = update(registry) || registry;
    await writeRegistry(paths, result);
    return result;
  });
}

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RECLAIM_GRACE_MS = 250;

// A cx killed with SIGKILL leaves its lock behind. Reclaim it only when the
// recorded owner is provably gone and the file did not change while we checked,
// so a live holder is never stolen from. Returns true when a retry is worthwhile.
export async function reclaimStaleLock(lockPath: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const ownerPid = Number.parseInt(content.split(/\s+/)[0] || "", 10);
  if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
    try {
      process.kill(ownerPid, 0);
      return false;
    } catch (error) {
      // EPERM means the process exists under another user, so it is still alive.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
  }
  await Bun.sleep(LOCK_RECLAIM_GRACE_MS);
  try {
    if (await readFile(lockPath, "utf8") !== content) return false;
    await rm(lockPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return true;
}

export async function withRegistryLock<T>(paths: AppPaths, operation: () => Promise<T>): Promise<T> {
  await ensurePrivateDirectory(paths.root);
  const lockPath = join(paths.root, ".registry.lock");
  const started = Date.now();
  const token = crypto.randomUUID();
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid} ${token}\n`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (await reclaimStaleLock(lockPath)) continue;
    if (Date.now() - started >= LOCK_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for the registry lock '${lockPath}'; another cx process is holding it.`);
    }
    await Bun.sleep(20);
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    try {
      const current = await readFile(lockPath, "utf8");
      if (current.trim().endsWith(token)) await rm(lockPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
