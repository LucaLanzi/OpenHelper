# Setting up OpenHelper

This guide covers one machine, then adding a second, then reaching the dashboard from your phone.

## Before you start

`make install` installs everything in this table for you (Ubuntu/Debian with apt, or macOS with Homebrew), asking before each optional or large item. To install only the packages, run `make prereqs`. Options: `YES=1` (no questions), `SKIP_APT=1`, `SKIP_CUDA=1`, `SKIP_SANDBOX=1`.

| | Linux (desktop) | macOS (Apple Silicon) |
| --- | --- | --- |
| Packages | `git cmake build-essential curl` | Xcode Command Line Tools, `brew install cmake node@22` |
| Node.js | 22 or newer | 22 or newer |
| GPU | NVIDIA driver + CUDA toolkit 12 (`nvcc`) | Metal is built in |
| Sandbox (recommended) | Docker or Podman | Lima (`brew install lima`) |
| Disk | see the plan; about 60–95 GB on the reference desktop | about 50–70 GB on the reference Mac |

## One machine

```bash
git clone https://github.com/LucaLanzi/OpenHelper.git && cd OpenHelper
make install
```

`make install` first installs the packages above (it never installs GPU drivers; if `nvidia-smi` fails it tells you to run `sudo ubuntu-drivers install`). Then it runs `make setup`, which picks a profile (`desktop` with an NVIDIA GPU, `mac` on Apple Silicon, `cpu` otherwise), builds llama.cpp and llama-swap, builds the engine, creates `workspace/` and prints a plan like:

```
Usable model memory: 35 GB  →  tier M (reference baseline: 2080 Ti desktop, 32 GB M1 Mac)
  main      qwen3.6-35b-a3b-q4km  (22 GB, moe)
  light     qwen3-8b-q4km  (5 GB, dense)
  reviewer  gemma-4-26b-a4b-q4km  (16 GB, moe)
  embed     qwen3-embedding-0.6b-q8  (0.7 GB, dense)
Download: 43.7 GB   Disk needed (with 20% margin): 82 GB
```

Then:

```bash
make download-model ID=qwen3.6-35b-a3b-q4km   # asks first; pins the file's SHA-256
make tune ID=qwen3.6-35b-a3b-q4km             # NVIDIA + MoE only: find how many expert layers fit in VRAM
make install-service                          # llama-swap + engine as user services
make token                                    # for the dashboard login
```

Open http://127.0.0.1:8740 and paste the token.

### Memory tiers

Setup computes usable model memory, then picks the largest model in the registry that fits with a KV cache:

- NVIDIA GPU: VRAM plus system RAM, minus 8 GB for the OS, engine and sandbox.
- Apple Silicon: unified memory minus 8 GB.
- CPU only: RAM minus 8 GB.

| Tier | Usable memory | Default main model |
| --- | --- | --- |
| XS | under 12 GB | 7–9B dense at Q4 |
| S | 12–20 GB | ~14B dense, or a small MoE backed by RAM |
| M | 20–40 GB | 35B-A3B MoE at Q4 (the reference machines) |
| L | 40–80 GB | the same MoE at Q8, reviewer loaded alongside |
| XL | 80 GB and up | a larger MoE from the registry |

Override with `make plan TIER=S`. On machines that split a model between GPU and RAM, MoE models are preferred, because only their active experts are read for each token.

## Adding projects

```bash
make add-project REPO=~/code/fprime-billee
make docs-list
make docs-fetch ID=cmake                       # repeat for each doc pack the project lists
make docs-add ID=cppreference FILE=~/Downloads/html-book.zip   # packs you download by hand
make index PROJECT=fprime-billee
make mine-evals PROJECT=fprime-billee          # eval tasks from your git history
```

Then choose **Run the eval** on the dashboard's Jobs page.

## A second machine

On the second machine, run the same `make setup`. Then, so both machines know about each other:

1. Copy the other machine's platform file into each workspace (`workspace/platforms/`), and set its `url` to the address the other machine can reach, for example its Tailscale name.
2. Put each other machine's token in `workspace/secrets/peers.toml` on the machine that runs the dashboard:
   ```toml
   mac = "<output of make token on the Mac>"
   ```
3. Keep `projects/` and `links.toml` the same on both machines (a private git repo of your workspace config works well; never include `secrets/`).
4. Point the workflow aliases in `config.toml` at the machines: `plan = "mac"`, `build = "desktop"`.
5. Add a link in Settings → `links.toml`, for example a two-way link between `mac` and `desktop`. Until you do, the machines are isolated and cross-machine workflows are refused.

A machine that only runs agents can set `roles = ["node"]` in its `config.toml`.

## From your phone

1. Install Tailscale on the desktop and the phone.
2. In `workspace/config.toml` on the desktop, set `bind` to the desktop's Tailscale IP (`tailscale ip -4`).
3. `systemctl --user restart openhelper`, then open `http://<tailscale-ip>:8740` on the phone.

If Tailscale's coordination service is down, devices that are already connected usually keep working. As a fallback on your home network, bind to the desktop's LAN IP instead.

## Updating

```bash
git pull && make build && systemctl --user restart openhelper   # or relaunch the launchd agent on macOS
```

Pinned versions in `versions.lock` only change when you change them. After a successful run on new versions, `make pin` records exactly what was built.
