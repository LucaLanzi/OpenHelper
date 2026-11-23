# The sandbox

Generated code is built, tested and linted inside a sandbox with networking off. Only the worktree is mounted read-write; the packs and (for `node_modules` links) the source repo are read-only. `auto_run = true` in a platform file is refused unless a sandbox driver is set.

## Quick setup

```bash
make sandbox-vm
```

On macOS this creates a Lima VM named `openhelper` (4 CPUs, 3 GiB memory, your home folder mounted writable), builds the sandbox image inside it, checks that a container has no network, and offers to switch your platform file to `driver = "lima"`. On Linux it builds the image with Podman or Docker and does the same. Stop the VM to free its memory for a model with `make sandbox-vm STOP=1`. Sizes: `VM_CPUS`, `VM_MEMORY`, `VM_DISK`.

The sections below are what it does, if you'd rather do it by hand.

## Linux: Docker or Podman

```bash
make sandbox-image
```

Then in `workspace/platforms/<name>.toml`:

```toml
[sandbox]
driver = "podman"    # or "docker"
image = "openhelper-sandbox:latest"
```

Check it: `node server/dist/cli.js check ~/code/some-repo --sandbox podman`.

The image (`sandbox/Dockerfile`) has GCC, Clang, clang-tidy, cppcheck, CMake, Python with pytest, ruff and mypy, shellcheck, bats and Node.js 22. Add your project's own toolchains there, for example F´'s `fprime-util`.

## macOS: Lima

```bash
brew install lima
limactl create --name=openhelper --tty=false --mount-writable --cpus=4 --memory=3 template:default
limactl start openhelper
limactl shell openhelper -- nerdctl build -t openhelper-sandbox:latest "$PWD/sandbox"
```

Lima's default template runs containerd rootless, so `nerdctl` runs without `sudo`. A VM created with system containerd instead (`--set '.containerd.system = true | .containerd.user = false'`) also works: OpenHelper detects which one the VM has and uses `sudo nerdctl` there. System containerd applies AppArmor, and its default profile stops test runners from signalling their own workers on current Ubuntu kernels, so `make sandbox-vm` also installs a profile called `openhelper-sandbox` (nerdctl's default plus that one rule) with `scripts/lima-apparmor.sh`, and OpenHelper runs containers under it.

The worktrees live under `workspace/worktrees/`, which must be inside a writable Lima mount (your home folder is, with `--mount-writable`). Then:

```toml
[sandbox]
driver = "lima"
vm = "openhelper"
image = "openhelper-sandbox:latest"
```

The VM takes about 5–10 GB of disk and some memory while running; stop it with `limactl stop openhelper` when you need the RAM for a model.

## No sandbox (`driver = "none"`)

Checks run directly on the machine. On Linux, OpenHelper still drops network access with `unshare -rn` where user namespaces allow it. Automatic running stays off; you start every job yourself.
