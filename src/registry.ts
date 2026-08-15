import { chmod, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { EMPTY_REGISTRY, type Registry } from "./types";
import { ensurePrivateDirectory, type AppPaths } from "./paths";

export async function readRegistry(paths: AppPaths): Promise<Registry> {
  try {
    const raw = await readFile(paths.registry, "utf8");
    const value = JSON.parse(raw) as Partial<Registry>;
    if (value.version !== 1 || typeof value.profiles !== "object" || value.profiles === null) {
      throw new Error("unsupported registry structure");
    }
    return {
      version: 1,
      active: typeof value.active === "string" ? value.active : null,
      codexBinary: typeof value.codexBinary === "string" ? value.codexBinary : null,
      profiles: value.profiles as Registry["profiles"],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_REGISTRY);
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const content = await readFile(lockPath, "utf8");
        const ownerPid = Number.parseInt(content.split(/\s+/)[0] || "", 10);
        let ownerAlive = Number.isSafeInteger(ownerPid) && ownerPid > 0;
        if (ownerAlive) {
          try { process.kill(ownerPid, 0); } catch (killError) {
            if ((killError as NodeJS.ErrnoException).code === "ESRCH") ownerAlive = false;
          }
        }
        if (!ownerAlive && Number.isSafeInteger(ownerPid) && ownerPid > 0) {
          throw new Error(`Registry lock is stale (owner PID ${ownerPid}). Remove '${lockPath}' only after confirming no cx process is running.`);
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new Error("Timed out waiting for the registry lock.");
      await Bun.sleep(20);
    }
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
