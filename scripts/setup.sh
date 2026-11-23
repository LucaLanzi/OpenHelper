#!/usr/bin/env bash
# make setup PROFILE=auto|desktop|mac|cpu
#
# Builds the pinned llama.cpp for this machine's backend, installs llama-swap and the
# engine, creates the workspace and prints the plan. It never downloads a model without
# asking, and never changes system settings without asking.

# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"

PROFILE="${1:-auto}"
OS="$(os_name)"
ARCH="$(arch_name)"
VENDOR="$OH_ROOT/vendor"
mkdir -p "$VENDOR"

if [ "$PROFILE" = "auto" ]; then
    if [ "$OS" = "macos" ]; then PROFILE=mac
    elif have nvidia-smi; then PROFILE=desktop
    else PROFILE=cpu
    fi
fi
log "profile: $PROFILE ($OS/$ARCH)"

# --- prerequisites ----------------------------------------------------------------------
missing=()
for b in git cmake make node npm; do have "$b" || missing+=("$b"); done
if [ "$OS" = "macos" ]; then
    xcode-select -p >/dev/null 2>&1 || missing+=("xcode-command-line-tools")
else
    have c++ || missing+=("c++ (build-essential)")
fi
if [ "${#missing[@]}" -gt 0 ]; then
    die "missing: ${missing[*]}. Run \`make prereqs\` (or \`make install\`, which does it all)."
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge "$(lock_get NODE_MAJOR)" ] || die "Node.js $(lock_get NODE_MAJOR)+ required (found $(node -v)); run \`make prereqs\`"

if [ "$PROFILE" = "desktop" ]; then
    have nvcc || [ -x /usr/local/cuda/bin/nvcc ] || die "CUDA toolkit not found (nvcc). Run \`make prereqs\`, or use PROFILE=cpu."
    export PATH="/usr/local/cuda/bin:$PATH"
fi

# --- llama.cpp ----------------------------------------------------------------------------
LLAMA_DIR="$VENDOR/llama.cpp"
ref="$(lock_get LLAMA_CPP_REF)"
if [ ! -d "$LLAMA_DIR/.git" ]; then
    log "cloning llama.cpp"
    git clone --filter=blob:none "$(lock_get LLAMA_CPP_REPO)" "$LLAMA_DIR"
fi
git -C "$LLAMA_DIR" fetch --tags --quiet
if [ "$ref" = "pending" ]; then
    ref="$(git -C "$LLAMA_DIR" tag --list 'b[0-9]*' --sort=-v:refname | head -n1)"
    warn "versions.lock has no llama.cpp pin yet; using newest tag $ref (run \`make pin\` after verifying)"
fi
git -C "$LLAMA_DIR" checkout --quiet "$ref"
record LLAMA_CPP_REF "$(git -C "$LLAMA_DIR" rev-parse HEAD)"

cmake_args=(-DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF)
case "$PROFILE" in
    desktop) cmake_args+=(-DGGML_CUDA=ON) ;;   # 2080 Ti is compute capability 7.5
    mac)     cmake_args+=(-DGGML_METAL=ON) ;;
    cpu)     ;;
esac
log "building llama.cpp ($ref) with: ${cmake_args[*]}"
cmake -S "$LLAMA_DIR" -B "$LLAMA_DIR/build" "${cmake_args[@]}"
cmake --build "$LLAMA_DIR/build" -j --target llama-server llama-bench llama-cli
LLAMA_SERVER="$LLAMA_DIR/build/bin/llama-server"
[ -x "$LLAMA_SERVER" ] || die "llama-server was not built"

# --- llama-swap ----------------------------------------------------------------------------
SWAP_BIN="$VENDOR/bin/llama-swap"
if [ ! -x "$SWAP_BIN" ]; then
    mkdir -p "$VENDOR/bin"
    ver="$(lock_get LLAMA_SWAP_VERSION)"
    repo="$(lock_get LLAMA_SWAP_REPO)"
    if [ "$ver" = "pending" ]; then
        ver="$(curl -fsSL "https://api.github.com/repos/${repo#https://github.com/}/releases/latest" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1)"
        [ -n "$ver" ] || die "could not find the latest llama-swap release; set LLAMA_SWAP_VERSION in versions.lock"
        warn "versions.lock has no llama-swap pin yet; using $ver"
    fi
    osn="$OS"; [ "$OS" = "macos" ] && osn=darwin
    url="$repo/releases/download/v$ver/llama-swap_${ver}_${osn}_${ARCH}.tar.gz"
    log "downloading llama-swap $ver"
    tmp="$(mktemp -d)"
    if curl -fsSL "$url" -o "$tmp/ls.tgz"; then
        tar -xzf "$tmp/ls.tgz" -C "$tmp"
        install -m 0755 "$tmp/llama-swap" "$SWAP_BIN"
    else
        die "could not download $url. Get llama-swap from $repo/releases and put it at $SWAP_BIN"
    fi
    rm -rf "$tmp"
    record LLAMA_SWAP_VERSION "$ver"
fi

# --- engine ------------------------------------------------------------------------------
log "installing and building the engine"
(cd "$OH_ROOT" && npm ci --no-audit --no-fund && npm run build)

# --- workspace -----------------------------------------------------------------------------
if [ ! -f "$OH_WS/config.toml" ]; then
    name="${OH_PLATFORM:-}"
    if [ -z "$name" ]; then
        if [ "$PROFILE" = "mac" ]; then name=mac; else name=desktop; fi
    fi
    oh init --platform "$name"
fi
oh detect >/dev/null
oh llama-swap-config --server "$LLAMA_SERVER"

if [ "$OS" = "macos" ]; then
    "$OH_ROOT/scripts/mac-gpu-limit.sh" --check || true
fi

log "plan for this machine:"
oh plan
cat <<MSG

Next steps
  1. Download the models in the plan:   make download-model ID=<model id>
  2. Start the model server and engine:  make install-service   (or: make serve)
  3. Open the dashboard:                 http://127.0.0.1:8740  (token: make token)
  4. Add a project:                      make add-project REPO=~/code/your-repo
MSG
