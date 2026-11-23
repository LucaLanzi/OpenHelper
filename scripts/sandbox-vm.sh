#!/usr/bin/env bash
# sandbox-vm.sh — set up the sandbox generated code runs in (`make sandbox-vm`).
#
#   macOS: a Lima VM ("openhelper") with containerd, plus the sandbox image built inside it
#   Linux: the sandbox image built with Podman or Docker
# Then it offers to switch this machine's platform file to that sandbox, and smoke-tests it
# with the network off. Idempotent: run it again to rebuild the image.
#
# Options (environment):
#   YES=1          no questions
#   VM_NAME=openhelper  VM_CPUS=4  VM_MEMORY=3  VM_DISK=30   (GiB; macOS only)
#   STOP=1         stop the VM (frees its memory for a model) and exit

# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"

VM="${VM_NAME:-openhelper}"
IMAGE="openhelper-sandbox:latest"

ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
b() { printf '\033[1m%s\033[0m\n' "$*"; }

vm_status() { limactl list --format '{{.Status}}' "$VM" 2>/dev/null || true; }

# Set [sandbox] driver in this machine's platform file, keeping everything else.
set_driver() {  # set_driver <driver>
    local self pf
    self="$(sed -n 's/^self *= *"\(.*\)"/\1/p' "$OH_WS/config.toml" 2>/dev/null | head -n1)"
    pf="$OH_WS/platforms/$self.toml"
    if [ -z "$self" ] || [ ! -f "$pf" ]; then
        warn "no workspace yet; after make setup, set [sandbox] driver = \"$1\" in your platform file"
        return
    fi
    if grep -Eq "^driver *= *\"$1\"" "$pf"; then ok "$pf already uses the $1 sandbox"; return; fi
    if confirm "Use the $1 sandbox for checks on this machine (edits [sandbox] driver in $pf)?"; then
        awk -v d="$1" '
            /^\[/ { insec = ($0 == "[sandbox]") }
            insec && /^driver *=/ { print "driver = \"" d "\""; next }
            { print }
        ' "$pf" > "$pf.tmp" && mv "$pf.tmp" "$pf"
        grep -q '^\[sandbox\]' "$pf" || printf '\n[sandbox]\ndriver = "%s"\n' "$1" >> "$pf"
        ok "set driver = \"$1\" in $pf (restart the engine to use it)"
    fi
}

smoke_opts=()
smoke() {  # smoke <command prefix...>: run a container with no network and check the tools
    "$@" run --rm --network none ${smoke_opts[@]+"${smoke_opts[@]}"} "$IMAGE" sh -c \
        'python3 -m pytest --version >/dev/null && cmake --version | head -n1 && node -v && shellcheck --version | sed -n 2p && (getent hosts example.com >/dev/null && echo "NETWORK REACHABLE" || echo "network: off")'
}

macos() {
    have limactl || die "Lima is not installed; run make prereqs (or: brew install lima)"
    if [ -n "${STOP:-}" ]; then
        limactl stop "$VM" && ok "stopped the $VM VM"
        exit 0
    fi

    b "1/4 Lima VM \"$VM\""
    st="$(vm_status)"
    if [ -z "$st" ]; then
        echo "  Creates a Linux VM: ${VM_CPUS:-4} CPUs, ${VM_MEMORY:-3} GiB memory, ${VM_DISK:-30} GiB disk (grows as used)."
        echo "  Your home folder is mounted into it, writable, so it can reach worktrees and repos."
        confirm "Create it now?" || die "cancelled"
        args=(--name="$VM" --tty=false --mount-writable --cpus="${VM_CPUS:-4}" --memory="${VM_MEMORY:-3}" --disk="${VM_DISK:-30}")
        # Lima 1.x+ spells templates "template:default"; older releases use "template://default".
        limactl create "${args[@]}" template:default 2>/dev/null || limactl create "${args[@]}" template://default
        ok "created"
        st=Stopped
    fi
    if [ "$st" != "Running" ]; then
        limactl start "$VM" >/dev/null
        ok "started"
    else
        ok "running"
    fi

    b "2/4 containerd inside the VM"
    # Lima's default VM runs containerd rootless (plain nerdctl); a VM set up with system
    # containerd needs sudo. The engine detects the same way.
    if limactl shell "$VM" -- nerdctl info >/dev/null 2>&1; then
        nerdctl=(nerdctl)
    elif limactl shell "$VM" -- sudo nerdctl info >/dev/null 2>&1; then
        nerdctl=(sudo nerdctl)
    else
        die "nerdctl is not working inside the VM; recreate it with: limactl delete -f $VM && make sandbox-vm"
    fi
    ok "${nerdctl[*]} works"
    if [ "${nerdctl[0]}" = sudo ]; then
        "$OH_ROOT/scripts/lima-apparmor.sh" "$VM"
        smoke_opts=(--security-opt apparmor=openhelper-sandbox)
    fi

    b "3/4 Sandbox image"
    # The repo is under your home folder, which Lima mounts at the same path.
    limactl shell "$VM" -- "${nerdctl[@]}" build -t "$IMAGE" "$OH_ROOT/sandbox"
    ok "built $IMAGE"

    b "4/4 Smoke test (network off)"
    out="$(smoke limactl shell "$VM" -- "${nerdctl[@]}")"
    printf '%s\n' "$out" | sed 's/^/  /'
    printf '%s' "$out" | grep -q "NETWORK REACHABLE" && die "the sandbox can reach the network; not using it"
    ok "sandbox works with the network off"
    set_driver lima
    echo "  Tip: the VM holds up to ${VM_MEMORY:-3} GiB. Stop it when you need the memory for a model: make sandbox-vm STOP=1"
}

linux() {
    if have podman; then rt=podman; elif have docker; then rt=docker; else die "no Podman or Docker; run make prereqs"; fi
    b "1/2 Sandbox image ($rt)"
    "$rt" build -t "$IMAGE" "$OH_ROOT/sandbox"
    ok "built $IMAGE"
    b "2/2 Smoke test (network off)"
    out="$(smoke "$rt")"
    printf '%s\n' "$out" | sed 's/^/  /'
    printf '%s' "$out" | grep -q "NETWORK REACHABLE" && die "the sandbox can reach the network; not using it"
    ok "sandbox works with the network off"
    set_driver "$rt"
}

case "$(os_name)" in
    macos) macos ;;
    linux) linux ;;
    *) die "unsupported OS" ;;
esac
