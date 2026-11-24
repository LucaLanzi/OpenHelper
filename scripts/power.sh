#!/usr/bin/env bash
# Turns the model server and engine services off or on: `scripts/power.sh off|on`.
# `./openhelper stop|start` and the System page run this; they stop the sandbox VM first.
# The services start again at the next login, as before.

# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"

action="${1:-}"
case "$action" in on|off) ;; *) die "usage: scripts/power.sh on|off" ;; esac

case "$(os_name)" in
    macos)
        for name in dev.openhelper.llm dev.openhelper.engine; do
            plist="$HOME/Library/LaunchAgents/$name.plist"
            [ -f "$plist" ] || die "$name is not installed; run scripts/install-service.sh"
            if [ "$action" = off ]; then
                launchctl bootout "gui/$(id -u)/$name" 2>/dev/null || true
            else
                # Already loaded is fine.
                launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl kickstart "gui/$(id -u)/$name"
            fi
        done
        ;;
    linux)
        # One call: stopping the engine's own unit from inside it must not cut the request short.
        if [ "$action" = off ]; then systemctl --user stop openhelper.service openhelper-llm.service
        else systemctl --user start openhelper-llm.service openhelper.service; fi
        ;;
    *) die "unsupported OS" ;;
esac
log "OpenHelper is $action"
