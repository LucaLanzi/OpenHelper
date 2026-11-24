#!/usr/bin/env bash
# Records the llama.cpp and llama-swap versions setup used into versions.lock.

# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"

[ -f "$OH_WS/versions.recorded" ] || die "run scripts/setup.sh first"
while IFS='=' read -r k v; do
    sed -i.bak "s#^$k=.*#$k=$v#" "$OH_ROOT/versions.lock"
done < "$OH_WS/versions.recorded"
rm -f "$OH_ROOT/versions.lock.bak"
git -C "$OH_ROOT" --no-pager diff --stat -- versions.lock || true
