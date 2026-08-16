#!/usr/bin/env bun
import { lstat, readdir, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveCodexBinary, runCodex, runCodexPassthrough, secureAuthFile } from "./codex";
import { assertSafeProfileDirectory, getAppPaths, legacyDataRoots } from "./paths";
import {
  createStagedProfile, discardStagedProfile, publishProfile, relinkSharedEntries, removeProfileDirectory,
  SHARED_ENTRIES, SHARED_FILE_NAMES,
} from "./profile";
import { hasProfile, readRegistry, updateRegistry, withRegistryLock, writeRegistry } from "./registry";
import { requireShell, shellCompletion, shellInit } from "./shell";
import { PROFILE_MODES, type ProfileMode, type Registry } from "./types";
import { validateAlias, validateLabel } from "./validation";
import { uninstallCx, upgradeCx } from "./lifecycle";

export const VERSION = "0.4.0";
const paths = getAppPaths();

function output(message = ""): void { process.stdout.write(`${message}\n`); }
function fail(message: string): never { throw new Error(message); }
function withoutSeparator(args: string[]): string[] { return args[0] === "--" ? args.slice(1) : args; }

function usage(): string {
  return `CodexAlt ${VERSION}

Usage:
  cx account add <alias> --mode hybrid|isolated [--label <identity>] [--device-auth]
  cx account list [--json]
  cx account label <alias> <identity>|--clear
  cx account status|login|logout|remove <alias>
  cx account repair [alias]
  cx use <alias>
  cx run [alias] [-- <codex arguments>]
  cx default [-- <codex arguments>]
  cx <alias> [-- <codex arguments>]
  cx doctor [--offline]
  cx --upgrade [--install-dir <directory>]
  cx --uninstall [--install-dir <directory>] [--purge] [--yes]
  cx shell init bash|zsh
  cx completion bash|zsh`;
}

interface LifecycleArguments { installDirectory?: string; purge: boolean; yes: boolean }

function parseLifecycleArguments(args: string[]): LifecycleArguments {
  const parsed: LifecycleArguments = { purge: false, yes: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--install-dir") {
      if (parsed.installDirectory !== undefined) fail("--install-dir cannot be repeated.");
      const value = args[index + 1];
      if (!value || value.startsWith("--")) fail("Missing value for --install-dir.");
      parsed.installDirectory = value;
      index += 1;
    } else if (argument === "--purge") {
      if (parsed.purge) fail("--purge cannot be repeated.");
      parsed.purge = true;
    } else if (argument === "--yes") {
      if (parsed.yes) fail("--yes cannot be repeated.");
      parsed.yes = true;
    } else {
      fail(`Unknown lifecycle option '${argument}'.`);
    }
  }
  return parsed;
}

async function upgradeCommand(args: string[]): Promise<number> {
  const parsed = parseLifecycleArguments(args);
  if (parsed.purge || parsed.yes) fail("Usage: cx --upgrade [--install-dir <directory>]");
  const result = await upgradeCx({ installDirectory: parsed.installDirectory });
  output(`Upgraded cx ${VERSION} -> ${result.version} at ${result.target}`);
  return 0;
}

async function uninstallCommand(args: string[]): Promise<number> {
  const parsed = parseLifecycleArguments(args);
  if (parsed.yes && !parsed.purge) fail("--yes is only valid with --purge.");
  if (parsed.purge && !parsed.yes) {
    if (!process.stdin.isTTY) fail("Refusing non-interactive purge without --yes.");
    if (prompt(`Permanently remove CodexAlt data at '${paths.root}'? Type PURGE to confirm: `) !== "PURGE") {
      fail("Uninstall cancelled.");
    }
  }
  const result = await uninstallCx({
    installDirectory: parsed.installDirectory,
    purge: parsed.purge,
    paths,
    home: process.env.HOME,
  });
  output(`Removed ${result.target}.`);
  output(result.purged ? `Purged CodexAlt data at ${paths.root}.` : `Preserved CodexAlt account data at ${paths.root}.`);
  return 0;
}

