# OpenHelper

A coding assistant that runs on your own machines with an open-weight model. It indexes your repos and docs, answers with citations, plans and makes changes on a separate branch, and checks them in a sandbox with the network off.

**v0.0.1 status.** Run end to end on an M1 Pro MacBook (32 GB) with Qwen3-8B on 2026-11-23. Not yet run on Linux, with larger models, or across two real machines.

| Measured on that Mac | Result |
| --- | --- |
| Generation speed | 25 tokens/s |
| Prompt speed | 202–225 tokens/s |
| Question with citations | about 20 s |
| Plan, implement and review a small two-file change | about 4 min |
| Eval on small single-file tasks | 5 of 5 passed |
| Eval on harder multi-file tasks in this repo | 0 of 5 passed |

The 8B model is useful for questions and small changes. **"Checked" means the repo's own checks passed, not that the change is right**, so read every diff.

## Requirements

- macOS on Apple Silicon, or Ubuntu 24.04 with an NVIDIA GPU (not yet tested)
- 16 GB of memory or more for the 8B model
- About 15 GB of free disk for the 8B setup and sandbox

`make install` installs the rest: build tools, Node.js 22, check tools and Lima or Podman. It never installs GPU drivers.

## 1. Install

```bash
git clone https://github.com/LucaLanzi/OpenHelper.git
cd OpenHelper
make install
```

This builds llama.cpp and the engine, creates `workspace/` and prints a plan for your hardware. `workspace/` holds your private data and is never committed.

## 2. Download a model

```bash
make download-model ID=qwen3-8b-q4km \
  URL=https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf
make download-model ID=qwen3-embedding-0.6b-q8 \
  URL=https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf
```

Each file's SHA-256 is recorded when it first downloads. Then set the models in `workspace/platforms/<machine>.toml` (`mac` on a Mac):

```toml
[model]
current = "qwen3-8b-q4km"
light = "qwen3-8b-q4km"
embed = "qwen3-embedding-0.6b-q8"
```

```bash
make llama-swap-config
```

## 3. Set up the sandbox

```bash
make sandbox-vm
```

This creates the Lima VM on macOS (or builds the image with Podman or Docker on Linux) and offers to turn the sandbox on. Stop the VM to free memory with `make sandbox-vm STOP=1`. See [docs/SANDBOX.md](docs/SANDBOX.md).

## 4. Start the services and open the dashboard

```bash
make install-service
curl http://127.0.0.1:8740/api/health
make token
```

Open <http://127.0.0.1:8740> and paste the token. Logs are in `workspace/logs/`.

## 5. Add a repo

```bash
make add-project REPO=~/code/my-repo    # prints the doc packs it suggests
make docs-fetch ID=python-stdlib        # repeat for each suggested pack
make index PROJECT=my-repo
```

`cppreference` can't be fetched automatically. Download the HTML book from its [archives page](https://en.cppreference.com/w/Cppreference:Archives), then add it and rebuild the index:

```bash
make docs-add ID=cppreference FILE=~/Downloads/html-book.zip    # a .zip, .tar.* or folder
make index PROJECT=my-repo
```

Re-run `make index` after large changes to the repo. Your checkout is never edited: work happens in separate worktrees.

## 6. Ask a question

On the **Ask** page, pick the project and ask. Answers cite passages like `S1`, listed under the answer.

## 7. Make a change

1. On **Workflows**, run `implement-feature` with a small, specific task. Name the files.
2. Read and edit the plan, then approve it.
3. The model edits a new branch and runs the checks in the sandbox, repairing failures up to twice.
4. Read the review and approve or reject it.
5. Inspect the branch and merge it yourself:

```bash
git diff main...openhelper/<branch>
git merge openhelper/<branch>
```

## 8. Measure a model on your code

```bash
make mine-evals PROJECT=my-repo LIMIT=5
```

Skim `workspace/evals/my-repo/tasks.jsonl`, then run the eval from the **Jobs** page ("Run the eval"). It replays past commits with their tests hidden and reports the pass rate. Results are in `workspace/results/my-repo/`.

## Add a language pack

