# Verifying v0.1 on the reference hardware

Everything in this repo was built and tested in a cloud workspace against a mock model server. None of it has run on a real GPU yet. This checklist is Phase 0 of the plan: it turns the placeholders into measured, pinned values. Tick items as you go and note results in `workspace/results/`.

## What is known to work

- The full test suite: core logic, the API, the job queue, the checks runner, the eval miner and runner, and a two-process plan → implement → review workflow with link enforcement. `make check-all`.
- The dashboard, rendered and checked at desktop and phone widths.
- The CLI: `init`, `detect`, `plan`, `add-project`, `index`, `mine-evals`, `models`, `llama-swap-config`, `check`, `serve`, `audit`.

## What has not been verified

| Item | Why it is unverified | How to verify |
| --- | --- | --- |
| `make install` package installation (apt, Homebrew, Node.js tarball, CUDA toolkit) | Only dry-run here as a normal user without apt; nodejs.org and Homebrew were unreachable | `make install` on each machine |
| llama.cpp build with CUDA (2080 Ti, compute 7.5) and Metal | No GPU in the build environment | `make setup` on each machine |
| llama-swap release download and config format (groups, `ttl`, `${PORT}`) | Could not reach GitHub releases from the build environment | `make setup`, then `make install-service`, then `curl 127.0.0.1:8741/v1/models` |
| `--cpu-moe` / `--n-cpu-moe` flags and their speed | Need the GPU | `make tune ID=qwen3.6-35b-a3b-q4km` |
| Model choices, file names, SHA-256 and licenses | Packs have empty `source` and `sha256` on purpose | Pick each GGUF, `make download-model ID=... URL=...`, read the model card's license |
| Speed (tokens/s) on both machines | Need the hardware | `make bench MODEL_FILE=...` |
| `chat_template_kwargs.enable_thinking` to turn reasoning off for quick answers | Model- and template-dependent | Ask a quick question in the dashboard and check the log's token counts |
| Doc-pack URLs (Python, Node.js, React, Vite, F´, GNU manuals) | Could not fetch from the build environment | `make docs-fetch ID=...` for each |
| Sandbox: Docker/Podman image and Lima VM | No container runtime in the build environment | `make sandbox-image`, then `node server/dist/cli.js check <repo> --sandbox docker` |
| The F´ repos' builds inside the sandbox | Need the F´ toolchain (`fprime-util`) in the image | Run checks on one F´ repo; extend `sandbox/Dockerfile` if needed |

## Desktop (Ubuntu 24.04, 2080 Ti)

- [ ] `nvidia-smi` shows the 2080 Ti
- [ ] `make install` completes: packages, Node.js 22, the CUDA toolkit (`nvcc --version` works), check tools, Podman
- [ ] `make setup PROFILE=desktop` completes (`make install` already ran it); `vendor/llama.cpp/build/bin/llama-server --version` runs
- [ ] `make plan` shows tier M with about 35 GB usable
- [ ] Download the main model and the light model; `make models` shows them present and pinned
- [ ] `make tune ID=qwen3.6-35b-a3b-q4km`; record the best `n_cpu_moe` in `workspace/platforms/desktop.toml`; `make llama-swap-config`
- [ ] `make bench` for both models; record prompt and generation tok/s
- [ ] `make sandbox-image`; set `[sandbox] driver = "docker"` (or podman)
- [ ] `make install-service`; reboot; services come back
- [ ] Dashboard reachable from the phone over Tailscale
- [ ] `make add-project` for one BILLEE repo and one SCALES repo; fetch their doc packs; build the indexes
- [ ] `make mine-evals`; skim the tasks; delete any that are not good tests
- [ ] Run the eval for the main model and the light model; record errors per 100 tasks

## Mac (M1 Pro, 32 GB)

- [ ] `make install` completes on macOS (Command Line Tools, Homebrew packages, Lima) and builds with Metal
- [ ] `make mac-gpu-limit` if the plan warns
- [ ] Download the 27B dense model and the 35B-A3B MoE; bench both; keep the faster one that scores as well on the eval
- [ ] `brew install lima`; create the VM (docs/SANDBOX.md); set `[sandbox] driver = "lima"`
- [ ] Add the desktop and Mac to each other's platform files and tokens; add a two-way link
- [ ] From the dashboard: run `implement-feature` with plan on the Mac and build on the desktop; then turn the link off and confirm the same run is refused

## When done

- `make pin` on each machine, and commit `versions.lock`.
- Fill in each model pack's `source`, `sha256` and license, and set `verified = true` for models that passed the eval.
- Update the plan doc with measured speeds and error rates.