function requireProfile(registry: Registry, alias: string | null | undefined): string {
  if (!alias) fail("No account selected. Run 'cx use <alias>' or provide an alias.");
  validateAlias(alias);
  if (!hasProfile(registry, alias)) fail(`Unknown account '${alias}'.`);
  return alias;
}

async function selectedCodex(registry: Registry): Promise<string> {
  const binary = await resolveCodexBinary(registry);
  if (registry.codexBinary !== binary) {
    await updateRegistry(paths, (current) => { current.codexBinary = binary; });
    registry.codexBinary = binary;
  }
  return binary;
}

async function launch(alias: string, codexArgs: string[]): Promise<number> {
  const registry = await readRegistry(paths);
  const selected = requireProfile(registry, alias);
  const home = await assertSafeProfileDirectory(paths, selected);
  const binary = await selectedCodex(registry);
  return runCodex(binary, home, codexArgs);
}

interface AddArguments { mode?: ProfileMode; label?: string; deviceAuth: boolean }

// Positional parsing, so an option value is always taken literally. A label may
// legitimately start with '--', and a stray argument that happens to equal the
// mode or the label must still be rejected.
function parseAddArguments(args: string[]): AddArguments {
  const parsed: AddArguments = { deviceAuth: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--mode") {
      if (parsed.mode !== undefined) fail("Option '--mode' cannot be repeated.");
      const value = args[index + 1];
      if (value === undefined) fail("Missing value for --mode.");
      if (!PROFILE_MODES.includes(value as ProfileMode)) fail("Choose --mode hybrid or --mode isolated.");
      parsed.mode = value as ProfileMode;
      index += 1;
    } else if (argument === "--label") {
      if (parsed.label !== undefined) fail("Option '--label' cannot be repeated.");
      const value = args[index + 1];
      if (value === undefined) fail("Missing value for --label.");
      parsed.label = value;
      index += 1;
    } else if (argument === "--device-auth") {
      if (parsed.deviceAuth) fail("Option '--device-auth' cannot be repeated.");
      parsed.deviceAuth = true;
    } else {
      fail(`Unknown option '${argument}'.`);
    }
  }
  return parsed;
}

async function accountAdd(args: string[]): Promise<number> {
  const alias = validateAlias(args[0] || fail("Missing account alias."));
  const parsed = parseAddArguments(args.slice(1));
  const registry = await readRegistry(paths);
  if (hasProfile(registry, alias)) fail(`Account '${alias}' already exists.`);
  let mode = parsed.mode;
  if (!mode && process.stdin.isTTY) {
    const answer = prompt("Profile mode (hybrid/isolated): ")?.trim();
    mode = answer as ProfileMode | undefined;
  }
  if (!mode || !PROFILE_MODES.includes(mode)) fail("Choose --mode hybrid or --mode isolated.");
  let label = parsed.label;
  if (label === undefined && process.stdin.isTTY) label = prompt("Account label (email/workspace, optional): ")?.trim() || undefined;
  const normalizedLabel = label ? validateLabel(label) : undefined;

  const binary = await resolveCodexBinary(registry);
  const staged = await createStagedProfile(paths, alias, mode);
  try {
    const loginArgs = ["login", ...(parsed.deviceAuth ? ["--device-auth"] : [])];
    const loginExit = await runCodex(binary, staged, loginArgs);
    if (loginExit !== 0) fail(`Codex login failed with exit code ${loginExit}.`);
    if (!await secureAuthFile(staged)) fail("Codex login succeeded but auth.json was not created.");
    const statusExit = await runCodex(binary, staged, ["login", "status"], { quiet: true });
    if (statusExit !== 0) fail("Codex did not confirm the new login.");
    const madeActive = await withRegistryLock(paths, async () => {
      const current = await readRegistry(paths);
      if (hasProfile(current, alias)) fail(`Account '${alias}' was added concurrently.`);
      await publishProfile(paths, staged, alias);
      current.codexBinary = binary;
      current.profiles[alias] = { alias, label: normalizedLabel, mode, createdAt: new Date().toISOString() };
      const activate = current.active === null;
      current.active ||= alias;
      try {
        await writeRegistry(paths, current);
      } catch (error) {
        await removeProfileDirectory(paths, profilePathForPublished(alias));
        throw error;
      }
      return activate;
    });
    output(`Added '${alias}' (${mode})${madeActive ? " and made it active" : ""}.`);
    return 0;
  } catch (error) {
    await discardStagedProfile(paths, staged);
    throw error;
  }
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeWidth(grapheme: string): number {
  if (/^\p{Mark}+$/u.test(grapheme)) return 0;
  if (/\p{Extended_Pictographic}/u.test(grapheme)) return 2;
  const point = grapheme.codePointAt(0) || 0;
  return (
    (point >= 0x1100 && point <= 0x115f) ||
    (point >= 0x2e80 && point <= 0xa4cf) ||
    (point >= 0xac00 && point <= 0xd7a3) ||
    (point >= 0xf900 && point <= 0xfaff) ||
    (point >= 0xfe10 && point <= 0xfe6f) ||
    (point >= 0xff00 && point <= 0xff60) ||
    (point >= 0xffe0 && point <= 0xffe6) ||
    (point >= 0x20000 && point <= 0x3fffd)
  ) ? 2 : 1;
}

function displayWidth(value: string): number {
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => graphemeWidth(segment))
    .reduce((total, width) => total + width, 0);
}

