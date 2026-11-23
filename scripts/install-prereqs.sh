#!/usr/bin/env bash
# install-prereqs.sh — install everything OpenHelper needs on this machine (`make prereqs`;
# `make install` runs this and then `make setup`).
#
# Runs as your normal user and asks for sudo only for system packages. Idempotent: run it
# again any time; anything already installed is left alone.
#
#   1. build tools: git, cmake, a C/C++ compiler, curl (Linux: apt; macOS: Xcode CLT + Homebrew)
#   2. Node.js 22 (Linux: official tarball into ~/.local, checksum verified; macOS: Homebrew)
#   3. GPU toolkit: CUDA when an NVIDIA GPU is present (Linux); Metal needs nothing (macOS)
#   4. the tools the language-pack checks use: pytest, ruff, mypy, shellcheck, cppcheck,
#      clang-tidy, bats
#   5. optional: a container runtime for the sandbox (Podman on Linux, Lima on macOS)
#
# Options (environment):
#   YES=1            accept every default and every optional step, no questions
#   SKIP_APT=1       don't install system packages (Linux) / Homebrew packages (macOS)
#   SKIP_CUDA=1      don't install the CUDA toolkit
#   SKIP_SANDBOX=1   don't install a sandbox runtime
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
NODE_MAJOR="$(grep -E '^NODE_MAJOR=' "$here/versions.lock" | cut -d= -f2)"
NODE_MAJOR="${NODE_MAJOR:-22}"

b() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
yesno() {  # yesno <question> <default y|n>
    local a
    if [[ -n "${YES:-}" ]]; then return 0; fi
    if [[ ! -t 0 ]]; then [[ "$2" == y ]]; return; fi
    read -r -p "  $1 [$([[ $2 == y ]] && echo Y/n || echo y/N)]: " a </dev/tty || true
    a="${a:-$2}"
    [[ "$a" =~ ^[Yy] ]]
}
have() { command -v "$1" >/dev/null 2>&1; }

if [[ $EUID -eq 0 ]]; then die "run this as your normal user (it asks for sudo when it needs it)"; fi

os="$(uname -s)"
arch="$(uname -m)"
missing_after=()

# ---------------------------------------------------------------------------- helpers: Linux
apt_install() {  # apt_install <why> <pkg>...
    local why="$1"
    shift
    local need=()
    for p in "$@"; do dpkg -s "$p" >/dev/null 2>&1 || need+=("$p"); done
    if [[ ${#need[@]} -eq 0 ]]; then
        ok "$why: already installed"
        return
    fi
    if [[ -n "${SKIP_APT:-}" ]]; then
        warn "$why: missing ${need[*]} (SKIP_APT=1: not installing)"
        missing_after+=("${need[@]}")
        return
    fi
    echo "  $why needs: ${need[*]}"
    sudo apt-get install -y --no-install-recommends "${need[@]}"
    ok "$why: installed ${need[*]}"
}

node_major() { have node && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

install_node_linux() {
    local a
    case "$arch" in x86_64) a=x64 ;; aarch64|arm64) a=arm64 ;; *) die "no Node.js build for $arch" ;; esac
    local base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
    local sums file sha tmp
    sums="$(curl -fsSL "$base/SHASUMS256.txt")" || die "could not reach nodejs.org"
    file="$(printf '%s\n' "$sums" | awk -v a="linux-$a.tar.xz" '$2 ~ a"$" {print $2; exit}')"
    sha="$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f {print $1; exit}')"
    [[ -n "$file" && -n "$sha" ]] || die "could not find the Node.js $NODE_MAJOR download for linux-$a"
    tmp="$(mktemp -d)"
    echo "  downloading $file"
    curl -fsSL "$base/$file" -o "$tmp/$file"
    echo "$sha  $tmp/$file" | sha256sum -c --quiet - || die "Node.js download failed its checksum; not installing"
    mkdir -p "$HOME/.local/opt" "$HOME/.local/bin"
    rm -rf "$HOME/.local/opt/${file%.tar.xz}"
    tar -xJf "$tmp/$file" -C "$HOME/.local/opt"
    for bin in node npm npx; do ln -sf "$HOME/.local/opt/${file%.tar.xz}/bin/$bin" "$HOME/.local/bin/$bin"; done
    rm -rf "$tmp"
    ok "Node.js $("$HOME/.local/bin/node" -v) in ~/.local (no sudo needed)"
}

ensure_local_bin_on_path() {
    case ":$PATH:" in *":$HOME/.local/bin:"*) return ;; esac
    export PATH="$HOME/.local/bin:$PATH"
    local rc="$HOME/.bashrc"
    [[ "$(basename "${SHELL:-bash}")" == zsh ]] && rc="$HOME/.zshrc"
    if grep -qs 'HOME/.local/bin' "$rc"; then return; fi
    if yesno "Add ~/.local/bin to your PATH in $rc?" y; then
        # shellcheck disable=SC2016  # written literally, expanded when the shell starts
        printf '\n# Added by OpenHelper (make prereqs)\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"
        ok "added ~/.local/bin to PATH in $rc (open a new terminal, or: source $rc)"
    else
        warn "add ~/.local/bin to your PATH yourself"
    fi
}

