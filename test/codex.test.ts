import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertNoCredentialStoreOverride, runCodex } from "../src/codex";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function fixture(): Promise<{ root: string; binary: string; log: string }> {
  const root = await mkdtemp(join(tmpdir(), "cx-codex-")); temporary.push(root);
  const log = join(root, "depth.log");
  const binary = join(root, "codex");
  await writeFile(binary, `#!/usr/bin/env bash\nprintf '%s\\n' "\${CX_SPAWN_DEPTH:-unset}" >> "${log}"\n`);
  await chmod(binary, 0o700);
  return { root, binary, log };
}

describe("codex runner", () => {
  test("marks each spawn with its recursion depth", async () => {
    const { root, binary, log } = await fixture();
    expect(await runCodex(binary, root, [], { quiet: true })).toBe(0);
    expect(await readFile(log, "utf8")).toBe("1\n");
  });

  test("refuses to spawn past the recursion limit", async () => {
    const { root, binary } = await fixture();
    const env = { ...process.env, CX_SPAWN_DEPTH: "8" };
    await expect(runCodex(binary, root, [], { quiet: true, env })).rejects.toThrow("levels deep");
  });

  test("scans only the arguments Codex itself receives", () => {
    const override = 'cli_auth_credentials_store="keyring"';
    expect(() => assertNoCredentialStoreOverride(["-c", override])).toThrow("cannot be overridden");
    expect(() => assertNoCredentialStoreOverride([`--config=${override}`])).toThrow("cannot be overridden");
    // Everything past a separator belongs to a child process, not to Codex.
    expect(() => assertNoCredentialStoreOverride(["exec", "--", "-c", override])).not.toThrow();
  });
});
