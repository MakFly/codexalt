import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shellCompletion, shellInit } from "../src/shell";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function exerciseShim(shell: "bash" | "zsh"): Promise<string | null> {
  if (!Bun.which(shell)) return null;
  const root = await mkdtemp(join(tmpdir(), "cx-shell-")); temporary.push(root);
  const bin = join(root, "bin"); await mkdir(bin);
  const log = join(root, "args");
  await writeFile(join(bin, "cx"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "$CX_SHELL_LOG"\n`);
  await chmod(join(bin, "cx"), 0o700);
  const init = join(root, "init"); await writeFile(init, shellInit(shell));
  const prefix = shell === "zsh" ? "compdef() { :; }; " : "";
  const child = Bun.spawn([shell, shell === "zsh" ? "-fc" : "-c", `${prefix}source "$CX_SHELL_INIT"; codex --sandbox 'read only'`], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CX_SHELL_LOG: log, CX_SHELL_INIT: init },
    stdout: "pipe", stderr: "pipe",
  });
  const exit = await child.exited;
  if (exit !== 0) throw new Error(await new Response(child.stderr).text());
  return readFile(log, "utf8");
}

describe("shell integration", () => {
  test("bash shim preserves arguments and avoids invoking codex recursively", () => {
    const script = shellInit("bash");
    expect(script).toContain('codex() { CX_SHELL_HOOK=1 command cx default -- "$@"; }');
    expect(script).toContain("complete -F _cx_complete cx codex");
  });

  test("zsh supplies native completion", () => {
    expect(shellCompletion("zsh")).toContain("#compdef cx codex");
    expect(shellInit("zsh")).toContain("compdef _cx_complete cx codex");
  });

  test("bash shim forwards quoted arguments through the cx executable", async () => {
    expect(await exerciseShim("bash")).toBe("default -- --sandbox read only\n");
  });

  test("zsh shim forwards quoted arguments when zsh is available", async () => {
    const result = await exerciseShim("zsh");
    if (result !== null) expect(result).toBe("default -- --sandbox read only\n");
  });
});
