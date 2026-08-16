# CodexAlt

CodexAlt (`cx`) is a small **Linux-only** local account manager for the official Codex CLI. Each account gets its own protected `CODEX_HOME`, so switching accounts never copies, parses, or exposes authentication tokens.

Use it when you have more than one Codex account (personal and work, or several workspaces) and you are tired of logging out and back in.

## Requirements

- **Linux only.** This is a Linux project. macOS and Windows are not supported and not tested.
- The official `codex` executable already installed and on your `PATH`
- [Bun](https://bun.sh/) only if you build from source

## 1. Install

Download and inspect the installer before running it. CodexAlt deliberately does not recommend an unverified `curl | sh` pipeline:

```bash
curl --proto '=https' --tlsv1.2 -fL \
  https://raw.githubusercontent.com/MakFly/codexalt/main/install.sh \
  -o /tmp/codexalt-install.sh

less /tmp/codexalt-install.sh
sh /tmp/codexalt-install.sh install
```

The installer detects your architecture (x64 or arm64), downloads the matching Linux release, verifies it against `SHA256SUMS`, and installs `cx` into `~/.local/bin`.

Check that everything resolves:

```bash
cx doctor
```

You should see your registry, the path to the real Codex CLI, and no failures. If `cx` is not found afterwards, make sure `~/.local/bin` is on your `PATH`.

<details>
<summary>Build from source instead</summary>

```bash
git clone https://github.com/MakFly/codexalt.git
cd codexalt
bun install --frozen-lockfile
bun run build
install -Dm755 dist/cx "$HOME/.local/bin/cx"
```

Prebuilt release archives can also be unpacked and the `cx` binary placed anywhere on `PATH`. Set `CODEXALT_INSTALL_DIR`, `CODEXALT_VERSION`, or `CODEXALT_REPOSITORY` to override installer defaults.

</details>

## 2. Add your accounts

A fresh install has zero accounts. **CodexAlt does not import your existing `~/.codex`.** Your current login stays exactly where it is and keeps working through the plain `codex` command.

Add one account per identity. Each one runs a real OAuth login:

```bash
cx account add personal --mode hybrid --label "you@personal.example"
cx account add work     --mode hybrid --label "you@company.example"
```

A browser opens for each login. On a headless machine or over SSH, add `--device-auth`.

### Which mode should you pick?

| Mode | Shares | Pick it when |
| --- | --- | --- |
| `hybrid` | `config.toml`, `AGENTS.md`, `CLAUDE.md`, `hooks.json`, `skills`, `agents`, `rules` | You want one set of customizations across all your accounts. Good default. |
| `isolated` | Nothing | You need strict separation, for example a client account that must not see your rules. |

Authentication, sessions, history, logs, SQLite data, plugins, and MCP credentials are always per profile, in both modes.

### The shared area starts empty

Hybrid profiles share through a private CodexAlt directory that begins blank. CodexAlt never seeds it from `~/.codex` and never modifies `~/.codex`. If you want your existing customizations, copy them yourself after reviewing them:

```bash
cp ~/.codex/config.toml ~/.local/share/codexalt/shared/
cp ~/.codex/AGENTS.md   ~/.local/share/codexalt/shared/
cp ~/.codex/hooks.json  ~/.local/share/codexalt/shared/
cp -r ~/.codex/skills/. ~/.local/share/codexalt/shared/skills/
```

`hooks.json` runs shell commands, and a shared one runs on every hybrid account. If a hook talks to an external service, keep the account you want isolated on `--mode isolated` instead.

## 3. Switch between accounts

```bash
cx account list     # see every account and which one is active
cx use work         # change the active account
cx                  # launch Codex with the active account
```

`cx` with no arguments launches the active account. Before the first account exists, it prints help instead.

Codex arguments work directly on `cx`, with or without an alias:

```bash
cx --yolo                     # active account, flags forwarded to Codex
cx exec "summarize this repo" # non-interactive, same forwarding
cx resume --last
cx work --yolo                # explicit account
```

`cx` owns account selection and nothing else. An argument that names one of your accounts selects it; everything else goes to Codex untouched, which then applies its own rule of known subcommand first, anything else as the prompt. An account alias wins over a Codex subcommand of the same name, so an account called `exec` keeps `cx exec` for itself. Reach Codex explicitly in that case with `cx default -- exec "…"`.

## 4. Make `codex` follow the active account

Add one line to your shell startup file so the regular `codex` command uses whichever account is active:

```bash
# ~/.bashrc
eval "$(cx shell init bash)"

# ~/.zshrc
eval "$(cx shell init zsh)"
```

Open a new shell, then:

```bash
cx use personal
codex --sandbox workspace-write   # runs on 'personal'
```

This installs a shell function, so it only applies to shells that source your startup file. Tools that spawn the `codex` binary directly, such as editor extensions, CI jobs, or MCP clients, bypass it and keep using `~/.codex`. See [Using a specific account from other tools](#using-a-specific-account-from-other-tools) for those.

If no CodexAlt account exists yet, the hook prints a notice and runs the real Codex CLI against your existing `~/.codex`, so installing it in the wrong order never leaves you without a working `codex` command.

## 5. Run a one-off on another account

You can use any account without changing the active one:

```bash
cx work -- --sandbox read-only
cx run personal -- resume --last
```

## Using a specific account from other tools

Everything reduces to one environment variable, `CODEX_HOME`. Two ways to point another tool at a CodexAlt account.

Wrap the command with `cx`, which also enforces the file credential store:

```bash
cx run work -- mcp-server
```

For example, registering an account-scoped Codex MCP server in Claude Code:

```json
{
  "mcpServers": {
    "codex-work": {
      "type": "stdio",
      "command": "cx",
      "args": ["run", "work", "--", "mcp-server"]
    }
  }
}
```

Or set `CODEX_HOME` directly when the tool accepts an environment block:

```bash
CODEX_HOME="$HOME/.local/share/codexalt/profiles/work" codex mcp-server
```

If you take this second route, add `cli_auth_credentials_store = "file"` to that profile's `config.toml` yourself, since `cx` is no longer in the loop to inject it.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `cx: command not found` | Add `~/.local/bin` to your `PATH`, then open a new shell. |
| `Cannot find the real Codex CLI` | Install the official `codex` binary, or set `CX_CODEX_BIN` to its absolute path. |
| `codex` still uses the old account | You added the shell hook but did not reopen your shell, or the caller spawns `codex` directly. See section 4. |
| Not sure which account is live | `cx account list`, or `cx account status`, which names the profile and its label before asking Codex. Codex itself only reports how you are authenticated, never as whom. |
| Permissions or path look wrong | `cx doctor` reports directory modes, the registry, links, and the resolved Codex binary. `cx doctor --offline` skips the login probes. |
| Login expired | `cx account login work`, optionally with `--device-auth`. |
| Your hooks, skills, or MCP servers are missing on an account | The shared area starts blank. Copy them in as shown in section 3, then `cx account repair`. |
| Accounts vanished after upgrading from CodexPlus | The state directory was renamed. Move it once: `mv ~/.local/share/codexplusplus ~/.local/share/codexalt`. `cx doctor` reports this. |
| `Timed out waiting for the registry lock` | Another `cx` is mid-write. A lock left by a killed process is reclaimed automatically. |

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

Legend: double boxes are subsystems, single boxes are components. CodexAlt selects a directory and delegates all authentication and token refresh behavior to the official Codex CLI.

## Command reference

| Command | Purpose |
| --- | --- |
| `cx account add <alias> --mode hybrid\|isolated [--label <identity>] [--device-auth]` | Authenticate and atomically create an account |
| `cx account list [--json]` | Show a readable account table or machine-readable JSON |
| `cx account label <alias> <identity>\|--clear` | Add, replace, or clear a non-secret identity label |
| `cx account status [alias]` | Name the profile and its label, then ask Codex for the authentication status |
| `cx account login [alias] [--device-auth]` | Reauthenticate a profile |
| `cx account logout [alias]` | Log out a profile without deleting it |
| `cx account remove <alias> [--yes]` | Log out and delete one profile |
| `cx account repair [alias]` | Link shared entries a hybrid profile is missing, for example after the shared set grew |
| `cx use <alias>` | Atomically change the active account |
| `cx default -- <args>` | Run Codex with the active account |
| `cx run [alias] -- <args>` | Run Codex with an explicit or active account |
| `cx <alias> -- <args>` | Short form for an explicit account |
| `cx <codex arguments>` | Run Codex with the active account, for example `cx --yolo` or `cx exec "prompt"` |
| `cx doctor [--offline]` | Check paths, permissions, links, and the Codex executable. `--offline` skips the per-account login probe |
| `cx --upgrade [--install-dir <directory>]` | Download, checksum, and atomically install the latest release |
| `cx --uninstall [--install-dir <directory>]` | Remove only the running `cx` executable and preserve account state |
| `cx --uninstall --purge --yes` | Also remove validated CodexAlt-owned state after explicit consent |
| `cx shell init bash\|zsh` | Print the shell integration snippet |
| `cx completion bash\|zsh` | Print completion code |

Aliases must match `[a-z0-9][a-z0-9_-]{0,31}`. Command names are reserved.

## Isolation and security model

- `isolated` profiles share nothing.
- `hybrid` profiles share only `config.toml`, `AGENTS.md`, `CLAUDE.md`, `hooks.json`, `skills`, `agents`, and `rules`, through CodexAlt's private shared directory. A shared `hooks.json` executes on every hybrid account, so treat it as trusted code.
- The shared area starts blank. CodexAlt deliberately does not seed it from or modify `~/.codex`.
- Authentication, sessions, history, logs, SQLite data, plugins, and MCP credentials remain profile-specific.
- Every Codex invocation receives `-c cli_auth_credentials_store="file"` and a profile-specific `CODEX_HOME`.
- Profile directories use mode `0700`. Registry and shared files use `0600` where applicable.
- CodexAlt never reads credential contents. It does not import, move, or modify an existing `~/.codex` directory.
- Removing a hybrid profile removes its symlinks, not the shared targets.

State lives under `$XDG_DATA_HOME/codexalt`, which defaults to `~/.local/share/codexalt`. `CX_DATA_HOME` and `CX_CODEX_BIN` are supported for controlled installations and tests.

## Upgrading and uninstalling

`cx --upgrade` downloads the matching release archive and `SHA256SUMS`, requires exactly one checksum entry, verifies SHA-256 before extraction, and replaces the installed executable atomically. It targets the currently running compiled binary. Use `--install-dir` only for a deliberate alternate installation directory.

```bash
cx --upgrade
# Or with the reviewed installer:
sh /tmp/codexalt-install.sh upgrade
```

`cx --uninstall` removes only that running `cx` executable. Profiles, authentication, shared customizations, and the registry remain in the state directory printed by the command.

```bash
cx --uninstall                  # keep every account
cx --uninstall --purge --yes    # also delete profiles and CodexAlt-managed credentials
```

`--purge` removes CodexAlt state only after an interactive `PURGE` confirmation, or with the explicit `--yes` flag. Purge refuses symlinked roots, unknown files, the home directory, and `~/.codex`. CodexAlt never removes the official Codex directory.

## Development

```bash
bun install
bun run check
bun test
bun run build
```

The test suite uses a fake Codex executable and temporary directories. It never starts OAuth and never touches `~/.codex`.

## License

[MIT](LICENSE)