function truncate(value: string, maximum: number): string {
  if (displayWidth(value) <= maximum) return value;
  let result = "";
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(value)) {
    const next = graphemeWidth(segment);
    if (width + next > maximum - 1) break;
    result += segment;
    width += next;
  }
  return `${result}…`;
}

function pad(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - displayWidth(value)))}`;
}

async function accountList(args: string[]): Promise<number> {
  if (args.some((arg) => arg !== "--json") || args.filter((arg) => arg === "--json").length > 1) {
    fail("Usage: cx account list [--json]");
  }
  const registry = await readRegistry(paths);
  const aliases = Object.keys(registry.profiles).sort();
  if (aliases.length === 0) { output("No accounts configured."); return 0; }
  // Labels were validated when the registry was read.
  const accounts = aliases.map((alias) => {
    const profile = registry.profiles[alias]!;
    return {
      alias,
      label: profile.label ?? null,
      mode: profile.mode,
      active: registry.active === alias,
      createdAt: profile.createdAt,
    };
  });
  if (args.includes("--json")) {
    output(JSON.stringify({ active: registry.active, accounts }, null, 2));
    return 0;
  }
  const rows = accounts.map((account) => [
    account.active ? "yes" : "",
    account.alias,
    truncate(account.label || "—", 40),
    account.mode,
  ]);
  const headers = ["CURRENT", "ALIAS", "IDENTITY / LABEL", "MODE"];
  const widths = headers.map((header, index) => Math.max(
    displayWidth(header),
    ...rows.map((row) => displayWidth(row[index]!)),
  ));
  output("Codex accounts\n");
  output(`  ${headers.map((header, index) => pad(header, widths[index]!)).join("  ")}`);
  for (const row of rows) output(`  ${row.map((value, index) => pad(value, widths[index]!)).join("  ")}`);
  if (accounts.some((account) => !account.label)) {
    output('\nTip: identify a profile with `cx account label <alias> "email or workspace"`.');
  }
  return 0;
}

async function accountLabel(args: string[]): Promise<number> {
  const alias = validateAlias(args[0] || fail("Missing account alias."));
  const clear = args[1] === "--clear";
  if (args.length !== 2) fail("Usage: cx account label <alias> <identity>|--clear");
  const label = clear ? undefined : validateLabel(args[1]!);
  await updateRegistry(paths, (registry) => {
    requireProfile(registry, alias);
    if (label) registry.profiles[alias]!.label = label;
    else delete registry.profiles[alias]!.label;
  });
  output(clear ? `Cleared label for '${alias}'.` : `Label for '${alias}': ${label}`);
  return 0;
}

// The label is metadata the user supplied at 'account add' time, not something
// read back from the credential file.
function describeAccount(registry: Registry, alias: string): string {
  const label = registry.profiles[alias]?.label;
  const active = registry.active === alias ? "" : " (not the active account)";
  if (!label) return `Account: ${alias}${active}. No label set; add one with 'cx account label ${alias} <identity>'.`;
  return `Account: ${alias} <${label}>${active}`;
}

async function accountAuth(action: "status" | "login" | "logout", args: string[]): Promise<number> {
  const registry = await readRegistry(paths);
  const aliases = args.filter((arg) => !arg.startsWith("--"));
  if (aliases.length > 1) fail(`Too many account aliases for account ${action}.`);
  const aliasArg = aliases[0];
  const options = args.filter((arg) => arg.startsWith("--"));
  if (action !== "login" && options.length > 0) fail(`Unknown option '${options[0]}' for account ${action}.`);
  if (action === "login" && (options.some((arg) => arg !== "--device-auth") || options.length > 1)) {
    fail(`Unknown or repeated option for account ${action}.`);
  }
  const alias = requireProfile(registry, aliasArg || registry.active);
  const home = await assertSafeProfileDirectory(paths, alias);
  const binary = await selectedCodex(registry);
  const codexArgs = action === "status"
    ? ["login", "status"]
    : [action, ...(action === "login" && args.includes("--device-auth") ? ["--device-auth"] : [])];
  // Codex reports how you are authenticated, never as whom, and the identity
  // lives in auth.json which CodexAlt does not read. Name the profile first so
  // the answer below is attributable to an account.
  output(describeAccount(registry, alias));
  const exit = await runCodex(binary, home, codexArgs);
  if (exit === 0 && action === "login" && !await secureAuthFile(home)) fail("Codex login succeeded but auth.json was not created.");
  return exit;
}

async function accountRepair(args: string[]): Promise<number> {
  const aliases = args.filter((argument) => !argument.startsWith("--"));
  if (args.length !== aliases.length) fail("Usage: cx account repair [alias]");
  if (aliases.length > 1) fail("Too many account aliases for account repair.");
  const registry = await readRegistry(paths);
  const targets = aliases.length ? [requireProfile(registry, aliases[0])] : Object.keys(registry.profiles).sort();
  if (!targets.length) { output("No accounts configured."); return 0; }
  for (const alias of targets) {
    const profile = registry.profiles[alias]!;
    if (profile.mode !== "hybrid") { output(`${alias}: isolated, nothing shared to link.`); continue; }
    const home = await assertSafeProfileDirectory(paths, alias);
    const added = await relinkSharedEntries(paths, home);
    output(added.length ? `${alias}: linked ${added.join(", ")}.` : `${alias}: already complete.`);
  }
  return 0;
}

function profilePathForPublished(alias: string): string {
  return join(paths.profiles, alias);
}

async function accountRemove(args: string[]): Promise<number> {
  const alias = validateAlias(args[0] || fail("Missing account alias."));
  const registry = await readRegistry(paths);
  requireProfile(registry, alias);
  if (args.some((arg) => arg !== alias && arg !== "--yes")) fail("Only --yes is supported for account remove.");
  if (!args.includes("--yes")) {
    if (!process.stdin.isTTY) fail("Refusing non-interactive removal without --yes.");
    if (prompt(`Remove '${alias}' and its local credentials? Type the alias to confirm: `) !== alias) {
      fail("Removal cancelled.");
    }
  }
  const home = await assertSafeProfileDirectory(paths, alias);
  const binary = await selectedCodex(registry);
  const logoutExit = await runCodex(binary, home, ["logout"]);
  if (logoutExit !== 0) fail(`Codex logout failed with exit code ${logoutExit}; profile was preserved.`);
  await withRegistryLock(paths, async () => {
    const current = await readRegistry(paths);
    requireProfile(current, alias);
    await removeProfileDirectory(paths, home);
    delete current.profiles[alias];
    if (current.active === alias) current.active = Object.keys(current.profiles).sort()[0] || null;
    await writeRegistry(paths, current);
  });
  output(`Removed '${alias}'.`);
  return 0;
}

async function useAccount(aliasArg: string | undefined): Promise<number> {
  const registry = await readRegistry(paths);
  const alias = requireProfile(registry, aliasArg);
  await assertSafeProfileDirectory(paths, alias);
  await updateRegistry(paths, (current) => {
    requireProfile(current, alias);
    current.active = alias;
  });
  output(`Active account: ${alias}`);
  return 0;
}

async function doctor(args: string[]): Promise<number> {
  if (args.some((argument) => argument !== "--offline") || args.filter((argument) => argument === "--offline").length > 1) {
    fail("Usage: cx doctor [--offline]");
  }
  const offline = args.includes("--offline");
  const registry = await readRegistry(paths);
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const legacy of legacyDataRoots()) {
    try {
      const entries = await readdir(join(legacy, "profiles"));
      if (entries.length) {
        warnings.push(`${entries.length} account(s) remain in the pre-rename directory '${legacy}'. Move it with: mv '${legacy}' '${paths.root}'`);
      }
    } catch { /* no legacy state to report */ }
  }
  let binary: string | null = null;
  try { binary = await resolveCodexBinary(registry); } catch (error) { problems.push((error as Error).message); }
  for (const [path, expected, label] of [
    [paths.root, 0o700, "data directory"],
    [paths.registry, 0o600, "registry"],
  ] as const) {
    try {
      const metadata = await lstat(path);
      if ((metadata.mode & 0o777) !== expected) {
        problems.push(`${label} permissions are ${(metadata.mode & 0o777).toString(8)}, expected ${expected.toString(8)}.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`cannot inspect ${label} metadata.`);
    }
  }
  const hasHybrid = Object.values(registry.profiles).some((profile) => profile.mode === "hybrid");
  if (hasHybrid) {
    try {
      const shared = await lstat(paths.shared);
      if (!shared.isDirectory() || shared.isSymbolicLink() || (shared.mode & 0o777) !== 0o700) {
        problems.push("shared directory must be a real directory with permissions 700.");
      }
      for (const name of SHARED_FILE_NAMES) {
        try {
          const metadata = await lstat(join(paths.shared, name));
          if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
            problems.push(`shared ${name} must be a regular file with permissions 600.`);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          warnings.push(`shared ${name} is missing. Run 'cx account repair' to create it.`);
        }
      }
    } catch (error) { problems.push(`shared area: ${(error as Error).message}`); }
  }
  for (const [alias, profile] of Object.entries(registry.profiles)) {
    try {
      const home = await assertSafeProfileDirectory(paths, alias);
      const mode = (await lstat(home)).mode & 0o777;
      if (mode & 0o077) problems.push(`${alias}: profile permissions are ${mode.toString(8)}, expected 700.`);
      const authPath = join(home, "auth.json");
      try {
        const auth = await lstat(authPath);
        if (!auth.isFile() || auth.isSymbolicLink()) problems.push(`${alias}: auth.json is not a safe regular file.`);
        else if ((auth.mode & 0o777) !== 0o600) problems.push(`${alias}: auth.json permissions are ${(auth.mode & 0o777).toString(8)}, expected 600.`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") problems.push(`${alias}: auth.json is missing.`);
        else problems.push(`${alias}: cannot inspect auth.json metadata.`);
      }
      if (profile.mode === "hybrid") {
        for (const name of SHARED_ENTRIES) {
          const item = join(home, name);
          try {
            const stat = await lstat(item);
            if (!stat.isSymbolicLink()) problems.push(`${alias}: ${name} is not linked to the shared area.`);
            else if (resolve(home, await readlink(item)) !== join(paths.shared, name)) problems.push(`${alias}: unsafe ${name} link.`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            // Profiles created before this entry joined the shared set.
            warnings.push(`${alias}: ${name} is not linked yet. Run 'cx account repair ${alias}'.`);
          }
        }
      }
      // A login check asks Codex, and therefore the network. It is a warning, not
      // a structural failure, so a stale token stays distinguishable from a
      // broken profile layout. --offline skips it entirely.
      if (binary && !offline && await runCodex(binary, home, ["login", "status"], { quiet: true }) !== 0) {
        warnings.push(`${alias}: Codex reports that the login is unavailable or expired. Run 'cx account login ${alias}'.`);
      }
    } catch (error) { problems.push(`${alias}: ${(error as Error).message}`); }
  }
  if (registry.active && !hasProfile(registry, registry.active)) problems.push("Active account does not exist.");
  for (const problem of problems) output(`FAIL ${problem}`);
  for (const warning of warnings) output(`WARN ${warning}`);
  if (problems.length) return 1;
  output(`OK registry: ${Object.keys(registry.profiles).length} account(s)`);
  output(`OK Codex CLI: ${binary}`);
  if (offline) output("OK login checks skipped (--offline)");
  output("Credential contents were not inspected.");
  return 0;
}

async function accountCommand(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === "add") return accountAdd(rest);
  if (command === "list") return accountList(rest);
  if (command === "label") return accountLabel(rest);
  if (command === "status" || command === "login" || command === "logout") return accountAuth(command, rest);
  if (command === "remove") return accountRemove(rest);
  if (command === "repair") return accountRepair(rest);
  fail("Usage: cx account add|list|label|status|login|logout|remove|repair");
}

