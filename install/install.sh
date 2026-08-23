#!/usr/bin/env bash
# PatchProof one-command installer for Linux and macOS.
#
# Recommended (download first, inspect, then run):
#   curl -fsSL https://raw.githubusercontent.com/kwlck/PatchProof/main/install/install.sh -o install-patchproof.sh
#   bash install-patchproof.sh
#
# Installs the standalone PatchProof CLI into ~/.patchproof, downloads a pinned
# standalone Node.js runtime when no suitable Node is present, verifies every
# download against published SHA-256 checksums, and puts `patchproof` on PATH.
set -euo pipefail

PATCHPROOF_REPO="kwlck/PatchProof"
NODE_VERSION="22.14.0"
INSTALL_ROOT="${PATCHPROOF_HOME:-$HOME/.patchproof}"
BIN_DIR="$INSTALL_ROOT/bin"
LIB_DIR="$INSTALL_ROOT/lib"
RUNTIME_DIR="$INSTALL_ROOT/runtime"

log() { printf 'patchproof-install: %s\n' "$1"; }
fail() { printf 'patchproof-install: error: %s\n' "$1" >&2; exit 1; }

DOWNLOAD() { fail "download helper was not initialized"; }

need_download() {
  if command -v curl >/dev/null 2>&1; then
    DOWNLOAD() { curl -fsSL -o "$2" "$1"; }
  elif command -v wget >/dev/null 2>&1; then
    DOWNLOAD() { wget -qO "$2" "$1"; }
  else
    fail "neither curl nor wget is available; install one and re-run"
  fi
}

os_and_arch() {
  case "$(uname -s)" in
    Linux) os="linux" ;;
    Darwin) os="darwin" ;;
    *) fail "unsupported operating system: $(uname -s). Use WSL2 or the Windows installer." ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
}

# Verifies one "<digest>  <name>" line against the file in the given directory.
verify_line() {
  local line="$1" dir="$2"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$dir" && printf '%s\n' "$line" | sha256sum -c --status -)
  else
    (cd "$dir" && printf '%s\n' "$line" | shasum -a 256 -c --status -)
  fi
}

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

ensure_node() {
  local major archive url line
  major="$(node_major)"
  if [ "${major:-0}" -ge 22 ] 2>/dev/null; then
    log "using existing Node.js $(node -v)"
    NODE_BIN="$(command -v node)"
    return
  fi
  [ "${major:-0}" -eq 0 ] && log "Node.js not found" || log "Node.js $(node -v) is too old"
  os_and_arch
  archive="node-v${NODE_VERSION}-${os}-${arch}.tar.gz"
  url="https://nodejs.org/dist/v${NODE_VERSION}/${archive}"
  mkdir -p "$RUNTIME_DIR"
  log "downloading Node.js v${NODE_VERSION} (${os}-${arch})"
  DOWNLOAD "$url" "$RUNTIME_DIR/$archive"
  DOWNLOAD "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" "$RUNTIME_DIR/SHASUMS256.txt"
  line="$(grep " ${archive}\$" "$RUNTIME_DIR/SHASUMS256.txt")"
  [ -n "$line" ] || fail "Node checksum entry not found for $archive"
  verify_line "$line" "$RUNTIME_DIR" || fail "Node.js download failed checksum verification"
  tar -xzf "$RUNTIME_DIR/$archive" -C "$RUNTIME_DIR"
  rm -f "$RUNTIME_DIR/$archive" "$RUNTIME_DIR/SHASUMS256.txt"
  NODE_BIN="$RUNTIME_DIR/node-v${NODE_VERSION}-${os}-${arch}/bin/node"
  [ -x "$NODE_BIN" ] || fail "downloaded Node.js binary is missing"
  export PATH="$(dirname "$NODE_BIN"):$PATH"
  log "installed Node.js $("$NODE_BIN" -v) into $RUNTIME_DIR"
}

