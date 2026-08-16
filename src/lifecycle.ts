import { chmod, lstat, mkdtemp, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { arch as hostArch, platform as hostPlatform } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { AppPaths } from "./paths";

const DEFAULT_REPOSITORY = "MakFly/codexalt";
const OWNED_DATA_ENTRIES = new Set(["registry.json", "profiles", "shared", ".registry.lock"]);
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

export type Download = (url: string) => Promise<Uint8Array>;

export function releaseArtifact(platform: string = hostPlatform(), architecture: string = hostArch()): string {
  if (platform === "linux" && architecture === "x64") return "cx-linux-x64";
  if (platform === "linux" && (architecture === "arm64" || architecture === "aarch64")) return "cx-linux-arm64";
  throw new Error(`Unsupported platform: ${platform}/${architecture}. CodexAlt targets Linux x64 and arm64 only.`);
}

export function expectedChecksum(manifest: string, filename: string): string {
  const matches = manifest.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((line) => {
    const fields = line.split(/\s+/);
    return fields.length === 2 && fields[1]?.replace(/^\*/, "") === filename;
  });
  if (matches.length !== 1) throw new Error(`Checksum manifest must contain exactly one entry for ${filename}.`);
  const checksum = matches[0]!.split(/\s+/)[0]!;
  if (!/^[a-fA-F0-9]{64}$/.test(checksum)) throw new Error(`Invalid SHA256 checksum for ${filename}.`);
  return checksum.toLowerCase();
}

export function sha256(data: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

async function networkDownload(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}.`);
  return new Uint8Array(await response.arrayBuffer());
}

async function safeInstallTarget(installDirectory: string | undefined, currentExecutable: string): Promise<string> {
  const target = installDirectory ? join(resolve(installDirectory), "cx") : resolve(currentExecutable);
  if (basename(target) !== "cx") {
    throw new Error("Cannot locate an installed cx binary; provide --install-dir with an existing safe directory.");
  }
  const parent = dirname(target);
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) throw new Error(`Unsafe install directory: ${parent}`);
  try {
    const targetMetadata = await lstat(target);
    if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink()) throw new Error(`Unsafe cx target: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!installDirectory) throw new Error(`Installed cx binary does not exist: ${target}`);
  }
  return target;
}

export interface UpgradeOptions {
  installDirectory?: string;
  currentExecutable?: string;
  repository?: string;
  releaseBaseUrl?: string;
  download?: Download;
  platform?: string;
  architecture?: string;
}

export async function upgradeCx(options: UpgradeOptions = {}): Promise<{ target: string; version: string }> {
  const target = await safeInstallTarget(options.installDirectory, options.currentExecutable || process.execPath);
  const artifact = releaseArtifact(options.platform, options.architecture);
  const archiveName = `${artifact}.tar.gz`;
  const repository = options.repository || process.env.CODEXALT_REPOSITORY || DEFAULT_REPOSITORY;
  const base = options.releaseBaseUrl || process.env.CODEXALT_RELEASE_BASE_URL || `https://github.com/${repository}/releases/latest/download`;
  const download = options.download || networkDownload;
  if (!options.download && new URL(base).protocol !== "https:") throw new Error("Release downloads require HTTPS.");
  const [archive, manifestBytes] = await Promise.all([
    download(`${base}/${archiveName}`),
    download(`${base}/SHA256SUMS`),
  ]);
  if (archive.byteLength === 0 || archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Release archive has an unsafe size.");
  if (manifestBytes.byteLength === 0 || manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("Checksum manifest has an unsafe size.");
  const expected = expectedChecksum(new TextDecoder().decode(manifestBytes), archiveName);
  const actual = sha256(archive);
  if (actual !== expected) throw new Error(`Checksum mismatch for ${archiveName}; upgrade aborted.`);

  const temporary = await mkdtemp(join(dirname(target), ".cx-upgrade-"));
  let version = "";
  try {
    const archivePath = join(temporary, archiveName);
    await writeFile(archivePath, archive, { mode: 0o600 });
    const extraction = Bun.spawn(["tar", "-xzf", archivePath, "-C", temporary, "cx"], {
      stdin: "ignore", stdout: "ignore", stderr: "pipe",
    });
    if (await extraction.exited !== 0) throw new Error(`Cannot extract verified release: ${await new Response(extraction.stderr).text()}`);
    const extracted = join(temporary, "cx");
    const metadata = await lstat(extracted);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Release cx entry is not a safe regular file.");
    await chmod(extracted, 0o755);
    const versionProcess = Bun.spawn([extracted, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [versionExit, versionText] = await Promise.all([
      versionProcess.exited,
      new Response(versionProcess.stdout).text(),
    ]);
    if (versionExit !== 0 || !versionText.trim()) throw new Error("The staged cx binary failed its version check; upgrade aborted.");
    version = versionText.trim();
    await rename(extracted, target);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return { target, version };
}

export interface UninstallOptions {
  installDirectory?: string;
  currentExecutable?: string;
  purge?: boolean;
  paths?: AppPaths;
  home?: string;
}

async function validatePurgeRoot(paths: AppPaths, home: string | undefined): Promise<void> {
  if (!home) throw new Error("Refusing purge because HOME is unavailable and ~/.codex cannot be protected.");
  const root = resolve(paths.root);
  const officialCodexRoot = resolve(home, ".codex");
  const forbidden = ["/", resolve(home)];
  if (
    forbidden.includes(root) ||
    basename(root) === ".codex" ||
    root === officialCodexRoot || root.startsWith(`${officialCodexRoot}${sep}`)
  ) throw new Error(`Refusing unsafe purge root: ${root}`);
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Refusing unsafe purge root: ${root}`);
  const entries = await readdir(root);
  const unknown = entries.filter((entry) => !OWNED_DATA_ENTRIES.has(entry));
  if (unknown.length) throw new Error(`Refusing to purge data root containing unknown entries: ${unknown.join(", ")}`);
  const registryPath = join(root, "registry.json");
  const registryMetadata = await lstat(registryPath);
  if (!registryMetadata.isFile() || registryMetadata.isSymbolicLink()) throw new Error("Refusing purge without a safe CodexAlt registry.");
  try {
    const registry = JSON.parse(await Bun.file(registryPath).text()) as { version?: unknown; profiles?: unknown };
    if (registry.version !== 1 || typeof registry.profiles !== "object" || registry.profiles === null) throw new Error("invalid");
  } catch {
    throw new Error("Refusing purge without a valid CodexAlt v1 registry.");
  }
}

export async function uninstallCx(options: UninstallOptions): Promise<{ target: string; purged: boolean }> {
  const current = await realpath(options.currentExecutable || process.execPath);
  const target = await safeInstallTarget(options.installDirectory, current);
  if (await realpath(target) !== current) throw new Error("Refusing to uninstall a cx executable other than the currently running binary.");
  let purgeRootExists = false;
  if (options.purge) {
    if (!options.paths) throw new Error("Internal error: purge paths are required.");
    purgeRootExists = true;
    try {
      await lstat(options.paths.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") purgeRootExists = false;
      else throw error;
    }
    if (purgeRootExists) await validatePurgeRoot(options.paths, options.home);
  }
  await unlink(target);
  if (options.purge && purgeRootExists) await rm(options.paths!.root, { recursive: true, force: false });
  return { target, purged: Boolean(options.purge) };
}
