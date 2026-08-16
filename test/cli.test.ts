import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let root: string;
let fakeCodex: string;
let log: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cx-cli-"));
  fakeCodex = join(root, "real-codex");
  log = join(root, "codex.log");
  await writeFile(fakeCodex, `#!/usr/bin/env bash
set -eu
printf '%s|%s\\n' "$CODEX_HOME" "$*" >> "$FAKE_CODEX_LOG"
if [[ "$*" == *"login status"* && ! -f "$CODEX_HOME/auth.json" ]]; then exit 3; fi
if [[ "$*" == *"login status"* && -f "$CODEX_HOME/auth.json" && "$(cat "$CODEX_HOME/auth.json")" == "expired" ]]; then exit 3; fi
if [[ "$*" == *"login"* && "$*" != *"status"* ]]; then
  printf '%s' 'secret-never-output' > "$CODEX_HOME/auth.json"
  chmod 644 "$CODEX_HOME/auth.json"
fi
exit "\${FAKE_CODEX_EXIT:-0}"
`);
  await chmod(fakeCodex, 0o700);
});

afterEach(async () => rm(root, { recursive: true, force: true }));

async function cx(args: string[], additions: Record<string, string> = {}) {
  const process = Bun.spawn(["bun", "run", join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { ...globalThis.process.env, CX_DATA_HOME: join(root, "data"), CX_CODEX_BIN: fakeCodex, FAKE_CODEX_LOG: log, ...additions },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const [exit, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  return { exit, stdout, stderr };
}

describe("cx CLI", () => {
  test("adds, lists, selects and launches accounts", async () => {
    expect((await cx(["account", "add", "work", "--mode", "hybrid", "--label", "kev@example.com"])).exit).toBe(0);
    expect((await cx(["account", "add", "personal", "--mode", "isolated"])).exit).toBe(0);
    const list = await cx(["account", "list"]);
    expect(list.stdout).toContain("Codex accounts");
    expect(list.stdout).toContain("IDENTITY / LABEL");
    expect(list.stdout).toContain("kev@example.com");
    expect(list.stdout).toContain("personal");
    expect(list.stdout).toContain("Tip: identify a profile");
    expect((await cx(["account", "label", "personal", "Personal Plus"])).stdout).toContain("Personal Plus");
    const labeled = await cx(["account", "list", "--json"]);
    expect(JSON.parse(labeled.stdout).accounts.find((account: { alias: string }) => account.alias === "personal").label).toBe("Personal Plus");
    expect((await cx(["account", "label", "personal", "--clear"])).exit).toBe(0);
    expect((await cx(["account", "add", "duplicate", "--mode", "hybrid", "--mode", "hybrid"])).stderr).toContain("cannot be repeated");
    expect((await cx(["use", "personal"])).stdout).toContain("Active account: personal");
    expect((await cx(["default", "--", "--sandbox", "read-only"])).exit).toBe(0);
    expect((await cx(["work", "--", "--help"])).exit).toBe(0);
    expect((await cx(["work", "--", "exec", "--", "bash", "-lc", "true"])).exit).toBe(0);
    expect((await cx([])).exit).toBe(0);
    const calls = await readFile(log, "utf8");
    expect(calls).toContain('login -c cli_auth_credentials_store="file"');
    expect(calls).toContain('--sandbox read-only -c cli_auth_credentials_store="file"');
    expect(calls).toContain('exec -c cli_auth_credentials_store="file" -- bash -lc true');
    expect(calls).not.toContain("secret-never-output");
    expect((await stat(join(root, "data", "profiles", "work", "auth.json"))).mode & 0o777).toBe(0o600);
  });

  test("failed login leaves no partial profile or registry entry", async () => {
    const result = await cx(["account", "add", "broken", "--mode", "isolated"], { FAKE_CODEX_EXIT: "9" });
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("login failed with exit code 9");
    const profiles = join(root, "data", "profiles");
    expect(await Array.fromAsync(new Bun.Glob("*").scan({ cwd: profiles, dot: true }))).toEqual([]);
  });

  test("supports auth lifecycle and safe confirmed removal", async () => {
    await cx(["account", "add", "work", "--mode", "isolated"]);
    expect((await cx(["account", "status", "work"])).exit).toBe(0);
    expect((await cx(["account", "login", "work", "--device-auth"])).exit).toBe(0);
    expect((await cx(["account", "status", "work", "--bad"])).exit).toBe(1);
    expect((await cx(["account", "logout", "work", "work"])).exit).toBe(1);
    expect((await cx(["account", "logout", "work"])).exit).toBe(0);
    expect((await cx(["account", "remove", "work"])).exit).toBe(1);
    expect((await cx(["account", "remove", "work", "--yes"])).exit).toBe(0);
    expect((await cx(["account", "list"])).stdout).toContain("No accounts");
  });

  test("doctor validates profiles without reading credentials", async () => {
    await cx(["account", "add", "work", "--mode", "hybrid"]);
    const result = await cx(["doctor"]);
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("Credential contents were not inspected");
    expect(result.stdout).not.toContain("secret-never-output");
  });

  test("concurrent switches leave valid atomic JSON", async () => {
    await cx(["account", "add", "one", "--mode", "isolated"]);
    await cx(["account", "add", "two", "--mode", "isolated"]);
    await Promise.all([cx(["use", "one"]), cx(["use", "two"])]);
    const registry = JSON.parse(await readFile(join(root, "data", "registry.json"), "utf8"));
    expect(["one", "two"]).toContain(registry.active);
  });

  test("concurrent account additions preserve both records", async () => {
    const [one, two] = await Promise.all([
      cx(["account", "add", "one", "--mode", "isolated"]),
      cx(["account", "add", "two", "--mode", "isolated"]),
    ]);
    expect(one.exit).toBe(0);
    expect(two.exit).toBe(0);
    const registry = JSON.parse(await readFile(join(root, "data", "registry.json"), "utf8"));
    expect(Object.keys(registry.profiles).sort()).toEqual(["one", "two"]);
  });

  test("doctor reports permissive auth metadata without reading the file", async () => {
    await cx(["account", "add", "work", "--mode", "isolated"]);
    await chmod(join(root, "data", "profiles", "work", "auth.json"), 0o644);
    const result = await cx(["doctor"]);
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("auth.json permissions are 644");
    expect(result.stdout).not.toContain("secret-never-output");
  });

  test("doctor reports permissive registry metadata", async () => {
    await cx(["account", "add", "work", "--mode", "isolated"]);
    await chmod(join(root, "data", "registry.json"), 0o644);
    const result = await cx(["doctor"]);
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("registry permissions are 644");
  });

  test("rejects traversal and reserved aliases", async () => {
    expect((await cx(["account", "add", "../bad", "--mode", "isolated"])).exit).toBe(1);
    expect((await cx(["account", "add", "doctor", "--mode", "isolated"])).exit).toBe(1);
  });

  test("rejects attempts to override the credential store", async () => {
    await cx(["account", "add", "work", "--mode", "isolated"]);
    const result = await cx(["work", "--", "-c", 'cli_auth_credentials_store="keyring"', "doctor"]);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("cannot be overridden");
  });

  test("doctor fails for a missing or expired login", async () => {
    await cx(["account", "add", "work", "--mode", "isolated"]);
    await rm(join(root, "data", "profiles", "work", "auth.json"));
    const result = await cx(["doctor"]);
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("auth.json is missing");
    expect(result.stdout).toContain("login is unavailable or expired");
  });

  test("rejects unsafe persisted labels and aligns wide labels", async () => {
    await cx(["account", "add", "wide", "--mode", "isolated", "--label", "東京"]);
    await cx(["account", "add", "plain", "--mode", "isolated", "--label", "Paris"]);
    const list = await cx(["account", "list"]);
    const accountLines = list.stdout.split("\n").filter((line) => /wide|plain/.test(line));
    const modeColumn = (line: string) => Array.from(line.slice(0, line.indexOf("isolated")))
      .reduce((width, character) => width + (/\p{Script=Han}/u.test(character) ? 2 : 1), 0);
    expect(modeColumn(accountLines[0]!)).toBe(modeColumn(accountLines[1]!));

    const registryPath = join(root, "data", "registry.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    registry.profiles.wide.label = "spoof\u202eright";
    await writeFile(registryPath, `${JSON.stringify(registry)}\n`, { mode: 0o600 });
    // Validation happens when the registry is read, so every command refuses the
    // tampered entry, not just the one that would have displayed it.
    for (const command of [["account", "list"], ["use", "plain"], ["doctor", "--offline"]]) {
      const unsafe = await cx(command);
      expect(unsafe.exit).toBe(1);
      expect(unsafe.stderr).toContain("profile 'wide' is invalid");
      expect(unsafe.stderr).not.toContain("spoof");
    }
  });

  test("strictly rejects invalid lifecycle flags before side effects", async () => {
    const upgrade = await cx(["--upgrade", "--yes"]);
    expect(upgrade.exit).toBe(1);
    expect(upgrade.stderr).toContain("Usage: cx --upgrade");
    const uninstall = await cx(["--uninstall", "--purge", "--purge", "--yes"]);
    expect(uninstall.exit).toBe(1);
    expect(uninstall.stderr).toContain("--purge cannot be repeated");
    const surplus = await cx(["--upgrade", "--install-dir", "/tmp/never-used", "/tmp/never-used"]);
    expect(surplus.exit).toBe(1);
    expect(surplus.stderr).toContain("Unknown lifecycle option");
  });

  test("shell hook falls back to the real Codex CLI before the first account exists", async () => {
    const ambient = join(root, "ambient-home");
    await mkdir(ambient, { recursive: true });
    const fallback = await cx(["default", "--", "--sandbox", "read-only"], { CX_SHELL_HOOK: "1", CODEX_HOME: ambient });
    expect(fallback.exit).toBe(0);
    expect(fallback.stderr).toContain("no CodexAlt account yet");
    // Neither CODEX_HOME nor the credential store is rewritten in this path.
    expect((await readFile(log, "utf8")).trim()).toBe(`${ambient}|--sandbox read-only`);

    await cx(["account", "add", "work", "--mode", "isolated"]);
    const managed = await cx(["default", "--", "--sandbox", "read-only"], { CX_SHELL_HOOK: "1", CODEX_HOME: ambient });
    expect(managed.exit).toBe(0);
    expect(managed.stderr).not.toContain("no CodexAlt account yet");
    const last = (await readFile(log, "utf8")).trim().split("\n").pop();
    expect(last).toBe(`${join(root, "data", "profiles", "work")}|--sandbox read-only -c cli_auth_credentials_store="file"`);
  });

  test("doctor separates expired logins from structural failures", async () => {
    await cx(["account", "add", "work", "--mode", "isolated"]);
    await writeFile(join(root, "data", "profiles", "work", "auth.json"), "expired", { mode: 0o600 });
    const online = await cx(["doctor"]);
    expect(online.exit).toBe(0);
    expect(online.stdout).toContain("WARN work: Codex reports");
    const offline = await cx(["doctor", "--offline"]);
    expect(offline.exit).toBe(0);
    expect(offline.stdout).toContain("login checks skipped");
    expect(offline.stdout).not.toContain("WARN work");
    expect((await cx(["doctor", "--offline", "--offline"])).exit).toBe(1);
  });

  test("doctor reports accounts left in the pre-rename directory", async () => {
    const home = join(root, "home");
    await mkdir(join(home, ".local", "share", "codexplusplus", "profiles", "old"), { recursive: true });
    const child = Bun.spawn(["bun", "run", join(import.meta.dir, "../src/cli.ts"), "doctor", "--offline"], {
      env: { PATH: globalThis.process.env.PATH!, HOME: home, CX_CODEX_BIN: fakeCodex, FAKE_CODEX_LOG: log },
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(exit).toBe(0);
    expect(stdout).toContain("pre-rename directory");
  });

  test("parses add options positionally", async () => {
    const stray = await cx(["account", "add", "work", "--mode", "isolated", "isolated"]);
    expect(stray.exit).toBe(1);
    expect(stray.stderr).toContain("Unknown option 'isolated'");
    expect((await cx(["account", "add", "work", "--mode", "isolated", "--label", "--team--"])).exit).toBe(0);
    const list = await cx(["account", "list", "--json"]);
    expect(JSON.parse(list.stdout).accounts[0].label).toBe("--team--");
  });

  test("treats Object.prototype keys as ordinary aliases", async () => {
    expect((await cx(["account", "add", "constructor", "--mode", "isolated"])).exit).toBe(0);
    const list = await cx(["account", "list", "--json"]);
    expect(JSON.parse(list.stdout).accounts.map((account: { alias: string }) => account.alias)).toEqual(["constructor"]);
    expect((await cx(["use", "constructor"])).exit).toBe(0);
    expect((await cx(["run", "constructor", "--", "--help"])).exit).toBe(0);
  });

  test("leaves child arguments after a separator untouched", async () => {
    await cx(["account", "add", "work", "--mode", "isolated"]);
    const result = await cx(["work", "--", "exec", "--", "-c", 'cli_auth_credentials_store="keyring"']);
    expect(result.exit).toBe(0);
    const last = (await readFile(log, "utf8")).trim().split("\n").pop();
    expect(last).toContain('exec -c cli_auth_credentials_store="file" -- -c cli_auth_credentials_store="keyring"');
  });
});
