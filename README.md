# CodexPlus

CodexPlus (`cx`) is a small local account manager for the official Codex CLI. Each account receives its own protected `CODEX_HOME`, so switching accounts does not copy, parse, or expose authentication tokens.

## How it works

```text
╔══════════════ Shell ══════════════╗
║ ┌──────────┐  CLI arguments      ┌──────────────┐ ║
║ │ bash/zsh │────────────────────▶│ cx           │ ║
║ └──────────┘                     └──────┬───────┘ ║
╚═════════════════════════════════════════│═════════╝
                                profile selection
                                          ▼
╔════════════ Local state ═════════════════════════╗
║ ┌──────────┐  CODEX_HOME     ┌────────────────┐ ║
║ │ registry │────────────────▶│ account profile│ ║
║ └──────────┘                 └───────┬────────┘ ║
╚══════════════════════════════════════│═══════════╝
                           file credential override
                                      ▼
╔══════════ Official runtime ══════════════════════╗
║ ┌──────────────┐  native authentication  ┌──────┐║
║ │ Codex CLI    │────────────────────────▶│OpenAI│║
║ └──────────────┘                         └──────┘║
╚══════════════════════════════════════════════════╝
```

Legend: double boxes are subsystems; single boxes are components. CodexPlus selects a directory and delegates all authentication and token refresh behavior to the official Codex CLI.

## Requirements and installation

- Linux or macOS
- [Bun](https://bun.sh/) only when building from source
- The official `codex` executable already installed

Download and inspect the installer before running it; CodexPlus deliberately does not recommend an unverified `curl | sh` pipeline:

```bash
curl --proto '=https' --tlsv1.2 -fL https://raw.githubusercontent.com/MakFly/codexplusplus/main/install.sh -o /tmp/codexplusplus-install.sh
less /tmp/codexplusplus-install.sh
sh /tmp/codexplusplus-install.sh install
```

The installer detects Linux/macOS and x64/arm64, downloads the corresponding release, verifies it against `SHA256SUMS`, and installs it to `~/.local/bin`. Run the same reviewed script with `upgrade` to update an existing installation. To build from source instead:

```bash
git clone https://github.com/MakFly/codexplusplus.git
cd codexplusplus
bun install --frozen-lockfile
bun run build
install -Dm755 dist/cx "$HOME/.local/bin/cx"
```

On macOS, if your `install` command does not support `-D`:

```bash
mkdir -p "$HOME/.local/bin"
install -m755 dist/cx "$HOME/.local/bin/cx"
```

Prebuilt release archives can instead be unpacked and the `cx` binary placed anywhere on `PATH`. Set `CODEXPLUS_INSTALL_DIR`, `CODEXPLUS_VERSION`, or `CODEXPLUS_REPOSITORY` to override installer defaults.

## Quick start

```bash
cx account add personal --mode hybrid --label "personal@example.com"
cx account add work --mode isolated --label "work@example.com" --device-auth
cx use work
cx
```

`cx` with no arguments launches the active account; before the first account is added, it shows help. To make the regular `codex` command use the active account, add one of these lines to the relevant shell startup file:

```bash
# ~/.bashrc
eval "$(cx shell init bash)"

# ~/.zshrc
eval "$(cx shell init zsh)"
```

Then switch with one command and continue using Codex normally:

```bash
cx use personal
codex --sandbox workspace-write
```

You can also bypass the active account without changing it:

```bash
cx work -- --sandbox read-only
cx run personal -- resume --last
```

## Commands

| Command | Purpose |
| --- | --- |
| `cx account add <alias> --mode hybrid\|isolated [--label <identity>] [--device-auth]` | Authenticate and atomically create an account |
| `cx account list [--json]` | Show a readable account table or machine-readable JSON |
| `cx account label <alias> <identity>\|--clear` | Add, replace, or clear a non-secret identity label |
| `cx account status [alias]` | Ask Codex for the authentication status |
| `cx account login [alias] [--device-auth]` | Reauthenticate a profile |
| `cx account logout [alias]` | Log out a profile without deleting it |
| `cx account remove <alias> [--yes]` | Log out and delete one profile |
| `cx use <alias>` | Atomically change the default account |
| `cx default -- <args>` | Run Codex with the active account |
| `cx run [alias] -- <args>` | Run Codex with an explicit or active account |
| `cx <alias> -- <args>` | Short form for an explicit account |
| `cx doctor` | Check paths, permissions, links, and the Codex executable |
| `cx --upgrade [--install-dir <directory>]` | Download, checksum, and atomically install the latest release |
| `cx --uninstall [--install-dir <directory>]` | Remove only the currently running `cx` executable and preserve account state |
| `cx --uninstall --purge --yes` | Also remove validated CodexPlus-owned state after explicit consent |
| `cx completion bash\|zsh` | Print completion code |

Aliases must match `[a-z0-9][a-z0-9_-]{0,31}`. Command names are reserved.

## Isolation and security model

- `isolated` profiles share nothing.
- `hybrid` profiles share only `config.toml`, `AGENTS.md`, `skills`, `agents`, and `rules` through CodexPlus's private shared directory.
- The shared area starts blank. CodexPlus deliberately does not seed it from or modify `~/.codex`; copy selected customizations yourself after reviewing them.
- Authentication, sessions, history, logs, SQLite data, plugins, and MCP credentials remain profile-specific.
- Every Codex invocation receives `-c cli_auth_credentials_store="file"` and a profile-specific `CODEX_HOME`.
- Profile directories use mode `0700`; registry/shared files use `0600` where applicable.
- CodexPlus never reads credential contents. It does not import, move, or modify an existing `~/.codex` directory.
- Removing a hybrid profile removes its symlinks, not shared targets.

State is stored under `$XDG_DATA_HOME/codexplusplus` (or `~/.local/share/codexplusplus`) on Linux and `~/Library/Application Support/codexplusplus` on macOS. `CX_DATA_HOME` and `CX_CODEX_BIN` are supported for controlled installations and tests.

## Upgrading and uninstalling

`cx --upgrade` downloads the matching release archive and `SHA256SUMS`, requires exactly one checksum entry, verifies SHA-256 before extraction, and replaces the installed executable atomically. It targets the currently running compiled binary; use `--install-dir` only for a deliberate alternate installation directory.

```bash
cx --upgrade
# Or with the reviewed installer:
sh /tmp/codexplusplus-install.sh upgrade
```

`cx --uninstall` removes only that running `cx` executable. Profiles, authentication, shared customizations, and the registry remain in the state directory printed by the command. `cx --uninstall --purge` additionally removes that state only after an interactive `PURGE` confirmation, or with the explicit `--yes` flag. Purge refuses symlinked roots, unknown files, the home directory, and `~/.codex`; CodexPlus never removes the official Codex directory.

## Development

```bash
bun install
bun run check
bun test
bun run build
```

The test suite uses a fake Codex executable and temporary directories. It never starts OAuth or accesses `~/.codex`.

## License

[MIT](LICENSE)
