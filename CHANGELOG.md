# Changelog

All notable changes to CodexAlt are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Dates use `dd-mm-yyyy`.

## [Unreleased]

## [0.4.1] - 17-08-2026

### Added

- `hooks.json` and `CLAUDE.md` join the hybrid shared set (`src/profile.ts`). A Codex harness is not only `config.toml`: without a shared `hooks.json`, no hook fires on a hybrid account, which made the mode look broken to anyone who used hooks. A shared `hooks.json` executes shell commands on every hybrid account, so `README.md` now says to use `--mode isolated` when a hook must not cross accounts.
- `cx account repair [alias]`: links the shared entries a hybrid profile is missing. Profiles created before an entry joined the shared set do not have its link, and the set will grow again. Repair only adds what is absent, never replaces a file the user put there, and reports isolated profiles as having nothing to do.
- Shared files are seeded per format instead of always blank. Empty is valid TOML and valid Markdown but not valid JSON, so a fresh `hooks.json` is seeded with `{"hooks":{}}`.
- Codex flags are forwarded when they come first, so `cx --yolo` and `cx -s read-only` run the active account with those arguments (`src/cli.ts`). `cx <alias> --yolo` and `cx default -- --yolo` already worked, which made the plain form the odd one out: it hit alias validation and failed with a message about the alias pattern. No flag list is hardcoded; anything `cx` does not own itself is handed to Codex, exactly as Codex forwards unrecognized options to its interactive CLI. Bare words are still alias-validated, so a mistyped alias remains an error instead of becoming a silent Codex prompt.

### Changed

- `cx doctor` derives its checks from the shared set rather than a hardcoded list, so the two cannot drift apart again. A missing shared entry or an unlinked profile entry is now a `WARN` naming `cx account repair`, instead of an `ENOENT` that aborted the remaining checks for that profile.
- `cx account status`, `login`, and `logout` name the profile they act on before delegating to Codex, for example `Account: perso <you@example.com>`. Codex reports how you are authenticated but never as whom, which left the answer unattributable when several accounts exist. The identity shown is the label recorded at `account add` time; `auth.json` is still never read. An unlabelled profile is reported as such, with the command to fix it, and a non-active target says so explicitly, which matters most before a `logout`.

## [0.4.0] - 16-08-2026

Prepared but never tagged. Its content shipped in 0.4.1, so the release after `v0.3.0` on GitHub is `v0.4.1`.

### Changed

- **Renamed the project from CodexPlus to CodexAlt.** The GitHub repository moved from `MakFly/codexplusplus` to `MakFly/codexalt`. GitHub redirects the old URLs, so existing clones and installer links keep resolving, but they should be updated.
- Renamed the installer environment variables: `CODEXPLUS_INSTALL_DIR`, `CODEXPLUS_VERSION`, `CODEXPLUS_REPOSITORY`, and `CODEXPLUS_RELEASE_BASE_URL` are now `CODEXALT_*`. The `CX_DATA_HOME` and `CX_CODEX_BIN` variables are unchanged.
- Renamed the npm package and all user-facing strings in the CLI, shell integration, and error messages.
- Restructured `README.md` around the user journey instead of the reference material. Order is now install, add accounts, switch, shell integration, one-off runs, other tools, troubleshooting, then the architecture diagram, command reference, and security model.
- Declared the project **Linux only**, in the code as well as the documentation. Removed the `darwin` state directory branch (`src/paths.ts`), the `cx-macos-*` release artifacts (`src/lifecycle.ts`), the `Darwin-*` cases in `install.sh`, the macOS release matrix entries, and the `macos-latest` CI runner. `releaseArtifact` now names the supported targets when it refuses a platform.
- Documented the state directory as `$XDG_DATA_HOME/codexalt` only, defaulting to `~/.local/share/codexalt`.
- `cx doctor` now separates `WARN` from `FAIL`. A login that Codex reports as expired is a warning and no longer makes the whole check exit 1, so a stale token stays distinguishable from a broken profile layout.
- The registry is validated when it is read, not when a value happens to be displayed. Every profile entry must carry a valid alias, a known mode, a parsable `createdAt`, and a safe label. A tampered entry is now refused by every command instead of only by `cx account list`.
- A registry lock left behind by a killed process is reclaimed automatically once its owner is confirmed dead and the file is unchanged, instead of demanding a manual `rm`. A lock whose owner is still alive, including under another user, is never stolen.
- `cx account add` parses its options positionally. A value is always taken literally, so `--label --team--` works, and a stray argument that happens to equal the mode or the label is now rejected.

### Fixed

- Aliases that collide with `Object.prototype` keys, `constructor` in particular, were reported as already existing and could not be created (`src/cli.ts`, `src/registry.ts`). Profile maps are now null-prototype and every membership test goes through `Object.hasOwn`.
- `assertNoCredentialStoreOverride` scanned the whole argument list while the `-c` injection stopped at the first `--`. A legitimate argument meant for a child process was therefore rejected. Both now stop at the separator.
- Spawning the Codex CLI is bounded to 8 nested levels through `CX_SPAWN_DEPTH`. A third-party wrapper named `codex` earlier on `PATH` that calls back into `cx` now produces one actionable error naming `CX_CODEX_BIN`, instead of unbounded recursion. This closes the recursion issue listed under 0.3.0.
- `resolveCodexBinary` requires a regular file. A directory named `codex` on `PATH` satisfied the `X_OK` check and was accepted as the Codex executable.
- Removed a dead condition in `cx account label` whose two branches tested the same thing.

