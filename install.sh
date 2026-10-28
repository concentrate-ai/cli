#!/usr/bin/env bash
# Installs the Concentrate AI CLI (`cn`). Runs on Node.js 18.18+. Source checkouts need npm to build.
#   From a checkout:   ./install.sh
#   From the web:      curl -fsSL https://raw.githubusercontent.com/concentrate-ai/cli/main/install.sh | bash
# Piped from the web, downloads a built, checksummed release from GitHub Releases.
# Set CN_INSTALL_VERSION=0.1.0 to pin a release; the default is latest.
set -euo pipefail

MIN_NODE_MAJOR=18
MIN_NODE_MINOR=18
RELEASES_URL="https://github.com/concentrate-ai/cli/releases"
RELEASE_VERSION="${CN_INSTALL_VERSION:-latest}"
script_dir=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  script_dir="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
package_dir=""
install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/concentrate-cli"
bin_dir="$HOME/.local/bin"
launcher="$bin_dir/cn"
marker="# concentrate-cli launcher"
download_dir=""
staged_dir=""
launcher_temp=""
backup_dir=""
promoted_runtime=false
install_committed=false

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$install_committed" != true ]]; then
    if [[ "$promoted_runtime" == true ]]; then rm -rf "$install_dir"; fi
    if [[ -n "$backup_dir" && -d "$backup_dir" ]]; then mv "$backup_dir" "$install_dir"; fi
  elif [[ -n "$backup_dir" ]]; then
    rm -rf "$backup_dir"
  fi
  [[ -z "$download_dir" ]] || rm -rf "$download_dir"
  [[ -z "$staged_dir" ]] || rm -rf "$staged_dir"
  [[ -z "$launcher_temp" ]] || rm -f "$launcher_temp"
  exit "$status"
}
trap cleanup EXIT

node_major() {
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 18 || (major === 18 && minor >= 18) ? 0 : 1)'
}

node_help() {
  echo "Install Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ and rerun this installer:" >&2
  echo "  - https://nodejs.org/en/download" >&2
  echo "  - nvm: https://github.com/nvm-sh/nvm#installing-and-updating" >&2
}

ensure_node() {
  node_ok && return 0
  if command -v node >/dev/null 2>&1; then
    echo "Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ is required (found $(node -p process.versions.node))." >&2
  else
    echo "Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ is required." >&2
  fi
  # /dev/tty is always readable as a file; opening it fails when there is no terminal (ssh, CI).
  if [[ "$(uname -s)" == "Darwin" ]] && command -v brew >/dev/null 2>&1 && { : </dev/tty; } 2>/dev/null; then
    local answer=""
    read -r -p "Install Node.js with Homebrew now? [y/N] " answer </dev/tty || answer=""
    if [[ "$answer" =~ ^[Yy]$ ]]; then
      brew install node
      node_ok && return 0
    fi
  fi
  node_help
  exit 1
}

# A different `cn` (for example the Python package's) must not be overwritten.
check_launcher() {
  if [[ -e "$launcher" || -L "$launcher" ]]; then
    if [[ -L "$launcher" ]] || ! grep -q "^${marker}$" "$launcher" 2>/dev/null; then
      echo "A different cn command already exists at $launcher. Move it before installing." >&2
      exit 1
    fi
  fi
}

