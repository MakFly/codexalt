export type SupportedShell = "bash" | "zsh";

export function shellInit(shell: SupportedShell): string {
  const completion = shell === "bash"
    ? "complete -F _cx_complete cx codex"
    : "compdef _cx_complete cx codex";
  return `# CodexAlt (${shell})\n` +
    `codex() { CX_SHELL_HOOK=1 command cx default -- \"$@\"; }\n` +
    `${shellCompletion(shell)}\n${completion}\n`;
}

export function shellCompletion(shell: SupportedShell): string {
  if (shell === "bash") {
    return `_cx_complete() {
  local current="\${COMP_WORDS[COMP_CWORD]}"
  local commands="account use run default doctor shell completion help version"
  local account_commands="add list label status login logout remove repair"
  if [[ "\${COMP_WORDS[1]}" == "account" ]]; then
    COMPREPLY=( $(compgen -W "$account_commands" -- "$current") )
  else
    COMPREPLY=( $(compgen -W "$commands" -- "$current") )
  fi
}`;
  }
  return `#compdef cx codex
_cx_complete() {
  local -a commands account_commands
  commands=(account use run default doctor shell completion help version)
  account_commands=(add list label status login logout remove repair)
  if [[ "$words[2]" == "account" ]]; then
    _describe 'account command' account_commands
  else
    _describe 'command' commands
  fi
}`;
}

export function requireShell(value: string | undefined): SupportedShell {
  if (value !== "bash" && value !== "zsh") throw new Error("Shell must be 'bash' or 'zsh'.");
  return value;
}
