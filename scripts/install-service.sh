#!/usr/bin/env bash
# make install-service
# Installs two user services: llama-swap (model server, localhost only) and openhelper
# (engine + dashboard). systemd --user on Linux, launchd on macOS.

# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"

SWAP="$OH_ROOT/vendor/bin/llama-swap"
[ -x "$SWAP" ] || die "llama-swap not installed; run make setup"
[ -f "$OH_ROOT/server/dist/cli.js" ] || die "engine not built; run make build"
[ -f "$OH_WS/llama-swap.yaml" ] || oh llama-swap-config
NODE="$(command -v node)"
port="$(sed -n 's/^llm_url *= *"http:\/\/127.0.0.1:\([0-9]*\)".*/\1/p' "$OH_WS/config.toml")"
port="${port:-8741}"

render() {
    sed -e "s#@ROOT@#$OH_ROOT#g" -e "s#@WS@#$OH_WS#g" -e "s#@NODE@#$NODE#g" -e "s#@SWAP@#$SWAP#g" -e "s#@PORT@#$port#g" "$1"
}

case "$(os_name)" in
    linux)
        dir="$HOME/.config/systemd/user"
        mkdir -p "$dir"
        render "$OH_ROOT/templates/systemd/openhelper-llm.service" > "$dir/openhelper-llm.service"
        render "$OH_ROOT/templates/systemd/openhelper.service" > "$dir/openhelper.service"
        systemctl --user daemon-reload
        systemctl --user enable --now openhelper-llm.service openhelper.service
        log "services running. Logs: journalctl --user -u openhelper -f"
        echo "To keep them running while you are logged out: sudo loginctl enable-linger \"$USER\""
        ;;
    macos)
        dir="$HOME/Library/LaunchAgents"
        mkdir -p "$dir" "$OH_WS/logs"
        for name in dev.openhelper.llm dev.openhelper.engine; do
            render "$OH_ROOT/templates/launchd/$name.plist" > "$dir/$name.plist"
            launchctl bootout "gui/$(id -u)" "$dir/$name.plist" 2>/dev/null || true
            launchctl bootstrap "gui/$(id -u)" "$dir/$name.plist"
        done
        log "services running. Logs: $OH_WS/logs/"
        ;;
    *) die "unsupported OS" ;;
esac
