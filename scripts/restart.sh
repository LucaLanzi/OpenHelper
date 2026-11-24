#!/usr/bin/env bash
# Restarts the model server and engine. The dashboard's System page runs this.

# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"

case "$(os_name)" in
    macos)
        launchctl kickstart -k "gui/$(id -u)/dev.openhelper.llm"
        launchctl kickstart -k "gui/$(id -u)/dev.openhelper.engine"
        ;;
    linux) systemctl --user restart openhelper-llm.service openhelper.service ;;
    *) die "unsupported OS" ;;
esac
