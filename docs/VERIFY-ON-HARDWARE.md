# Verifying OpenHelper on the reference hardware

v0.0.1 has been run end to end on the M1 Pro MacBook (32 GB) with Qwen3-8B, on 2026-11-23; the results are below. The desktop (2080 Ti) and the larger models have not been run yet. Tick items as you go and note results in `workspace/results/`.

## What is known to work

- The whole pipeline on the Mac with Qwen3-8B: services, ask, plan → approve → build → review, evals, model swap, kill switch, MCP. See the Mac section below.
- The full test suite: core logic, the API, the job queue, the checks runner, the eval miner and runner, and a two-process plan → implement → review workflow with link enforcement. `make check-all`.
- The dashboard, rendered and checked at desktop and phone widths.
- The CLI: `init`, `detect`, `plan`, `add-project`, `index`, `mine-evals`, `models`, `llama-swap-config`, `check`, `serve`, `audit`.

## What has not been verified

| Item | Why it is unverified | How to verify |
| --- | --- | --- |
| `make install` on Ubuntu (apt, Node.js tarball, CUDA toolkit) | Works on macOS; not run on Ubuntu yet | `make install` on the desktop |
| llama.cpp build with CUDA (2080 Ti, compute 7.5) | Metal works on the Mac; CUDA not run yet | `make setup` on the desktop |
| llama-swap on Linux | Works on the Mac (v275); not run on the desktop yet | `make setup`, then `make install-service`, then `curl 127.0.0.1:8741/v1/models` |
| `--cpu-moe` / `--n-cpu-moe` flags and their speed | Need the GPU | `make tune ID=qwen3.6-35b-a3b-q4km` |
| Sources, SHA-256 and licenses of the larger models | Only the two Mac models are pinned | Pick each GGUF, `make download-model ID=... URL=...`, read the model card's license |
| Speed (tokens/s) on the desktop and for the larger models | Only the 8B on the Mac is measured | `make bench MODEL_FILE=...` |
| `chat_template_kwargs.enable_thinking` for models other than Qwen3-8B | Works on Qwen3-8B (an implement reply: 2,089 tokens with thinking, 235 without); template-dependent | Ask a quick question in the dashboard and check the log's token counts |
| Doc-pack URLs other than the six fetched on the Mac | Not all packs have been fetched | `make docs-fetch ID=...` for each |
| Sandbox: Docker/Podman on the desktop | Lima works on the Mac; Docker/Podman not run yet | `make sandbox-image`, then `node server/dist/cli.js check <repo> --sandbox docker` |
| The F´ repos' builds inside the sandbox | Need the F´ toolchain (`fprime-util`) in the image | Run checks on one F´ repo; extend `sandbox/Dockerfile` if needed |

## Mac: the whole pipeline on Qwen3-8B (done for v0.0.1)

M1 Pro, 32 GB, macOS, llama.cpp with Metal, Qwen3-8B Q4_K_M and Qwen3-Embedding-0.6B Q8, Lima sandbox. Both `@plan` and `@build` point at the Mac.

- [x] `make install` and `make setup`; llama.cpp built with Metal; llama-swap 275
- [x] Both models downloaded and pinned; `make models` shows them
- [x] `make bench`: prompt 225 tok/s at 512 tokens, 202 tok/s at 4096; generation 24.9 tok/s
- [x] Lima VM with the sandbox image and the AppArmor profile; `[sandbox] driver = "lima"`; all 6 checks of the OpenHelper repo pass inside it
- [x] Services installed with `make install-service`; `/api/health` OK; the dashboard opens with the token
- [x] Ask: a question about a project streams an answer that cites its passages
- [x] Workflow `implement-feature` ("add `abs_diff` to calc/ops.py and a test"): plan 75 s, implement 135 s, review 9 s; status Checked (compile, pytest, ruff, mypy); the change touched both files, the branch stayed in the repo, nothing was merged
- [x] Eval, calc-demo, 5 tasks mined from history, hidden tests:

  | Thinking in the implement step | Passed | Minutes per task | "Checked" was right |
  | --- | --- | --- | --- |
  | on (the default) | 5 of 5 | 0.8 | 100% |
  | off | 4 of 5 | 0.2 | 100% |

- [x] Eval, the OpenHelper repo itself: 0 of 5. Three were marked Checked but failed the hidden tests: the repo's own checks passed without the change being right. On a codebase this size, "Checked" from the 8B is not enough on its own; read the diff.
- [x] Model swap from the dashboard; kill switch on and off; `/api/audit/verify` reports no break
- [x] MCP server (`node server/dist/cli.js mcp`): `list_projects`, `search` and `run_checks` answer
- [x] Doc packs: gnu.org timed out from this network; the gnu-bash and gnu-make packs came from the mirror tarballs instead
- [ ] Services come back after logging out and in
- [x] `url` in `workspace/platforms/mac.toml` is a real address

Next on the Mac: the 27B dense and 35B-A3B MoE models, after the owner approves the downloads.

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

## Mac: larger models and the two-machine run

- [ ] `make mac-gpu-limit` if the plan warns
- [ ] Download the 27B dense model and the 35B-A3B MoE; bench both; keep the faster one that scores as well on the eval
- [ ] Add the desktop and Mac to each other's platform files and tokens; add a two-way link
- [ ] From the dashboard: run `implement-feature` with plan on the Mac and build on the desktop; then turn the link off and confirm the same run is refused

## When done

- `make pin` on each machine, and commit `versions.lock`.
- Fill in each model pack's `source`, `sha256` and license, and set `verified = true` for models that passed the eval.
- Update the plan doc with measured speeds and error rates.
