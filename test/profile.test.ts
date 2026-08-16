import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAppPaths } from "../src/paths";
import { createStagedProfile, publishProfile, relinkSharedEntries, removeProfileDirectory } from "../src/profile";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("profiles", () => {
  test("hybrid shares exactly the approved customization entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-profile-")); temporary.push(root);
    const paths = getAppPaths({ CX_DATA_HOME: root });
    const staged = await createStagedProfile(paths, "work", "hybrid");
    expect((await lstat(staged)).mode & 0o777).toBe(0o700);
    expect((await readdir(staged)).sort())
      .toEqual(["AGENTS.md", "CLAUDE.md", "agents", "config.toml", "hooks.json", "rules", "skills"]);
    expect(await readlink(join(staged, "config.toml"))).toBe(join(paths.shared, "config.toml"));
    // A blank hooks.json must still parse, unlike an empty file.
    expect(JSON.parse(await Bun.file(join(paths.shared, "hooks.json")).text())).toEqual({ hooks: {} });
    expect(await Bun.file(join(paths.shared, "config.toml")).text()).toBe("");
  });

  test("relink adds newly shared entries without touching existing ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-profile-")); temporary.push(root);
    const paths = getAppPaths({ CX_DATA_HOME: root });
    const profile = await publishProfile(paths, await createStagedProfile(paths, "work", "hybrid"), "work");
    await rm(join(profile, "hooks.json"));
    await writeFile(join(paths.shared, "config.toml"), "model = \"gpt-5\"\n");

    expect(await relinkSharedEntries(paths, profile)).toEqual(["hooks.json"]);
    expect(await readlink(join(profile, "hooks.json"))).toBe(join(paths.shared, "hooks.json"));
    // Existing links and shared content are left exactly as they were.
    expect(await Bun.file(join(paths.shared, "config.toml")).text()).toBe("model = \"gpt-5\"\n");
    expect(await relinkSharedEntries(paths, profile)).toEqual([]);
  });

  test("relink refuses to replace a real file the user placed in the profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-profile-")); temporary.push(root);
    const paths = getAppPaths({ CX_DATA_HOME: root });
    const profile = await publishProfile(paths, await createStagedProfile(paths, "work", "isolated"), "work");
    await writeFile(join(profile, "config.toml"), "mine", { mode: 0o600 });
    await expect(relinkSharedEntries(paths, profile)).rejects.toThrow("is not a link to the shared area");
    expect(await Bun.file(join(profile, "config.toml")).text()).toBe("mine");
  });

  test("isolated starts empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-profile-")); temporary.push(root);
    const paths = getAppPaths({ CX_DATA_HOME: root });
    const staged = await createStagedProfile(paths, "personal", "isolated");
    expect(await Array.fromAsync(new Bun.Glob("*").scan(staged))).toEqual([]);
  });

  test("removal deletes links without touching shared targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-profile-")); temporary.push(root);
    const paths = getAppPaths({ CX_DATA_HOME: root });
    const staged = await createStagedProfile(paths, "work", "hybrid");
    const profile = await publishProfile(paths, staged, "work");
    await writeFile(join(paths.shared, "AGENTS.md"), "keep");
    await removeProfileDirectory(paths, profile);
    expect(await Bun.file(join(paths.shared, "AGENTS.md")).text()).toBe("keep");
    expect(await Bun.file(profile).exists()).toBeFalse();
  });

  test("rejects symlinked profiles and shared roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-profile-")); temporary.push(root);
    const outside = await mkdtemp(join(tmpdir(), "cx-outside-")); temporary.push(outside);
    await chmod(outside, 0o755);
    const paths = getAppPaths({ CX_DATA_HOME: root });
    await mkdir(paths.root, { recursive: true });
    await symlink(outside, paths.profiles);
    await expect(createStagedProfile(paths, "work", "isolated")).rejects.toThrow("unsafe data directory");
    expect((await lstat(outside)).mode & 0o777).not.toBe(0o700);
    await rm(paths.profiles);
    await mkdir(paths.profiles);
    await symlink(outside, paths.shared);
    await expect(createStagedProfile(paths, "work", "hybrid")).rejects.toThrow("unsafe data directory");
  });

  test("rejects symlinked entries inside the shared area", async () => {
    const root = await mkdtemp(join(tmpdir(), "cx-profile-")); temporary.push(root);
    const outside = await mkdtemp(join(tmpdir(), "cx-outside-")); temporary.push(outside);
    const paths = getAppPaths({ CX_DATA_HOME: root });
    await mkdir(paths.shared, { recursive: true });
    await symlink(join(outside, "config.toml"), join(paths.shared, "config.toml"));
    await expect(createStagedProfile(paths, "work", "hybrid")).rejects.toThrow("Unsafe shared entry");
  });
});
