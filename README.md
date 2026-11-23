# OpenHelper

A coding assistant that runs entirely on your own machines. You bring your repos and pick an open-weight model; OpenHelper indexes your code and the docs you use, checks every change it makes, and tells you how sure it is. No cloud, no account, no telemetry.

It is built for learning and day-to-day help with **C++, Python, Bash, Make, CMake and Node.js/TypeScript**, and is designed so more languages can be added as packs.

> **Status: v0.1, not yet verified on real hardware.** Everything below runs and is tested against a mock model server. The model picks, speeds and download sources are placeholders until the first hardware run; see [docs/VERIFY-ON-HARDWARE.md](docs/VERIFY-ON-HARDWARE.md).

## What it does

- **Answers with sources.** Questions are answered from your repos and pinned docs. Each claim cites a passage like `[S1]`; claims without support are marked unverified.
- **Plans before it codes.** The planner writes a plan you read and edit in the dashboard. Nothing is implemented until you approve it.
- **Checks its own work.** Every change is built, tested and linted in a sandbox by the language packs, repaired if checks fail, and given a status:
  - **Checked**: every required check passed and tests ran.
  - **Partly checked**: nothing failed, but a check was skipped or there are no tests.
  - **Failed checks**: something failed. The model's own opinion of itself is never used.
- **Never touches your checkout.** Changes go on a new branch through a separate worktree. You merge.
- **Measures itself on your code.** Eval tasks are mined from your git history: past commits replayed with their tests hidden. You get "errors per 100 tasks" for each model and setting.
- **Runs across your machines.** A desktop and a laptop can each run an agent. Workflows hand work between them only where you allow it, with budgets and a kill switch.

## What "train on my repos" means here

On the reference hardware, "training" is mostly **indexing**: your code and docs become searchable context, and language-server tools let the model look up your real APIs. You can optionally fine-tune a small LoRA adapter (models up to about 8B on an 11 GB GPU, larger on a 32 GB Mac with MLX). An adapter is only trained on output that passed every check, and is only kept if it lowers the error rate. Fine-tuning teaches conventions and style; it does not make a model correct. The 35B-class main model cannot be fine-tuned on this hardware.

## Reference hardware

| Machine | Memory | Default main model | Role |
| --- | --- | --- | --- |
| Ubuntu 24.04 desktop, RTX 2080 Ti | 11 GB VRAM + 32 GB RAM | 35B-A3B MoE at Q4, experts in RAM | Implementing, batch jobs, evals |
| M1 Pro MacBook Pro | 32 GB unified | 27B dense or 35B-A3B MoE at Q4 (Phase 0 decides) | Planning, review, questions |

Smaller and larger machines work too: setup measures your memory and picks a tier (XS to XL) from the model registry. See [docs/SETUP.md](docs/SETUP.md).

## Quick start

```bash
git clone https://github.com/LucaLanzi/OpenHelper.git && cd OpenHelper
make install                   # system packages (asks for sudo), then builds llama.cpp + llama-swap + the engine,
                               # creates workspace/ and prints the plan. YES=1 answers every question with yes.
make download-model ID=...     # each model the plan lists (asks first, pins the SHA-256)
make install-service           # model server + engine as user services
make token                     # paste this into the dashboard at http://127.0.0.1:8740
make add-project REPO=~/code/your-repo
make index PROJECT=your-repo
```

To try the dashboard without a GPU: `make build`, then `make mock-llm` in one terminal and `make serve` in another, after `make init PLATFORM=desktop`.

## How it fits together

```
phone / laptop browser ──► dashboard + engine (Node.js, one per machine)
                               │   jobs, workflows, checks, search, audit log
                               ▼
                           llama-swap ──► llama-server (localhost only; one model loaded at a time)
                               │
            sandbox (Docker/Podman on Linux, Lima VM on macOS, network off) runs generated code
```

- **Engine** (`server/`): the API, agents, job queue, checks runner, search index, eval miner, workflow engine.
- **Dashboard** (`dashboard/`): React + Vite, served by the engine; works on a phone over Tailscale.
- **Packs** (`packs/`): models, languages (checks, language servers, linters), docs, workflows, prompt templates. Add a language or a model by adding a pack.
- **Workspace** (`workspace/`, never committed): your projects, platform files, links, indexes, evals, adapters, secrets.

Prefer working in VS Code or a terminal agent? Continue and Cline can use your local models and OpenHelper's search and checks as MCP tools: [docs/HARNESS.md](docs/HARNESS.md).

More: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/PACKS.md](docs/PACKS.md), [docs/SANDBOX.md](docs/SANDBOX.md).

## Security model

- llama-server only listens on localhost. The engine listens on localhost or your Tailscale IP, never all interfaces.
- Every API call needs this machine's token. Other machines' tokens stay on the server.
- Generated code runs only in a sandbox with the network off. Automatic running is refused without one.
- Text from repos, docs and other agents is treated as data, not instructions.
- Secrets are scrubbed before anything is indexed or shown to a model.
- An append-only, hash-chained audit log records every job, approval, config change and cross-machine hand-off.

See [SECURITY.md](SECURITY.md).

## Development

```bash
make check-all    # typecheck + tests (mock model server) + shellcheck
make dev          # engine with auto-reload; pair with make mock-llm
```

The test suite runs two real engine processes (a "desktop" and a "mac") and drives a full plan → implement → review workflow between them.

## License

MIT. Models and doc packs have their own licenses; setup shows each one before downloading, and doc packs are fetched by each user rather than redistributed.
