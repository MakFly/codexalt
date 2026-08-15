import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const temporary: string[] = [];
const installer = join(import.meta.dir, "../install.sh");
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function run(args: string[], installDirectory?: string) {
  const child = Bun.spawn(["sh", installer, ...args], {
    env: { ...process.env, ...(installDirectory ? { CODEXPLUS_INSTALL_DIR: installDirectory } : {}) },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit, stdout, stderr };
}

describe("install script validation", () => {
  test("offers offline help and rejects extra actions", async () => {
    expect((await run(["--help"])).stdout).toContain("install|upgrade");
    const extra = await run(["install", "extra"]);
    expect(extra.exit).toBe(1);
    expect(extra.stderr).toContain("Usage:");
  });

  test("rejects a directory at the cx target before downloading", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-installer-")); temporary.push(root);
    await mkdir(join(root, "cx"));
    const result = await run(["install"], root);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("Refusing non-file cx target");
  });

  test("rejects upgrade when cx is absent before downloading", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-installer-")); temporary.push(root);
    const result = await run(["upgrade"], root);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("is not installed");
  });
});
