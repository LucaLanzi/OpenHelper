#!/usr/bin/env bash
# find-node.sh [MIN_MAJOR] — print the bin directory of a Node.js >= MIN_MAJOR (default from
# versions.lock), or exit 1. Used by the Makefile and setup scripts, so OpenHelper uses a new
# enough Node.js even when an older one comes first on your PATH (nvm, Homebrew node@20, apt).

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
min="${1:-$(grep -E '^NODE_MAJOR=' "$here/versions.lock" 2>/dev/null | cut -d= -f2)}"
min="${min:-22}"

major_of() {  # major_of <node binary> -> major version, or 0
    "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

candidates=()
if command -v node >/dev/null 2>&1; then candidates+=("$(dirname "$(command -v node)")"); fi
# Every other node on the PATH, in order.
IFS=: read -r -a path_dirs <<< "$PATH"
for d in "${path_dirs[@]}"; do [ -n "$d" ] && [ -x "$d/node" ] && candidates+=("$d"); done
candidates+=("$HOME/.local/bin" /usr/local/bin /usr/bin)
for prefix in /opt/homebrew /usr/local; do
    candidates+=("$prefix/opt/node@$min/bin")
    for d in "$prefix"/opt/node@*/bin; do [ -d "$d" ] && candidates+=("$d"); done
    candidates+=("$prefix/opt/node/bin")
done
for d in "$HOME"/.nvm/versions/node/v*/bin "$HOME"/.local/opt/node-v*/bin; do [ -d "$d" ] && candidates+=("$d"); done

best=""
best_major=0
for d in "${candidates[@]}"; do
    [ -x "$d/node" ] || continue
    m="$(major_of "$d/node")"
    if [ "$m" -ge "$min" ] && [ "$m" -gt "$best_major" ]; then
        best="$d"
        best_major="$m"
    fi
    # The first suitable one on the PATH wins, so we don't override a deliberate choice.
    if [ "$d" = "${candidates[0]}" ] && [ "$m" -ge "$min" ]; then
        echo "$d"
        exit 0
    fi
done
[ -n "$best" ] || exit 1
echo "$best"
