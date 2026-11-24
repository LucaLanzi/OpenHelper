# Setting up OpenHelper

This guide covers one machine, then adding a second, then reaching the dashboard from your phone.

## Before you start

`./openhelper install` installs everything in this table for you (Ubuntu/Debian with apt, or macOS with Homebrew), asking before each optional or large item. On Windows, run it inside WSL2 with Ubuntu, which takes the Linux column; the NVIDIA driver comes from Windows, and the services need systemd (`[boot] systemd=true` in `/etc/wsl.conf`). To install only the packages, run `scripts/install-prereqs.sh`. Options: `YES=1` (no questions), `SKIP_APT=1`, `SKIP_CUDA=1`, `SKIP_SANDBOX=1`, and `JOBS=<n>` for the llama.cpp build (by default as many compile jobs as free memory allows, about 3 GB each for CUDA).

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
./openhelper install
```

`./openhelper install` first installs the packages above (it never installs GPU drivers; if `nvidia-smi` fails it tells you to run `sudo ubuntu-drivers install`). Then it runs `scripts/setup.sh`, which picks a profile (`desktop` with an NVIDIA GPU, `mac` on Apple Silicon, `cpu` otherwise), builds llama.cpp and llama-swap, builds the engine, creates `workspace/` and prints a plan like:

```
Usable model memory: 35 GB  →  tier M (reference baseline: 2080 Ti desktop, 32 GB M1 Mac)
  main      qwen3.6-35b-a3b-q4km  (22 GB, moe)
  light     qwen3-8b-q4km  (5 GB, dense)
  reviewer  gemma-4-26b-a4b-q4km  (16 GB, moe)
  embed     qwen3-embedding-0.6b-q8  (0.7 GB, dense)
Download: 43.7 GB   Disk needed (with 20% margin): 82 GB
```

It then starts llama-swap and the engine as user services and opens the dashboard with a one-time sign-in link. The **Setup** page downloads Qwen3-8B and the embedding model, sets up the sandbox and adds your first repo. `./openhelper open` opens it again; from another device, sign in with `./openhelper token`.

For a larger model than the Setup page offers:

```bash
scripts/download-model.sh qwen3.6-35b-a3b-q4km   # asks first; pins the file's SHA-256
scripts/tune.sh qwen3.6-35b-a3b-q4km             # NVIDIA + MoE only: find how many expert layers fit in VRAM
```

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

Override with `./openhelper plan --tier S`. On machines that split a model between GPU and RAM, MoE models are preferred, because only their active experts are read for each token.

## Adding projects

```bash
./openhelper add-project ~/code/fprime-billee
./openhelper docs list
./openhelper docs fetch cmake                       # repeat for each doc pack the project lists
./openhelper docs add-local cppreference ~/Downloads/html-book.zip   # packs you download by hand
./openhelper index fprime-billee
./openhelper embeddings export fprime-billee   # copy the file to another machine, then there:
./openhelper embeddings import FILE            # and rebuild its index; see README, "Search and embeddings"
./openhelper mine-evals fprime-billee          # eval tasks from your git history
```

Then choose **Run the eval** on the dashboard's Jobs page.

## A second machine

On the second machine, run the same `scripts/setup.sh`. Then, so both machines know about each other:

1. Copy the other machine's platform file into each workspace (`workspace/platforms/`), and set its `url` to the address the other machine can reach, for example its Tailscale name.
2. Put each other machine's token in `workspace/secrets/peers.toml` on the machine that runs the dashboard:
   ```toml
   mac = "<output of ./openhelper token on the Mac>"
   ```
3. Keep `projects/` and `links.toml` the same on both machines (a private git repo of your workspace config works well; never include `secrets/`).
4. Point the workflow aliases in `config.toml` at the machines: `plan = "mac"`, `build = "desktop"`.
5. Add a link in Settings → `links.toml`, for example a two-way link between `mac` and `desktop`. Until you do, the machines are isolated and cross-machine workflows are refused.

A machine that only runs agents can set `roles = ["node"]` in its `config.toml`.

## From another device (Tailscale)

To open a machine's dashboard from your phone, laptop or another computer:

1. Install Tailscale on both devices and sign in to the same tailnet.
2. In `workspace/config.toml` on the machine running OpenHelper, set `bind` to its Tailscale IP (`tailscale ip -4`). Never use `0.0.0.0`; the engine refuses it.
3. Restart the engine (Linux: `systemctl --user restart openhelper`; macOS: `launchctl kickstart -k gui/$(id -u)/dev.openhelper.engine`).
4. On the other device, open `http://<tailscale-ip>:8740` (or the MagicDNS name) and sign in with the token from `./openhelper token`. `./openhelper open` now prints this address instead of opening a browser.

From another device you can use and manage models, change a project's models and search, and export its embeddings. A few actions still need a browser on the machine itself: the Setup page, adding or removing projects, doc packs, languages and platforms, importing embeddings, and restart, update or turn off. The desktop's own Tailscale address counts as local, so `http://<tailscale-ip>:8740` works there too.

If Tailscale's coordination service is down, devices that are already connected usually keep working. As a fallback on your home network, bind to the desktop's LAN IP instead.

## Updating

```bash
git pull && npm run build && systemctl --user restart openhelper                      # Linux
git pull && npm run build && launchctl kickstart -k gui/$(id -u)/dev.openhelper.engine  # macOS
```

Pinned versions in `versions.lock` only change when you change them. After a successful run on new versions, `scripts/pin.sh` records exactly what was built.
