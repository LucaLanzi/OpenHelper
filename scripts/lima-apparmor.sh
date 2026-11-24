#!/usr/bin/env bash
# lima-apparmor.sh [VM] — install the AppArmor profile sandbox containers run under in the Lima VM.
# It is nerdctl's default profile plus one rule. Newer kernels label containers
# nerdctl-default//&unconfined, so the default's "signals amongst themselves" rule stops matching
# and test runners cannot stop their own workers.

# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"

vm="${1:-openhelper}"
limactl shell "$vm" -- sudo sh -s <<'EOF'
set -e
nerdctl apparmor inspect |
    sed -e 's/nerdctl-default/openhelper-sandbox/g' \
        -e '/^profile /a\  signal (send,receive) peer="openhelper-sandbox//&unconfined",' \
    > /etc/apparmor.d/openhelper-sandbox
grep -q '^profile openhelper-sandbox ' /etc/apparmor.d/openhelper-sandbox
apparmor_parser -r /etc/apparmor.d/openhelper-sandbox
EOF
log "AppArmor profile openhelper-sandbox loaded in $vm"
