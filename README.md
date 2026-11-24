# OpenHelper

A coding assistant that runs on your own machines with an open-weight model. It answers from your repos and docs with citations, makes changes on a separate branch, and checks them in a sandbox with no network.

**v0.0.1** is tested on an M1 Pro MacBook (32 GB) with Qwen3-8B, and not yet on Linux, larger models or two machines. On that Mac it generates 25 tokens/s, passed 5 of 5 small single-file evals and 0 of 5 harder multi-file ones. "Checked" means the repo's own checks passed, not that the change is right, so read every diff. [Full results](docs/results/2026-11-23-mac-qwen3-8b.md).

## Install

| | Supported | Before you start |
| --- | --- | --- |
| macOS | Apple Silicon | Nothing. The installer opens the Xcode tools installer and offers Homebrew. |
| Linux | Ubuntu or Debian, NVIDIA GPU optional | For the GPU, `nvidia-smi` must already work. The CUDA toolkit is installed for you. |
| Windows | WSL2 with Ubuntu (`wsl --install`) | NVIDIA driver installed in Windows. Clone inside WSL (`~`), not `/mnt/c`. |

Every machine needs 16 GB of memory and 15 GB of free disk. Only macOS has been tested so far.

```bash
git clone https://github.com/LucaLanzi/OpenHelper.git
cd OpenHelper
./openhelper install
```

Run it as your normal user. It asks for `sudo` only to install system packages, and asks before large or optional ones. It builds llama.cpp, installs the engine as a user service and opens the dashboard, already signed in. The **Setup** page then downloads the model (5.7 GB), sets up the sandbox and adds a repo.

Options, set before the command, for example `JOBS=4 ./openhelper install`:

- `JOBS=<n>`: compile jobs for llama.cpp. By default it runs as many as free memory allows. Lower it if the build runs out of memory.
- `PROFILE=cpu`: build without GPU support.
- `YES=1`: answer yes to every question. `SKIP_APT=1`, `SKIP_CUDA=1` and `SKIP_SANDBOX=1` skip those installs.

On WSL, the services need systemd. If the installer says it is off, add `[boot]` and `systemd=true` to `/etc/wsl.conf`, then run `wsl --shutdown` in Windows and run the installer again.

To open the dashboard later, go to <http://127.0.0.1:8740>, or run `./openhelper open` if it asks you to sign in. `workspace/` holds your private data and is never committed. Full details: [docs/SETUP.md](docs/SETUP.md).

## Add a project

A project is one or more repos plus the docs and search settings used for them. On the **Projects** page, the setup steps ask for the repos, show the languages found and let you pick their checks, then the docs, the models, the machine that runs the work and the search mode. Nothing is saved until you press **Confirm and create project** on the review screen. That screen also shows how long the first index build will probably take. Press **Rebuild index** after large changes. A rebuild only embeds the parts that changed.

Some docs, like `cppreference`, must be downloaded by hand from [their site](https://en.cppreference.com/w/Cppreference:Archives). Add the `.zip`, `.tar.*` or folder on the **Library** page, then rebuild the index. Docs are shared by every project on the machine.

**Remove project** in a project's panel lists what will be deleted first: its config, search index, evals and results. Your repos, shared docs, models, job logs and audit history stay.

## Use it

- **Ask:** pick a project and ask a question.
- **Workflows:** run `implement-feature` with a small task that names the files. Approve the plan, read the review, then merge the branch yourself:

  ```bash
  git diff main...openhelper/<branch>
  git merge openhelper/<branch>
  ```

- **Evals:** on the **Projects** page, press **Mine eval tasks**, then **Run eval**. It replays past commits with their tests hidden.

The sandbox VM starts by itself when a job needs it. To free its memory, press **Stop** on the **Platforms** page.

## Add a language

On the **Library** page, enter its name, file extensions and test command under **Add a language**. Then press **Detect languages** on the project.

If the sandbox doesn't have the language's tools, add them to `sandbox/Dockerfile` and press **Rebuild sandbox** on the **System** page. Until then, its checks show as skipped.

## Swap models

On the **Models** page, press **Use as main**, **Use as light** or **Benchmark** on any downloaded model.

To free disk space, press **Delete file** on a model this machine isn't using. It stays on the list, so you can download it again.

To add one, paste a direct link to its `.gguf` file under **Add a model**, then press **Download**. Models over about 20 GB on a Mac also need one terminal command, because it asks for your password: `scripts/mac-gpu-limit.sh`.

## Copy weights to another machine

GGUF files work on macOS and Linux. After `./openhelper install` on the other machine:

```bash
# On the machine with the files. The last two lines copy a project's search index.
rsync -avP workspace/models/Qwen3-8B-Q4_K_M.gguf other:OpenHelper/workspace/models/
rsync -av workspace/projects/my-repo.toml other:OpenHelper/workspace/projects/
rsync -av workspace/index/my-repo/ other:OpenHelper/workspace/index/my-repo/

# On the other machine. Check the printed hash matches `shasum -a 256` on the first.
./openhelper models pin qwen3-8b-q4km --file workspace/models/Qwen3-8B-Q4_K_M.gguf
```

Then press **Use as main** on its **Models** page. An index needs the same embedding model on both machines. If the repo path differs, update `repos` under **Settings**. Never copy `workspace/secrets/`. OpenHelper has no training command yet.

## Embed on one machine, use on another

Embeddings are the slow part of an index. You can run them on the machine with the faster GPU and move them to the other machine. Both machines need the same embedding model, and the repo can be at a different path on each.

1. On the fast machine, open **Projects** → **Models and embeddings**, choose hybrid search and the embedding model, save, then rebuild the index.
2. Press **Export embeddings**. It writes `workspace/exports/<project>-embeddings-<date>.ohemb.gz` and shows the `scp` command.
3. On the other machine, open the same panel, choose the same embedding model, enter the file under **Embeddings file to import**, and press **Import embeddings**. It then offers the index rebuild, which embeds only chunks that changed since the export.

From a terminal: `./openhelper embeddings export PROJECT [--out FILE]` and `./openhelper embeddings import FILE`, then `./openhelper index PROJECT`.

The same panel changes a project's main, light and embedding models at any time. The index keeps using its old embeddings until you rebuild it.

## Connect another machine

On the **Platforms** page, open **Connect another OpenHelper instance with Tailscale**. Enter the other machine's Tailscale name or IP (`tailscale ip -4` prints it), press **Check this address**, then save it with the name of the secret that holds its token. Any OS or hardware works. Agent hooks only allow the operations ticked for that machine, and only where a link allows it.

## Update

Press **Update** on the **System** page.

## More

[Setup](docs/SETUP.md) · [Upgrading](docs/UPGRADING.md) · [Packs](docs/PACKS.md) · [Sandbox](docs/SANDBOX.md) · [Editors](docs/HARNESS.md) · [Architecture](docs/ARCHITECTURE.md) · [Verification](docs/VERIFY-ON-HARDWARE.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

MIT license. Models and doc packs have their own licenses.
