# Changelog

All notable changes to CodexAlt are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Dates use `dd-mm-yyyy`.

## [Unreleased]

### Changed

- **Renamed the project from CodexPlus to CodexAlt.** The GitHub repository moved from `MakFly/codexplusplus` to `MakFly/codexalt`. GitHub redirects the old URLs, so existing clones and installer links keep resolving, but they should be updated.
- Renamed the installer environment variables: `CODEXPLUS_INSTALL_DIR`, `CODEXPLUS_VERSION`, `CODEXPLUS_REPOSITORY`, and `CODEXPLUS_RELEASE_BASE_URL` are now `CODEXALT_*`. The `CX_DATA_HOME` and `CX_CODEX_BIN` variables are unchanged.
- Renamed the npm package and all user-facing strings in the CLI, shell integration, and error messages.
- Restructured `README.md` around the user journey instead of the reference material. Order is now install, add accounts, switch, shell integration, one-off runs, other tools, troubleshooting, then the architecture diagram, command reference, and security model.
- Declared the project **Linux only**. `README.md` no longer documents macOS support in the requirements, installer description, build instructions, or state directory paths.
- Documented the state directory as `$XDG_DATA_HOME/codexalt` only, defaulting to `~/.local/share/codexalt`.

### Added

- `README.md`: a hybrid versus isolated comparison table with a selection criterion, instead of a bare definition.
- `README.md`: an explicit warning that the shared directory starts empty, with the copy commands to seed it from an existing `~/.codex`.
- `README.md`: a note that `cx shell init` installs a shell function, so callers that spawn the `codex` binary directly bypass it and keep using `~/.codex`.
- `README.md`: a "Using a specific account from other tools" section covering `cx run <alias> -- mcp-server` and direct `CODEX_HOME` usage, with a Claude Code MCP registration example.
- `README.md`: a troubleshooting table mapping symptoms to fixes.
- `README.md`: `cx shell init bash|zsh` added to the command reference table, where it was missing despite existing in the CLI.
- `CHANGELOG.md` (this file).

### Breaking

- The state directory moved from `~/.local/share/codexplusplus` to `~/.local/share/codexalt` (`src/paths.ts`). There is **no automatic migration**. Anyone who created accounts under the old name must either move the directory manually or set `CX_DATA_HOME` to the old path:

  ```bash
  mv ~/.local/share/codexplusplus ~/.local/share/codexalt
  ```

  This was done while the project had no known installations carrying account state. The purge validator does not hardcode the directory name (`src/lifecycle.ts:123`), so `--purge` safety is unaffected.

### CI

- Upgraded the release workflow actions to Node 24 minimum versions (`57fb0a1`).

### Known issues

- `resolveCodexBinary` (`src/codex.ts:10`) only excludes CodexAlt's own paths, not third parties. A wrapper named `codex` placed earlier on `PATH` that calls back into `cx` is accepted as "the real Codex CLI", producing unbounded recursion. `selectedCodex` (`src/cli.ts:99`) then persists that path into `registry.codexBinary`, so the failure survives a restart. Reproduced with `cx doctor` against a synthetic shim. Not triggered by any documented workflow, but it blocks adding a `PATH` shim.
- The repository still builds, tests, ships, and self-upgrades macOS artifacts (`install.sh`, both workflows, `src/paths.ts:19`, `src/lifecycle.ts:16`) while the documentation declares Linux only. Code and documentation are intentionally out of step until the support scope is settled.

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

[Unreleased]: https://github.com/MakFly/codexalt/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/MakFly/codexalt/releases/tag/v0.3.0
