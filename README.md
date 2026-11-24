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

## Save battery

OpenHelper turns its heavy parts off by itself when you aren't using it:

- **Models** unload after `unload_after_min` minutes with no requests (20 on a Mac, 30 on a desktop; set it under `[resources]` in the platform file).
- **The sandbox VM** stops once no dashboard has been open and no job has run for the same number of minutes. The next job starts it again, so that job takes a little longer to begin.

What keeps running is the engine and the model server's small proxy, which use almost nothing while idle.

To turn everything off now, press **Turn off OpenHelper** on the **System** page, or run `./openhelper stop`. Turn it back on with `./openhelper start`, which also opens the dashboard. It also starts again the next time you log in.

## Add a language

On the **Library** page, enter its name, file extensions and test command under **Add a language**. Then press **Detect languages** on the project.

If the sandbox doesn't have the language's tools, add them to `sandbox/Dockerfile` and press **Rebuild sandbox** on the **System** page. Until then, its checks show as skipped.

## Swap models

On the **Models** page, press **Use as main**, **Use as light** or **Benchmark** on any downloaded model. That sets the machine's defaults. To change the models for one project only, see [Search and embeddings](#search-and-embeddings).

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

## Search and embeddings

Before the model answers, OpenHelper searches the project's index for passages from your repos and docs. A project uses one of two search modes:

- **Keyword:** finds passages that share words with the question. Builds fast and needs no extra model.
- **Hybrid:** keywords plus embeddings, which also find passages that say the same thing in other words. It gives better answers to vague questions, but every passage has to go through the embedding model first. That is the slow part of building an index.

### Change a project's models

On **Projects**, press **Models and embeddings** in the project's panel. Choose the main model, light model, search mode and embedding model, then press **Save models and search**. Nothing else about the project changes.

| You change | Takes effect | Affects |
|---|---|---|
| Main or light model | The next job | Answer speed and quality. Not the index or its build time. |
| Search mode | After **Rebuild index** | Build time, and how well search finds passages |
| Embedding model | After **Rebuild index** | Build time, and how well search finds passages |

Until you rebuild, the project keeps searching with its current index. The panel says when the index was built with a different embedding model than the one you chose.

### What a rebuild costs

- **Same embedding model:** only new or changed passages are embedded. The rest come from the cache.
- **New embedding model:** every passage is embedded again, as slowly as a first build. Embeddings from different models can't be mixed.
- **Back to a model you used before:** fast. Each embedding model keeps its own cache in `workspace/cache/embeddings/<model>.bin`, shared by all projects.
- **Hybrid to keyword:** fast, nothing is embedded. Going back to hybrid reuses the cache.

**Rebuild index** shows an estimate before it starts, based on this machine's past builds with that embedding model.

### Choosing an embedding model

An embedding model only works if it is downloaded on the **Models** page and this machine's model server offers it. A downloaded model is offered unless the platform file lists `allowed` models without it. Press **Use for search** to make it the machine's default, or pick it per project as above. If the model can't be reached, the build still finishes, but keyword-only, and the job log says `embeddings failed`.

A smaller embedding model builds faster. A larger one may find better passages. To try another, paste its `.gguf` link under **Add a model** with the role set to embedding, download it, choose it for the project, rebuild, and compare answers with **Ask**. Switching back costs nothing, since the old model's cache stays.

### Faster indexing

- **Embed on the faster machine** and import the result (below).
- **Exclude what you never ask about:** generated code, vendored dependencies, large fixtures. Edit `exclude` in `projects/<name>.toml` under **Settings**, then rebuild.
- **Pick only the docs you need.** Doc packs are often most of the passages. They are cached, so a second project with the same docs builds fast.
- **Use keyword search** where hybrid isn't worth the wait.

To get faster answers rather than faster builds, use a smaller main or light model. On a Mac, also lower `retrieval_top_k` in `config.toml`, which sends the model fewer passages.

### Embed on one machine, use on another

You can run the embeddings on the machine with the faster GPU and move them to the other. Both machines need the same embedding model. The repo can be at a different path on each.

1. On the fast machine, choose hybrid search and the embedding model in **Models and embeddings**, save, then press **Rebuild index**.
2. Press **Export embeddings**. It writes `workspace/exports/<project>-embeddings-<date>.ohemb.gz` on that machine and shows the full path and an `scp` command.
3. Copy the file over, for example `scp desktop:OpenHelper/workspace/exports/my-repo-embeddings-2026-11-24.ohemb.gz ~/`.
4. On the other machine, choose the same embedding model in the same panel. Enter the file's path under **Embeddings file to import**, press **Import embeddings**, then confirm the index build. It embeds only passages that changed since the export.

From a terminal: `./openhelper embeddings export PROJECT` (add `--out FILE` to write it somewhere else) and `./openhelper embeddings import FILE`, then `./openhelper index PROJECT`. Import needs a browser on the machine itself, because it reads a file there.

## Connect another machine

On the **Platforms** page, open **Connect another OpenHelper instance with Tailscale**. Enter the other machine's Tailscale name or IP (`tailscale ip -4` prints it), press **Check this address**, then save it with the name of the secret that holds its token. Any OS or hardware works. Agent hooks only allow the operations ticked for that machine, and only where a link allows it.

To open a dashboard from another device instead, see [From another device (Tailscale)](docs/SETUP.md#from-another-device-tailscale).

## Update

Press **Update** on the **System** page.

## More

[Setup](docs/SETUP.md) · [Upgrading](docs/UPGRADING.md) · [Packs](docs/PACKS.md) · [Sandbox](docs/SANDBOX.md) · [Editors](docs/HARNESS.md) · [Architecture](docs/ARCHITECTURE.md) · [Verification](docs/VERIFY-ON-HARDWARE.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

MIT license. Models and doc packs have their own licenses.