pipx_tool() {  # pipx_tool <command> <package>
    if have "$1"; then ok "$1: already installed"; return; fi
    if ! have pipx; then warn "$1: pipx is missing, so not installed"; missing_after+=("$1"); return; fi
    if pipx install "$2" >/dev/null 2>&1; then
        ok "$1: installed with pipx"
    else
        warn "$1: pipx install $2 failed"
        missing_after+=("$1")
    fi
}

# ---------------------------------------------------------------------------- Linux
linux() {
    have apt-get || die "this installer supports Ubuntu/Debian (apt). On other distributions install: git cmake gcc g++ make curl python3 pipx nodejs>=$NODE_MAJOR shellcheck cppcheck clang-tidy bats"
    . /etc/os-release 2>/dev/null || true
    ok "${PRETTY_NAME:-Linux} ($arch)"
    if [[ -z "${SKIP_APT:-}" ]]; then
        echo "  updating the package list (sudo)"
        sudo apt-get update -qq
    fi

    b "1/5 Build tools"
    apt_install "build tools" git cmake build-essential pkg-config curl ca-certificates xz-utils unzip

    b "2/5 Node.js $NODE_MAJOR"
    if [[ "$(node_major)" -ge "$NODE_MAJOR" ]]; then
        ok "Node.js $(node -v): already installed"
    else
        [[ "$(node_major)" -gt 0 ]] && warn "found Node.js $(node -v), which is older than $NODE_MAJOR"
        install_node_linux
    fi
    ensure_local_bin_on_path

    b "3/5 GPU toolkit"
    if have nvidia-smi && nvidia-smi -L >/dev/null 2>&1; then
        ok "NVIDIA GPU: $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -n1)"
        if have nvcc || [[ -x /usr/local/cuda/bin/nvcc ]]; then
            ok "CUDA toolkit: already installed"
        elif [[ -n "${SKIP_CUDA:-}" ]]; then
            warn "CUDA toolkit missing (SKIP_CUDA=1); llama.cpp would build for CPU only"
            missing_after+=(nvidia-cuda-toolkit)
        elif yesno "Install the CUDA toolkit (Ubuntu's nvidia-cuda-toolkit, about 4 GB)?" y; then
            apt_install "CUDA toolkit" nvidia-cuda-toolkit
        else
            missing_after+=(nvidia-cuda-toolkit)
        fi
    elif lspci 2>/dev/null | grep -qi nvidia; then
        warn "an NVIDIA GPU is present but its driver is not working (nvidia-smi failed)."
        warn "Install the driver first:  sudo ubuntu-drivers install  then reboot and run make prereqs again."
        missing_after+=(nvidia-driver)
    else
        ok "no NVIDIA GPU: llama.cpp will build for the CPU"
    fi

    b "4/5 Tools the checks use"
    apt_install "check tools" python3 python3-venv python3-pytest pipx shellcheck cppcheck clang-tidy bats
    have pipx && pipx ensurepath >/dev/null 2>&1 || true
    pipx_tool ruff ruff
    pipx_tool mypy mypy
    pipx_tool cmake-lint cmakelang

    b "5/5 Sandbox for running generated code (optional)"
    if have podman || have docker; then
        ok "$(have podman && echo podman || echo docker): already installed; build the image with make sandbox-image"
    elif [[ -n "${SKIP_SANDBOX:-}" ]]; then
        warn "no sandbox runtime (SKIP_SANDBOX=1); generated code will never run automatically"
    elif yesno "Install Podman so generated code can run in a sandbox with no network?" y; then
        apt_install "sandbox" podman
        echo "  next: make sandbox-image, then set [sandbox] driver = \"podman\" in your platform file"
    else
        warn "skipped; generated code will never run automatically"
    fi
}

