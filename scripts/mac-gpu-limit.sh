#!/usr/bin/env bash
# Show, and optionally raise, macOS's limit on GPU-wired memory (iogpu.wired_limit_mb).
# Large models on a 32 GB Mac need more than the default. The setting resets on reboot.

# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"

[ "$(os_name)" = "macos" ] || exit 0
total_mb=$(( $(sysctl -n hw.memsize) / 1024 / 1024 ))
current=$(sysctl -n iogpu.wired_limit_mb 2>/dev/null || echo 0)
# Leave 8 GB for macOS and apps.
target=$(( total_mb - 8192 ))

echo "Unified memory: ${total_mb} MB; GPU wired limit: ${current} MB (0 means the macOS default, about two thirds)"
if [ "${1:-}" = "--check" ]; then
    [ "$current" -ge "$target" ] || echo "Run \`scripts/mac-gpu-limit.sh\` before loading models over ~20 GB."
    exit 0
fi
echo "Raising it to ${target} MB needs sudo and lasts until the next reboot."
confirm "Raise the limit now?" || exit 0
sudo sysctl "iogpu.wired_limit_mb=$target"
