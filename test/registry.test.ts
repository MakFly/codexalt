import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAppPaths } from "../src/paths";
import { readRegistry, updateRegistry, writeRegistry } from "../src/registry";
import { EMPTY_REGISTRY } from "../src/types";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("registry", () => {
  test("writes a private registry atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-registry-")); temporary.push(root);
    const paths = getAppPaths({ CX_DATA_HOME: root });
    await writeRegistry(paths, structuredClone(EMPTY_REGISTRY));
    expect((await stat(paths.root)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.registry)).mode & 0o777).toBe(0o600);
    expect(await readRegistry(paths)).toEqual(EMPTY_REGISTRY);
    expect((await readFile(paths.registry, "utf8")).endsWith("\n")).toBeTrue();
  });

  test("fails closed on corrupt state", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-registry-")); temporary.push(root);
    const paths = getAppPaths({ CX_DATA_HOME: root });
    await Bun.write(paths.registry, "not-json");
    await expect(readRegistry(paths)).rejects.toThrow("Cannot read registry.json");
  });

  test("refuses a symlinked data root without changing its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-registry-")); temporary.push(root);
    const target = join(root, "target"); await mkdir(target, { mode: 0o755 });
    const linkedRoot = join(root, "linked"); await symlink(target, linkedRoot);
    const paths = getAppPaths({ CX_DATA_HOME: linkedRoot });
    await expect(writeRegistry(paths, structuredClone(EMPTY_REGISTRY))).rejects.toThrow("unsafe data directory");
    expect((await stat(target)).mode & 0o777).toBe(0o755);
  });

  test("fails closed for a lock owned by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-registry-")); temporary.push(root);
    const paths = getAppPaths({ CX_DATA_HOME: root });
    await writeRegistry(paths, structuredClone(EMPTY_REGISTRY));
    await writeFile(join(root, ".registry.lock"), "999999999 stale-token\n", { mode: 0o600 });
    const attempts = await Promise.allSettled([
      updateRegistry(paths, (registry) => { registry.active = "one"; }),
      updateRegistry(paths, (registry) => { registry.active = "two"; }),
    ]);
    expect(attempts.every((attempt) => attempt.status === "rejected")).toBeTrue();
    expect(await Bun.file(join(root, ".registry.lock")).text()).toContain("stale-token");
    expect((await readRegistry(paths)).active).toBeNull();
  });
});