### Added

- `README.md`: a hybrid versus isolated comparison table with a selection criterion, instead of a bare definition.
- `README.md`: an explicit warning that the shared directory starts empty, with the copy commands to seed it from an existing `~/.codex`.
- `README.md`: a note that `cx shell init` installs a shell function, so callers that spawn the `codex` binary directly bypass it and keep using `~/.codex`.
- `README.md`: a "Using a specific account from other tools" section covering `cx run <alias> -- mcp-server` and direct `CODEX_HOME` usage, with a Claude Code MCP registration example.
- `README.md`: a troubleshooting table mapping symptoms to fixes.
- `README.md`: `cx shell init bash|zsh` added to the command reference table, where it was missing despite existing in the CLI.
- `CHANGELOG.md` (this file).
- `cx doctor --offline` skips the per-account login probe, so the check runs without touching the network.
- `cx doctor` reports accounts left behind in the pre-rename `~/.local/share/codexplusplus` directory, with the `mv` command to move them. This is a report only, nothing is migrated automatically.
- The shell hook falls back to the real Codex CLI when no CodexAlt account exists yet. Installing it before adding an account no longer breaks the plain `codex` command. The fallback runs with the ambient `CODEX_HOME` and no injected credential store, and prints a notice on stderr.
- A test asserting that `VERSION` and `package.json` agree, so a release tag cannot fail the workflow's version check.

### Breaking

- The state directory moved from `~/.local/share/codexplusplus` to `~/.local/share/codexalt` (`src/paths.ts`). There is **no automatic migration**. Anyone who created accounts under the old name must either move the directory manually or set `CX_DATA_HOME` to the old path:

  ```bash
  mv ~/.local/share/codexplusplus ~/.local/share/codexalt
  ```

  This was done while the project had no known installations carrying account state. The purge validator does not hardcode the directory name (`src/lifecycle.ts:123`), so `--purge` safety is unaffected.

### CI

- Upgraded the release workflow actions to Node 24 minimum versions (`57fb0a1`).
- Dropped the macOS CI runner and the two macOS release matrix entries, matching the Linux-only scope.

## [0.3.0] - 16-08-2026

First public release. Tagged at `5734fc1`.

### Added

- `cx account add <alias> --mode hybrid|isolated [--label <identity>] [--device-auth]`: authenticates through the official Codex CLI and creates the profile atomically, staging it first and publishing only after login is confirmed.
- `cx account list [--json]`, `cx account label`, `cx account status`, `cx account login`, `cx account logout`, `cx account remove`.
- `cx use <alias>`: atomically changes the active account.
- `cx`, `cx default -- <args>`, `cx run [alias] -- <args>`, and `cx <alias> -- <args>` to launch Codex against the active or an explicit account.
- Two profile modes. `isolated` shares nothing. `hybrid` shares only `config.toml`, `AGENTS.md`, `skills`, `agents`, and `rules` through a private CodexAlt directory that starts blank and is never seeded from `~/.codex`.
- `cx doctor`: verifies the registry, directory permissions, symlinks, and the resolved Codex executable without reading credential contents.
- `cx shell init bash|zsh` and `cx completion bash|zsh`.
- `cx --upgrade [--install-dir <directory>]`: downloads the matching release archive and `SHA256SUMS`, requires exactly one checksum entry, verifies SHA-256 before extraction, and replaces the running executable atomically.
- `cx --uninstall [--purge] [--yes]`: removes only the running `cx` executable by default and preserves all account state.
- `install.sh`: detects platform and architecture, downloads the matching release, and verifies it against `SHA256SUMS` before installing into `~/.local/bin`. Designed to be downloaded and reviewed rather than piped into a shell.
- Release workflow producing x64 and arm64 artifacts with `SHA256SUMS` and build attestations.
- CI workflow running lint, type-check, and the test suite.
- Test suite driven by a fake Codex executable and temporary directories, which never starts OAuth and never touches `~/.codex`.

### Security

- Every Codex invocation receives a profile-specific `CODEX_HOME` and `-c cli_auth_credentials_store="file"`. `assertNoCredentialStoreOverride` rejects any user attempt to override that key through `-c`, `--config`, or `--config=`.
- CodexAlt never reads credential contents and never imports, moves, or modifies an existing `~/.codex` directory.
- Profile directories are created with mode `0700`. The registry and shared files use `0600`.
- `auth.json` is chmod'ed to `0600` after login and rejected if it is not a regular file.
- Path guards refuse symlinked data roots, profile directories outside the profiles root, and profile parents that do not resolve to the expected directory.
- Registry writes go through a PID-based lock with stale-owner detection and a 10 second timeout, then a temp file plus atomic rename.
- `--purge` requires an interactive `PURGE` confirmation or an explicit `--yes`, and refuses symlinked roots, unknown files, the home directory, and `~/.codex`.
- The Codex binary resolver skips CodexAlt's own executable paths to avoid self-invocation.

### Notes

- Versions 0.1.0 and 0.2.0 were never published. Development happened before the repository was made public and was squashed into the initial release commit, which was tagged `v0.3.0`.

[Unreleased]: https://github.com/MakFly/codexalt/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/MakFly/codexalt/compare/v0.3.0...v0.4.1
[0.4.0]: https://github.com/MakFly/codexalt/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/MakFly/codexalt/releases/tag/v0.3.0