export async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (!command) {
    const registry = await readRegistry(paths);
    if (!registry.active) { output(usage()); return 0; }
    return launch(requireProfile(registry, registry.active), []);
  }
  if (command === "help" || command === "--help" || command === "-h") { output(usage()); return 0; }
  if (command === "version" || command === "--version" || command === "-V") { output(VERSION); return 0; }
  if (command === "--upgrade") return upgradeCommand(rest);
  if (command === "--uninstall") return uninstallCommand(rest);
  if (command === "account") return accountCommand(rest);
  if (command === "use") return useAccount(rest[0]);
  if (command === "doctor") return doctor(rest);
  if (command === "completion") { output(shellCompletion(requireShell(rest[0]))); return 0; }
  if (command === "shell") {
    if (rest[0] !== "init") fail("Usage: cx shell init bash|zsh");
    output(shellInit(requireShell(rest[1]))); return 0;
  }
  if (command === "default") {
    const registry = await readRegistry(paths);
    // The shell hook shadows `codex`. Before the first account exists there is
    // nothing to select, so fall through to the real CLI instead of breaking a
    // command the user already relied on.
    if (!registry.active && process.env.CX_SHELL_HOOK === "1") {
      process.stderr.write("cx: no CodexAlt account yet; running the real Codex CLI. Create one with 'cx account add <alias> --mode hybrid'.\n");
      return runCodexPassthrough(await resolveCodexBinary(registry), withoutSeparator(rest));
    }
    return launch(requireProfile(registry, registry.active), withoutSeparator(rest));
  }
  if (command === "run") {
    const registry = await readRegistry(paths);
    const candidate = rest[0] && hasProfile(registry, rest[0]) ? rest[0] : registry.active;
    const codexArgs = candidate === rest[0] ? rest.slice(1) : rest;
    return launch(requireProfile(registry, candidate), withoutSeparator(codexArgs));
  }
  validateAlias(command);
  return launch(command, withoutSeparator(rest));
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`cx: ${(error as Error).message}\n`);
      process.exit(1);
    });
}