Create `workspace/packs/languages/rust.toml`:

```toml
id = "rust"
name = "Rust"
detect = ["Cargo.toml", "**/*.rs"]
source_globs = ["**/*.rs"]
test_globs = ["**/tests/**/*.rs"]
docs = []
hallucination_patterns = ["cannot find function", "no method named", "unresolved import"]

[[checks]]
id = "test"
name = "cargo test"
kind = "test"             # syntax, build, test, lint or static
order = 40
when_files = ["Cargo.toml"]
run = "cargo test --offline"
requires = ["cargo"]      # a missing tool shows as skipped
timeout_s = 1800
```

1. Add the toolchain to `sandbox/Dockerfile` and run `make sandbox-vm` to rebuild the image.
2. Add `"rust"` to `languages` in `workspace/projects/<project>.toml`.
3. Try it: `node server/dist/cli.js check ~/code/my-repo --sandbox lima`.

Checks run with no network. A check that exits 77 shows as skipped. More in [docs/PACKS.md](docs/PACKS.md).

## Swap models

**Between downloaded models:** choose one on the **Platforms** page. It switches after the current job.

**Add a new model:**

1. Create `workspace/packs/models/my-model-q4km.toml`:

   ```toml
   id = "my-model-q4km"
   name = "My Model (Q4_K_M)"
   family = "my-family"
   kind = "dense"            # or "moe"
   params_b = 8
   active_params_b = 8
   quant = "Q4_K_M"
   size_gb = 5
   roles = ["main"]          # main, light, reviewer, draft, embed
   license = "apache-2.0"    # copy from the model card
   min_usable_gb = 8
   ctx_default = 16384
   server_args = ["--jinja"]

   [source]
   hf_repo = "owner/repo-GGUF"
   filename = "my-model-Q4_K_M.gguf"
   ```

2. Download it, add its id to `allowed` in your platform file, and restart:

   ```bash
   make download-model ID=my-model-q4km
   make llama-swap-config
   make install-service
   ```

Check it with `make bench MODEL_FILE=workspace/models/my-model-Q4_K_M.gguf` and an eval. On a Mac, models over about 20 GB need `make mac-gpu-limit`, which uses sudo and resets on reboot.

## Copy weights to another machine

GGUF files work on both macOS and Linux, so download once and copy. Run this on the machine that has the file, after `make install` on the other one:

```bash
rsync -avP workspace/models/Qwen3-8B-Q4_K_M.gguf other-machine:OpenHelper/workspace/models/
```

On the other machine, record the hash and compare it with the output of `shasum -a 256` on the first machine:

```bash
node server/dist/cli.js models pin qwen3-8b-q4km --file workspace/models/Qwen3-8B-Q4_K_M.gguf
make llama-swap-config
make install-service
```

**Search indexes** can be copied too, if both machines use the same embedding model:

```bash
rsync -av workspace/projects/my-repo.toml other-machine:OpenHelper/workspace/projects/
rsync -av workspace/index/my-repo/ other-machine:OpenHelper/workspace/index/my-repo/
```

If the repo is at a different path there, update `repos` in the copied project file.

**Fine-tuned weights:** v0.0.1 has no training command. A LoRA adapter exported as GGUF can be copied the same way, but must be used with the exact base model it was trained on.

Never copy `workspace/secrets/`. Each machine has its own token.

## Update

```bash
git pull
make build
make install-service
```

## More

- [docs/SETUP.md](docs/SETUP.md): memory tiers, a second machine, phone access
- [docs/PACKS.md](docs/PACKS.md): model, language, doc and workflow packs
- [docs/SANDBOX.md](docs/SANDBOX.md): sandbox setup
- [docs/HARNESS.md](docs/HARNESS.md): use it from Continue or Cline
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it works
- [docs/VERIFY-ON-HARDWARE.md](docs/VERIFY-ON-HARDWARE.md): what has been verified
- [SECURITY.md](SECURITY.md): security model

To work on OpenHelper itself, run `make check-all` before every commit. See [CONTRIBUTING.md](CONTRIBUTING.md).

MIT license. Models and doc packs have their own licenses.
