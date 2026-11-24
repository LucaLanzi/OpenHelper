#!/usr/bin/env bash
# Shared helpers for OpenHelper's setup scripts. Source it; do not run it.

set -euo pipefail

OH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export OH_ROOT
OH_WS="${OPENHELPER_WORKSPACE:-$OH_ROOT/workspace}"
export OH_WS

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# confirm "question" — returns 0 for yes. OH_YES=1 answers yes (unattended runs).
confirm() {
    if [ "${OH_YES:-0}" = "1" ]; then return 0; fi
    local reply
    read -r -p "$1 [y/N] " reply
    case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

os_name() {
    case "$(uname -s)" in
        Linux) echo linux ;;
        Darwin) echo macos ;;
        *) echo other ;;
    esac
}

arch_name() {
    case "$(uname -m)" in
        x86_64|amd64) echo amd64 ;;
        arm64|aarch64) echo arm64 ;;
        *) uname -m ;;
    esac
}

have() { command -v "$1" >/dev/null 2>&1; }

# True inside Windows Subsystem for Linux, where OpenHelper runs as on Linux.
is_wsl() { [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qsi microsoft /proc/sys/kernel/osrelease; }

cpu_count() {
    getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1
}

# Memory free for a build, in whole GB. Linux: MemAvailable. macOS: total memory minus 4 GB,
# since macOS keeps most memory in caches and reports little as free.
free_mem_gb() {
    local kb bytes
    if kb="$(awk '/^MemAvailable:/ {print $2; exit}' /proc/meminfo 2>/dev/null)" && [ -n "$kb" ]; then
        echo $((kb / 1024 / 1024))
    elif bytes="$(sysctl -n hw.memsize 2>/dev/null)" && [ -n "$bytes" ]; then
        echo $((bytes / 1024 / 1024 / 1024 - 4))
    else
        echo 4
    fi
}

# build_jobs_for <cpus> <free GB> <GB per job> — parallel compile jobs that fit in memory,
# keeping 4 GB for the desktop. Between 1 and <cpus>.
build_jobs_for() {
    local jobs=$((($2 - 4) / $3))
    [ "$jobs" -le "$1" ] || jobs="$1"
    [ "$jobs" -ge 1 ] || jobs=1
    echo "$jobs"
}

# build_jobs <GB per job> — how many compile jobs to run on this machine. JOBS=<n> overrides.
# An unbounded `-j` runs one compiler per source file and can exhaust memory (CUDA's take GBs each).
build_jobs() {
    if [ -n "${JOBS:-}" ]; then echo "$JOBS"; return; fi
    build_jobs_for "$(cpu_count)" "$(free_mem_gb)" "$1"
}

# Use a new enough Node.js even when an older one comes first on the PATH.
if _oh_node_dir="$("$OH_ROOT/scripts/find-node.sh" 2>/dev/null)"; then
    PATH="$_oh_node_dir:$PATH"
    export PATH
fi
unset _oh_node_dir

# Read KEY from versions.lock.
lock_get() {
    grep -E "^$1=" "$OH_ROOT/versions.lock" | head -n1 | cut -d= -f2-
}

# Newest llama.cpp release tag in a clone. Piping `git tag` into head dies of SIGPIPE under pipefail.
newest_release_tag() {
    git -C "$1" for-each-ref --count=1 --sort=-v:refname --format='%(refname:short)' 'refs/tags/b[0-9]*'
}

# Which nerdctl a Lima VM uses: plain (rootless) or sudo (system containerd). The image decides,
# as in the engine, because `nerdctl info` can succeed on a VM whose containers live under sudo.
lima_nerdctl() {  # lima_nerdctl <vm> <image>
    local n
    for n in "nerdctl image inspect $2" "sudo nerdctl image inspect $2" "nerdctl info" "sudo nerdctl info"; do
        # shellcheck disable=SC2086  # each entry is a command line
        if limactl shell "$1" -- $n >/dev/null 2>&1 </dev/null; then
            case "$n" in sudo*) echo "sudo nerdctl" ;; *) echo nerdctl ;; esac
            return 0
        fi
    done
    return 1
}

# Record what setup actually built, so the next machine can reproduce it.
record() {
    mkdir -p "$OH_WS"
    local f="$OH_WS/versions.recorded"
    touch "$f"
    grep -v -E "^$1=" "$f" > "$f.tmp" || true
    printf '%s=%s\n' "$1" "$2" >> "$f.tmp"
    mv "$f.tmp" "$f"
}

oh() {
    if [ -f "$OH_ROOT/server/dist/cli.js" ]; then
        node "$OH_ROOT/server/dist/cli.js" "$@"
    else
        (cd "$OH_ROOT/server" && npx --no-install tsx src/cli.ts "$@")
    fi
}