resolve_version() {
  local payload
  if [ -n "${PATCHPROOF_VERSION:-}" ]; then
    RELEASE_TAG="$PATCHPROOF_VERSION"
  else
    log "resolving the latest release"
    payload="$(curl -fsSL "https://api.github.com/repos/${PATCHPROOF_REPO}/releases/latest" 2>/dev/null ||
      wget -qO- "https://api.github.com/repos/${PATCHPROOF_REPO}/releases/latest" 2>/dev/null)" ||
      fail "cannot reach GitHub releases; set PATCHPROOF_VERSION=<tag> and retry"
    RELEASE_TAG="$(printf '%s' "$payload" | grep -o '"tag_name": *"[^"]*"' | head -n1 | sed 's/.*"\(v[^"]*\)".*/\1/')"
  fi
  [ -n "${RELEASE_TAG:-}" ] || fail "could not determine a release tag"
  VERSION="${RELEASE_TAG#v}"
  log "installing PatchProof ${RELEASE_TAG}"
}

download_release() {
  local base line
  mkdir -p "$LIB_DIR" "$BIN_DIR"
  base="https://github.com/${PATCHPROOF_REPO}/releases/download/${RELEASE_TAG}"
  log "downloading patchproof-${VERSION}.tgz"
  DOWNLOAD "$base/patchproof-${VERSION}.tgz" "$LIB_DIR/patchproof.tgz"
  DOWNLOAD "$base/SHA256SUMS" "$LIB_DIR/SHA256SUMS"
  line="$(grep " patchproof-${VERSION}\.tgz\$" "$LIB_DIR/SHA256SUMS")"
  [ -n "$line" ] || fail "checksum entry not found for patchproof-${VERSION}.tgz"
  verify_line "$line" "$LIB_DIR" || fail "PatchProof download failed checksum verification"
  tar -xzf "$LIB_DIR/patchproof.tgz" -C "$LIB_DIR"
  [ -f "$LIB_DIR/package/bin/patchproof.js" ] || fail "release archive has an unexpected layout"
  mv "$LIB_DIR/package/bin/patchproof.js" "$LIB_DIR/patchproof.js"
  rm -rf "$LIB_DIR/package" "$LIB_DIR/patchproof.tgz" "$LIB_DIR/SHA256SUMS"
}

write_launcher() {
  cat >"$BIN_DIR/patchproof" <<LAUNCHER
#!/usr/bin/env bash
exec "\${PATCHPROOF_NODE:-$NODE_BIN}" "$LIB_DIR/patchproof.js" "\$@"
LAUNCHER
  chmod +x "$BIN_DIR/patchproof"
}

persist_path() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) return ;;
  esac
  export PATH="$BIN_DIR:$PATH"
  local profile candidate
  profile=""
  for candidate in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ -e "$candidate" ] && grep -q 'patchproof PATH' "$candidate" 2>/dev/null; then
      return
    fi
    if [ -e "$candidate" ] || [ "$candidate" = "$HOME/.profile" ]; then
      profile="$candidate"
      break
    fi
  done
  if [ -n "$profile" ]; then
    printf '\n# patchproof PATH\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >>"$profile"
    log "added $BIN_DIR to PATH via $profile (open a new shell to pick it up)"
  else
    log "add this to your shell profile: export PATH=\"$BIN_DIR:\$PATH\""
  fi
}

main() {
  need_download
  ensure_node
  resolve_version
  download_release
  write_launcher
  persist_path
  log "verifying the installation"
  set +e
  patchproof setup --check
  local check_status=$?
  set -e
  printf '\nPatchProof is installed.\n'
  if [ "$check_status" -ne 0 ]; then
    log "environment check reported problems above; fix them, then run: patchproof setup --demo"
  else
    printf 'Next steps:\n  patchproof setup --demo        # prove the full pipeline in ~30 seconds\n  patchproof init <directory>    # start your own scenario\n  patchproof --help              # all commands\n'
  fi
}

main "$@"
