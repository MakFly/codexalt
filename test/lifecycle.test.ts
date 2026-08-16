import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expectedChecksum, releaseArtifact, sha256, uninstallCx, upgradeCx, type Download } from "../src/lifecycle";
import { getAppPaths } from "../src/paths";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function releaseFixture(version = "0.3.0", exitCode = 0) {
  const root = await mkdtemp(join(tmpdir(), "cx-release-")); temporary.push(root);
  const payload = join(root, "payload"); await mkdir(payload);
  const executable = join(payload, "cx");
  await writeFile(executable, `#!/usr/bin/env sh\nprintf '%s\\n' '${version}'\nexit ${exitCode}\n`, { mode: 0o755 });
  await chmod(executable, 0o755);
  const artifact = "cx-linux-x64";
  const archive = join(root, `${artifact}.tar.gz`);
  const tar = Bun.spawn(["tar", "-czf", archive, "-C", payload, "cx"], { stdout: "ignore", stderr: "pipe" });
  if (await tar.exited !== 0) throw new Error(await new Response(tar.stderr).text());
  const archiveBytes = new Uint8Array(await Bun.file(archive).arrayBuffer());
  const manifest = new TextEncoder().encode(`${sha256(archiveBytes)}  ${artifact}.tar.gz\n`);
  const download: Download = async (url) => url.endsWith("SHA256SUMS") ? manifest : archiveBytes;
  return { archiveBytes, artifact, download };
}

