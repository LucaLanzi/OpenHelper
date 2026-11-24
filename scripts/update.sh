#!/usr/bin/env bash
# Updates this checkout to the latest commit on its branch, rebuilds and restarts the services.
# The dashboard's System page runs this.

# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"

cd "$OH_ROOT"
[ -z "$(git status --porcelain)" ] || die "this checkout has local changes; commit or stash them first"
before="$(git rev-parse HEAD)"
git pull --ff-only
after="$(git rev-parse HEAD)"
if [ "$before" = "$after" ]; then
    log "already up to date"
    exit 0
fi
if git diff --quiet "$before" "$after" -- versions.lock; then
    npm ci --no-audit --no-fund
    npm run build
else
    # A new pin means a new llama.cpp or llama-swap build.
    "$OH_ROOT/scripts/setup.sh" auto
fi
log "updated to $(git rev-parse --short HEAD); restarting"
if git diff --quiet "$before" "$after" -- templates; then
    "$OH_ROOT/scripts/restart.sh"
else
    "$OH_ROOT/scripts/install-service.sh"
fi