# Use the files next to this script, or fetch the package when piped from the web.
locate_package() {
  if [[ -n "$script_dir" && ( -f "$script_dir/src/bin/cn.ts" || -f "$script_dir/dist/bin/cn.js" ) ]]; then
    package_dir="$script_dir"
    return
  fi
  local release_url="$RELEASES_URL/latest/download"
  if [[ "$RELEASE_VERSION" != latest ]]; then
    local tag="${RELEASE_VERSION#v}"
    if [[ ! "$tag" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
      echo "CN_INSTALL_VERSION must be a release version such as 0.1.0." >&2
      exit 1
    fi
    release_url="$RELEASES_URL/download/v$tag"
  fi
  for tool in curl tar; do
    command -v "$tool" >/dev/null 2>&1 || { echo "Missing required command: $tool" >&2; exit 1; }
  done
  download_dir="$(mktemp -d)"
  local archive="$download_dir/concentrate-cli.tar.gz"
  local checksums="$download_dir/SHA256SUMS"
  echo "Downloading Concentrate AI CLI ($RELEASE_VERSION)..."
  local expected actual attempt
  for attempt in 1 2; do
    # Checksum first: if a release rolls out between the two requests, the
    # mismatch is caught below and the pair is fetched again.
    if ! curl -fsSL --proto '=https' --retry 2 --connect-timeout 10 --max-time 30 "$release_url/SHA256SUMS" -o "$checksums" ||
       ! curl -fsSL --proto '=https' --retry 2 --connect-timeout 10 --max-time 120 "$release_url/concentrate-cli.tar.gz" -o "$archive"; then
      echo "Could not download the CLI release. The selected CLI release may not have been published yet." >&2
      exit 1
    fi
    expected="$(awk '$2 == "concentrate-cli.tar.gz" { print $1 }' "$checksums")"
    if [[ ! "$expected" =~ ^[a-fA-F0-9]{64}$ ]]; then
      echo "The release checksum file is missing a valid CLI checksum." >&2
      exit 1
    fi
    if command -v shasum >/dev/null 2>&1; then
      actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
    elif command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$archive" | awk '{print $1}')"
    else
      echo "Install shasum or sha256sum to verify the release." >&2
      exit 1
    fi
    [[ "$actual" == "$expected" ]] && break
    if [[ "$attempt" == 2 ]]; then
      echo "The CLI download failed SHA-256 verification. Your current installation was left unchanged." >&2
      exit 1
    fi
    sleep 3
  done
  tar -xzf "$archive" -C "$download_dir"
  if [[ ! -f "$download_dir/dist/bin/cn.js" || -f "$download_dir/src/bin/cn.ts" ]]; then
    echo "The release does not contain the built CLI." >&2
    exit 1
  fi
  package_dir="$download_dir"
}

ensure_node
check_launcher
locate_package

# Release packages contain dist; source checkouts compile before replacing an install.
if [[ -f "$package_dir/src/bin/cn.ts" ]]; then
  command -v npm >/dev/null 2>&1 || { echo "npm is required to build this source checkout." >&2; exit 1; }
  (
    cd "$package_dir"
    # Reinstall when a tool is missing or the lockfile moved on.
    if [[ ! -x node_modules/.bin/tsc || ! -x node_modules/.bin/esbuild || ! -d node_modules/smol-toml || ! -d node_modules/jsonc-parser || ! -f node_modules/.package-lock.json || package-lock.json -nt node_modules/.package-lock.json ]]; then
      npm ci --include=dev --ignore-scripts
    fi
    npm run build
  )
fi
if [[ ! -f "$package_dir/dist/bin/cn.js" ]]; then
  echo "The package does not contain a built CLI. Run npm ci and npm run build." >&2
  exit 1
fi

node_bin="$(command -v node)"
if [[ -L "$install_dir" || ( -e "$install_dir" && ! -d "$install_dir" ) ]]; then
  echo "Refusing to replace a symbolic link or non-directory at $install_dir." >&2
  exit 1
fi
mkdir -p "$(dirname "$install_dir")" "$bin_dir"
staged_dir="$(mktemp -d "$(dirname "$install_dir")/.concentrate-cli.XXXXXX")"
cp -R "$package_dir/dist" "$package_dir/package.json" "$staged_dir/"
"$node_bin" "$staged_dir/dist/bin/cn.js" --version >/dev/null
launcher_temp="$(mktemp "$bin_dir/.cn.XXXXXX")"

# Paths are embedded single-quoted, so spaces, $, quotes, or backticks in them stay literal.
sh_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

{
  printf '%s\n' '#!/bin/sh' "$marker"
  printf 'NODE_BIN="${CN_NODE_BIN:-}"\n'
  printf '[ -n "$NODE_BIN" ] || NODE_BIN=%s\n' "$(sh_quote "$node_bin")"
  cat <<'LAUNCHER'
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node 2>/dev/null)"
if [ -z "$NODE_BIN" ]; then
  echo "cn: Node.js was not found. Install Node 18.18+ and rerun the installer." >&2
  exit 127
fi
LAUNCHER
  printf 'exec "$NODE_BIN" %s "$@"\n' "$(sh_quote "$install_dir/dist/bin/cn.js")"
} >"$launcher_temp"
chmod 755 "$launcher_temp"
if [[ -d "$install_dir" ]]; then
  backup_dir="$(mktemp -d "$(dirname "$install_dir")/.concentrate-cli-backup.XXXXXX")"
  rmdir "$backup_dir"
  mv "$install_dir" "$backup_dir"
fi
mv "$staged_dir" "$install_dir"
staged_dir=""
promoted_runtime=true
mv -f "$launcher_temp" "$launcher"
launcher_temp=""
install_committed=true

printf '\nInstalled Concentrate AI at %s\n' "$launcher"
case ":$PATH:" in
  *":$bin_dir:"*) printf 'Run: cn\n' ;;
  *)
    case "${SHELL:-}" in
      */zsh) rc_file="$HOME/.zshrc" ;;
      */bash)
        # macOS terminals start login shells, which read .bash_profile, not .bashrc.
        if [[ "$(uname -s)" == "Darwin" || -f "$HOME/.bash_profile" ]]; then
          rc_file="$HOME/.bash_profile"
        else
          rc_file="$HOME/.bashrc"
        fi
        ;;
      *) rc_file="your shell startup file" ;;
    esac
    printf 'Add this line to %s:\n  export PATH="$HOME/.local/bin:$PATH"\n' "$rc_file"
    printf 'Then open a new terminal and run: cn\n'
    ;;
esac