describe("release lifecycle", () => {
  test.each([
    ["linux", "x64", "cx-linux-x64"],
    ["linux", "arm64", "cx-linux-arm64"],
    ["darwin", "x64", "cx-macos-x64"],
    ["darwin", "arm64", "cx-macos-arm64"],
  ])("maps %s/%s to %s", (platform, architecture, artifact) => {
    expect(releaseArtifact(platform, architecture)).toBe(artifact);
  });

  test("fails closed for unsupported platforms and ambiguous manifests", () => {
    expect(() => releaseArtifact("win32", "x64")).toThrow("Unsupported platform");
    const checksum = "a".repeat(64);
    expect(() => expectedChecksum(`${checksum}  a.tar.gz\n${checksum}  a.tar.gz\n`, "a.tar.gz"))
      .toThrow("exactly one entry");
  });

  test("downloads, verifies and atomically upgrades an explicit installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-install-")); temporary.push(root);
    const target = join(root, "cx"); await writeFile(target, "old", { mode: 0o755 });
    const fixture = await releaseFixture("0.3.0-test");
    const result = await upgradeCx({
      installDirectory: root,
      currentExecutable: target,
      platform: "linux",
      architecture: "x64",
      releaseBaseUrl: "https://fixture.invalid",
      download: fixture.download,
    });
    expect(result).toEqual({ target, version: "0.3.0-test" });
    expect(await Bun.file(target).text()).toContain("0.3.0-test");
  });

  test("leaves the installed binary untouched on checksum mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-install-")); temporary.push(root);
    const target = join(root, "cx"); await writeFile(target, "old", { mode: 0o755 });
    const fixture = await releaseFixture();
    const corruptDownload: Download = async (url) => url.endsWith("SHA256SUMS")
      ? new TextEncoder().encode(`${"0".repeat(64)}  ${fixture.artifact}.tar.gz\n`)
      : fixture.archiveBytes;
    await expect(upgradeCx({
      installDirectory: root,
      currentExecutable: target,
      platform: "linux",
      architecture: "x64",
      download: corruptDownload,
    })).rejects.toThrow("Checksum mismatch");
    expect(await readFile(target, "utf8")).toBe("old");
  });

  test("leaves the installed binary untouched when the staged version smoke fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-install-")); temporary.push(root);
    const target = join(root, "cx"); await writeFile(target, "old", { mode: 0o755 });
    const fixture = await releaseFixture("broken", 4);
    await expect(upgradeCx({
      installDirectory: root,
      currentExecutable: target,
      platform: "linux",
      architecture: "x64",
      download: fixture.download,
    })).rejects.toThrow("staged cx binary failed");
    expect(await readFile(target, "utf8")).toBe("old");
  });

  test("uninstalls only the running executable and preserves state by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-uninstall-")); temporary.push(root);
    const bin = join(root, "bin"); await mkdir(bin);
    const target = join(bin, "cx"); await writeFile(target, "binary", { mode: 0o755 });
    const data = join(root, "data"); await mkdir(data); await writeFile(join(data, "registry.json"), "{}");
    const result = await uninstallCx({ currentExecutable: target, paths: getAppPaths({ CX_DATA_HOME: data }) });
    expect(result.purged).toBeFalse();
    expect(await Bun.file(target).exists()).toBeFalse();
    expect(await Bun.file(join(data, "registry.json")).exists()).toBeTrue();
  });

  test("purges only recognized CodexAlt state after validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-uninstall-")); temporary.push(root);
    const target = join(root, "cx"); await writeFile(target, "binary", { mode: 0o755 });
    const data = join(root, "codexalt"); await mkdir(data);
    await writeFile(join(data, "registry.json"), '{"version":1,"active":null,"codexBinary":null,"profiles":{}}');
    await mkdir(join(data, "profiles"));
    const result = await uninstallCx({
      currentExecutable: target,
      purge: true,
      paths: getAppPaths({ CX_DATA_HOME: data }),
      home: join(root, "home"),
    });
    expect(result.purged).toBeTrue();
    expect(await Bun.file(data).exists()).toBeFalse();
    expect(await Bun.file(target).exists()).toBeFalse();
  });

  test("refuses mismatched executable and unknown purge content", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-uninstall-")); temporary.push(root);
    const bin = join(root, "bin"); await mkdir(bin);
    const current = join(bin, "cx"); await writeFile(current, "current", { mode: 0o755 });
    const otherDir = join(root, "other"); await mkdir(otherDir);
    const other = join(otherDir, "cx"); await writeFile(other, "other", { mode: 0o755 });
    await expect(uninstallCx({ currentExecutable: current, installDirectory: otherDir }))
      .rejects.toThrow("other than the currently running binary");
    const data = join(root, "data"); await mkdir(data); await writeFile(join(data, "personal.txt"), "keep");
    await expect(uninstallCx({
      currentExecutable: current,
      purge: true,
      paths: getAppPaths({ CX_DATA_HOME: data }),
      home: join(root, "home"),
    })).rejects.toThrow("unknown entries");
    expect(await Bun.file(current).exists()).toBeTrue();
    expect(await Bun.file(join(data, "personal.txt")).exists()).toBeTrue();
  });

  test("does not purge when executable unlink fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-uninstall-")); temporary.push(root);
    const bin = join(root, "bin"); await mkdir(bin);
    const current = join(bin, "cx"); await writeFile(current, "current", { mode: 0o755 });
    const data = join(root, "data"); await mkdir(data);
    await writeFile(join(data, "registry.json"), '{"version":1,"profiles":{}}');
    await chmod(bin, 0o500);
    try {
      await expect(uninstallCx({
        currentExecutable: current,
        purge: true,
        paths: getAppPaths({ CX_DATA_HOME: data }),
        home: join(root, "home"),
      })).rejects.toThrow();
      expect(await Bun.file(current).exists()).toBeTrue();
      expect(await Bun.file(join(data, "registry.json")).exists()).toBeTrue();
    } finally {
      await chmod(bin, 0o700);
    }
  });

  test("refuses purge without ownership evidence and never accepts a .codex root", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-uninstall-")); temporary.push(root);
    const current = join(root, "cx"); await writeFile(current, "current", { mode: 0o755 });
    const emptyData = join(root, "empty"); await mkdir(emptyData);
    await expect(uninstallCx({
      currentExecutable: current,
      purge: true,
      paths: getAppPaths({ CX_DATA_HOME: emptyData }),
      home: join(root, "home"),
    })).rejects.toThrow("registry");
    const home = join(root, "home"); const codex = join(home, ".codex"); await mkdir(codex, { recursive: true });
    await writeFile(join(codex, "registry.json"), '{"version":1,"profiles":{}}');
    await expect(uninstallCx({
      currentExecutable: current,
      purge: true,
      paths: getAppPaths({ CX_DATA_HOME: codex }),
      home,
    })).rejects.toThrow("unsafe purge root");
    const nested = join(codex, "codexalt"); await mkdir(nested);
    await writeFile(join(nested, "registry.json"), '{"version":1,"profiles":{}}');
    await expect(uninstallCx({
      currentExecutable: current,
      purge: true,
      paths: getAppPaths({ CX_DATA_HOME: nested }),
      home,
    })).rejects.toThrow("unsafe purge root");
    expect(await Bun.file(current).exists()).toBeTrue();
  });

  test("fails closed when HOME is unavailable during purge", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-uninstall-")); temporary.push(root);
    const current = join(root, "cx"); await writeFile(current, "current", { mode: 0o755 });
    const data = join(root, "fake-home", ".codex", "codexalt"); await mkdir(data, { recursive: true });
    await writeFile(join(data, "registry.json"), '{"version":1,"profiles":{}}');
    await expect(uninstallCx({
      currentExecutable: current,
      purge: true,
      paths: getAppPaths({ CX_DATA_HOME: data }),
      home: undefined,
    })).rejects.toThrow("HOME is unavailable");
    expect(await Bun.file(current).exists()).toBeTrue();
    expect(await Bun.file(join(data, "registry.json")).exists()).toBeTrue();
  });
});
