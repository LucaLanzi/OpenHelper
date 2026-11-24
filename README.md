# OpenHelper

A coding assistant that runs on your own machines with an open-weight model. It answers from your repos and docs with citations, makes changes on a separate branch, and checks them in a sandbox with no network.

**v0.0.1** is tested on an M1 Pro MacBook (32 GB) with Qwen3-8B, and not yet on Linux, larger models or two machines. On that Mac it generates 25 tokens/s, passed 5 of 5 small single-file evals and 0 of 5 harder multi-file ones. "Checked" means the repo's own checks passed, not that the change is right, so read every diff. [Full results](docs/results/2026-11-23-mac-qwen3-8b.md).

## Install

Needs macOS on Apple Silicon (Ubuntu with an NVIDIA GPU is untested), 16 GB of memory and 15 GB of disk.

```bash
git clone https://github.com/LucaLanzi/OpenHelper.git
cd OpenHelper
make install
```

This installs everything, starts OpenHelper and opens the dashboard, already signed in. The **Setup** page then takes you through downloading the model (5.7 GB), setting up the sandbox and adding a repo.

To open the dashboard later, go to <http://127.0.0.1:8740> or run `make open`. `workspace/` holds your private data and is never committed.

## Add a repo

On the **Projects** page, choose the repo's folder and press **Add repo**. OpenHelper detects its languages, fetches their docs and builds the search index. Press **Rebuild index** after large changes.

Some docs, like `cppreference`, must be downloaded by hand from [their site](https://en.cppreference.com/w/Cppreference:Archives). Add the `.zip`, `.tar.*` or folder on the **Library** page, then rebuild the index.

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

Create `workspace/packs/languages/rust.toml`:

```toml
id = "rust"
name = "Rust"
detect = ["Cargo.toml"]
source_globs = ["**/*.rs"]

[[checks]]
id = "test"
name = "cargo test"
kind = "test"              # syntax, build, test, lint or static
run = "cargo test --offline"
requires = ["cargo"]
```

Add the toolchain to `sandbox/Dockerfile`, run `make sandbox-vm`, and add `"rust"` to `languages` in `workspace/projects/<project>.toml`. Checks run with no network.

## Swap models

Pick any downloaded model on the **Platforms** page. To add a new one, create `workspace/packs/models/my-model-q4km.toml`:

```toml
id = "my-model-q4km"
name = "My Model"
family = "my-family"
kind = "dense"             # or "moe"
params_b = 8
active_params_b = 8
quant = "Q4_K_M"
size_gb = 5
roles = ["main"]
license = "apache-2.0"
min_usable_gb = 8
server_args = ["--jinja"]

[source]
hf_repo = "owner/repo-GGUF"
filename = "my-model-Q4_K_M.gguf"
```

Add its id to `allowed` in your platform file, then:

```bash
make download-model ID=my-model-q4km
make llama-swap-config
make install-service
```

On a Mac, models over about 20 GB also need `make mac-gpu-limit`.

## Copy weights to another machine

GGUF files work on macOS and Linux. After `make install` on the other machine:

```bash
# On the machine with the files. The last two lines copy a project's search index.
rsync -avP workspace/models/Qwen3-8B-Q4_K_M.gguf other:OpenHelper/workspace/models/
rsync -av workspace/projects/my-repo.toml other:OpenHelper/workspace/projects/
rsync -av workspace/index/my-repo/ other:OpenHelper/workspace/index/my-repo/

# On the other machine. Check the printed hash matches `shasum -a 256` on the first.
node server/dist/cli.js models pin qwen3-8b-q4km --file workspace/models/Qwen3-8B-Q4_K_M.gguf
make llama-swap-config
make install-service
```

An index needs the same embedding model on both machines. If the repo path differs, update `repos` in the project file. Never copy `workspace/secrets/`. OpenHelper has no training command yet.

## Update

```bash
git pull && make build && make install-service
```

## More

[Setup](docs/SETUP.md) · [Packs](docs/PACKS.md) · [Sandbox](docs/SANDBOX.md) · [Editors](docs/HARNESS.md) · [Architecture](docs/ARCHITECTURE.md) · [Verification](docs/VERIFY-ON-HARDWARE.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

MIT license. Models and doc packs have their own licenses.
