#!/usr/bin/env sh
set -eu

repository="${CODEXALT_REPOSITORY:-MakFly/codexalt}"
version="${CODEXALT_VERSION:-latest}"
install_dir="${CODEXALT_INSTALL_DIR:-${HOME}/.local/bin}"
action="${1:-install}"

if [ "$#" -gt 1 ]; then
  printf '%s\n' "Usage: install.sh [install|upgrade]" >&2
  exit 1
fi

if [ "$action" = "--help" ] || [ "$action" = "-h" ]; then
  printf '%s\n' "Usage: install.sh [install|upgrade]"
  printf '%s\n' "Environment: CODEXALT_INSTALL_DIR CODEXALT_VERSION CODEXALT_REPOSITORY"
  exit 0
fi
if [ "$action" != "install" ] && [ "$action" != "upgrade" ]; then
  printf '%s\n' "Unknown action: $action (expected install or upgrade)" >&2
  exit 1
fi

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) artifact="cx-linux-x64" ;;
  Linux-aarch64|Linux-arm64) artifact="cx-linux-arm64" ;;
  *) printf '%s\n' "Unsupported platform: $(uname -s) $(uname -m). CodexAlt targets Linux x64 and arm64 only." >&2; exit 1 ;;
esac

if [ "$version" = "latest" ]; then
  base_url="https://github.com/${repository}/releases/latest/download"
else
  base_url="https://github.com/${repository}/releases/download/${version}"
fi

mkdir -p "$install_dir"
[ ! -L "$install_dir" ] || { printf '%s\n' "Refusing symlinked install directory" >&2; exit 1; }
target="${install_dir}/cx"
[ ! -L "$target" ] || { printf '%s\n' "Refusing symlinked cx target" >&2; exit 1; }
[ ! -e "$target" ] || [ -f "$target" ] || { printf '%s\n' "Refusing non-file cx target" >&2; exit 1; }
if [ "$action" = "upgrade" ] && [ ! -f "$target" ]; then
  printf '%s\n' "Cannot upgrade: $target is not installed" >&2
  exit 1
fi

temporary="$(mktemp -d "${TMPDIR:-/tmp}/codexalt.XXXXXX")"
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

curl --fail --location --silent --show-error "${base_url}/${artifact}.tar.gz" --output "${temporary}/${artifact}.tar.gz"
curl --fail --location --silent --show-error "${base_url}/SHA256SUMS" --output "${temporary}/SHA256SUMS"

(
  cd "$temporary"
  awk -v file="${artifact}.tar.gz" '$2 == file || $2 == "*" file { print }' SHA256SUMS > CHECKSUM
  [ "$(wc -l < CHECKSUM | tr -d ' ')" = "1" ] || {
    printf '%s\n' "Checksum manifest must contain exactly one ${artifact}.tar.gz entry" >&2
    exit 1
  }
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum --check CHECKSUM
  else
    expected="$(awk '{print $1}' CHECKSUM)"
    actual="$(shasum -a 256 "${artifact}.tar.gz" | awk '{print $1}')"
    [ -n "$expected" ] && [ "$expected" = "$actual" ]
  fi
  tar -xzf "${artifact}.tar.gz" cx
  [ -f cx ] && [ ! -L cx ] || { printf '%s\n' "Release does not contain a safe cx binary" >&2; exit 1; }
)

previous="not installed"
if [ -x "$target" ]; then previous="$("$target" --version 2>/dev/null || printf '%s' unknown)"; fi
installed="$("${temporary}/cx" --version)" || {
  printf '%s\n' "Downloaded cx failed its version check; ${action} aborted" >&2
  exit 1
}
[ -n "$installed" ] || { printf '%s\n' "Downloaded cx returned an empty version; ${action} aborted" >&2; exit 1; }
install -m 755 "${temporary}/cx" "${install_dir}/cx"
printf '%s\n' "${action}: ${previous} -> ${installed}"
printf '%s\n' "Installed cx to ${target}"