# ---------------------------------------------------------------------------- macOS
brew_install() {  # brew_install <why> <formula>...
    local why="$1"
    shift
    local need=()
    for f in "$@"; do brew list --formula "$f" >/dev/null 2>&1 || need+=("$f"); done
    if [[ ${#need[@]} -eq 0 ]]; then ok "$why: already installed"; return; fi
    if [[ -n "${SKIP_APT:-}" ]]; then
        warn "$why: missing ${need[*]} (SKIP_APT=1: not installing)"
        missing_after+=("${need[@]}")
        return
    fi
    brew install "${need[@]}"
    ok "$why: installed ${need[*]}"
}

macos() {
    ok "macOS $(sw_vers -productVersion) ($arch)"
    [[ "$arch" == arm64 ]] || warn "this is an Intel Mac; there is no Metal acceleration for llama.cpp here"

    b "1/5 Build tools"
    if xcode-select -p >/dev/null 2>&1; then
        ok "Xcode Command Line Tools: installed"
    else
        echo "  opening the installer for the Xcode Command Line Tools; finish it, then run make prereqs again"
        xcode-select --install || true
        exit 1
    fi
    if ! have brew; then
        for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do [[ -x "$p" ]] && eval "$("$p" shellenv)"; done
    fi
    if ! have brew; then
        if yesno "Homebrew is missing. Install it with its official installer (https://brew.sh)?" y; then
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
        else
            die "Homebrew is needed for the rest; install it from https://brew.sh and run make prereqs again"
        fi
    fi
    brew_install "build tools" git cmake

    b "2/5 Node.js $NODE_MAJOR"
    if [[ "$(node_major)" -ge "$NODE_MAJOR" ]]; then
        ok "Node.js $(node -v): already installed"
    else
        brew_install "Node.js" "node@$NODE_MAJOR"
        local nb
        nb="$(brew --prefix "node@$NODE_MAJOR")/bin"
        export PATH="$nb:$PATH"
        local rc="$HOME/.zprofile"
        if ! grep -qs "node@$NODE_MAJOR" "$rc" && yesno "Add Node.js $NODE_MAJOR to your PATH in $rc?" y; then
            # shellcheck disable=SC2016  # $PATH is written literally, expanded when the shell starts
            printf '\n# Added by OpenHelper (make prereqs)\nexport PATH="%s:$PATH"\n' "$nb" >> "$rc"
            ok "added $nb to PATH in $rc (open a new terminal)"
        fi
    fi

    b "3/5 GPU toolkit"
    ok "Metal is part of macOS; nothing to install"

    b "4/5 Tools the checks use"
    brew_install "check tools" python pipx shellcheck cppcheck llvm bats-core
    if ! have clang-tidy && [[ -x "$(brew --prefix llvm)/bin/clang-tidy" ]]; then
        mkdir -p "$HOME/.local/bin"
        ln -sf "$(brew --prefix llvm)/bin/clang-tidy" "$HOME/.local/bin/clang-tidy"
        ok "linked clang-tidy into ~/.local/bin (Homebrew keeps llvm off the PATH)"
    fi
    ensure_local_bin_on_path
    pipx_tool pytest pytest
    pipx_tool ruff ruff
    pipx_tool mypy mypy
    pipx_tool cmake-lint cmakelang

    b "5/5 Sandbox for running generated code (optional)"
    if have limactl; then
        ok "Lima: already installed; see docs/SANDBOX.md to create the VM"
    elif [[ -n "${SKIP_SANDBOX:-}" ]]; then
        warn "no sandbox runtime (SKIP_SANDBOX=1); generated code will never run automatically"
    elif yesno "Install Lima so generated code can run in a Linux VM with no network?" y; then
        brew_install "sandbox" lima
        echo "  next: create the VM as described in docs/SANDBOX.md"
    else
        warn "skipped; generated code will never run automatically"
    fi
}

case "$os" in
    Linux) linux ;;
    Darwin) macos ;;
    *) die "unsupported OS: $os" ;;
esac

echo
if [[ ${#missing_after[@]} -gt 0 ]]; then
    b "Done, but still missing: ${missing_after[*]}"
    echo "  make setup will tell you if any of these block it."
else
    b "All prerequisites are installed."
fi
