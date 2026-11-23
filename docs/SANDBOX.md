# The sandbox

Generated code is built, tested and linted inside a sandbox with networking off. Only the worktree is mounted read-write; the packs and (for `node_modules` links) the source repo are read-only. `auto_run = true` in a platform file is refused unless a sandbox driver is set.

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
limactl create --name=openhelper --mount-writable template://default
limactl start openhelper
limactl shell openhelper -- sudo nerdctl build -t openhelper-sandbox:latest - < sandbox/Dockerfile
```

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
