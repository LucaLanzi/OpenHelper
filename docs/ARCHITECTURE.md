# Architecture

## Processes on one machine

| Process | Listens on | Does |
| --- | --- | --- |
| `llama-swap` | 127.0.0.1:8741 | Starts `llama-server` for whichever model a request names; one chat model loaded at a time, the embedding model kept alongside |
| `node server/dist/cli.js serve` | 127.0.0.1 or the Tailscale IP, port 8740 | API, dashboard, job queue, agents, checks, search, workflows, audit log |
| Sandbox | none (network off) | Builds, tests and lints generated code |

To save power, the heavy parts stop when idle. llama-swap unloads a model after `resources.unload_after_min` minutes without requests (its `ttl`). The engine counts open dashboards by their `/api/events` streams; once none has been open and no job has been active for the same time, it stops the Lima VM, and the next job starts it again. `./openhelper stop` (or **Turn off OpenHelper** on the System page) stops the VM and then both services with `scripts/power.sh off`; `./openhelper start` runs `scripts/power.sh on`.

## Control plane and data plane

- **Control plane**: the dashboard and the `control` role. It can see and configure every platform it has a token for. Starting a workflow is a control-plane action.
- **Data plane**: work handed from one platform's agent to another's. Every hand-off after the first step goes through the link policy (`links.toml`): isolated by default, one-way or two-way, with hop, token and time budgets and a kill switch. The receiving platform checks its own `links.toml` too.

## Agent hooks

A platform can ask another to do one of a fixed list of operations, `POST /api/hooks`: `health`, `capabilities`, `models`, `job-status`, `job-logs`, `index-estimate`, `start-job`, `cancel-job`, `index` and `workflow-step`. Each platform file lists the hooks it accepts (`hooks`). A hook goes through the sender's and the receiver's link policy, its budgets and the kill switch, and is audited on both sides. A platform only sees and cancels jobs it started itself. There is no way to send a shell command.

A remote job carries the job request, the project name and its settings. Repos, docs and models are not copied: the same project must exist on the other machine with paths that are valid there. If that machine is offline, the request fails and nothing is moved to another machine.

SSH settings are only used to test a connection with a fixed command (`echo`), through the OS SSH agent, with strict host-key checking. Tokens and keys are never stored in platform files, only the name of the secret that holds them.

## A workflow, step by step

1. You start `implement-feature` with a task. The planner step runs on `@plan` (an alias set in `config.toml`).
2. The planner retrieves passages from the project's index, writes a plan that cites them, and saves it under `workspace/plans/`.
3. The run waits for you, for as long as it takes: the wait survives a restart and does not count against the wall-time limit. You edit the plan if you like and approve it. The approved text replaces the model's plan for every later step.
4. The coder step runs on `@build`. If that is another machine, the link policy decides whether the hand-off is allowed.
5. The coder makes a worktree on a new branch, asks for search/replace edits, applies them, and runs the language-pack checks in the sandbox. If checks fail, it shows the model the failures and tries again, up to `repair_attempts`. With `best_of` above 1 it makes several candidates and keeps the best.
6. The reviewer reads the plan, the patch and the check results, and gives a verdict. The run waits for you again.
7. The branch stays in your repo. Nothing is merged for you.

## Confidence status

Computed from check results only:

- **Checked** (green): every required check ran and passed, and at least one test ran. For answers: at least one valid citation.
- **Partly checked** (amber): nothing failed, but a required check was skipped, no tests exist, or an answer has no citations.
- **Failed checks** (red): a check failed or errored, or an edit could not be applied.

The eval measures how often "Checked" was actually right (`green_precision`), per model.

## Search

Each project has an index of its repos and doc packs: chunks in `chunks.jsonl`, a BM25 keyword index, and, if an embedding model is configured, vectors. Search combines the two rankings with reciprocal rank fusion. Secrets are scrubbed and secret files skipped before indexing. Generated coverage reports (`coverage/`, `htmlcov/`) are skipped, and lines repeated on more than half of a doc pack's pages (menus, footers) are blanked.

Embeddings are cached in `workspace/cache/embeddings/<model>.bin`, keyed by a hash of the exact text, shared by all projects and appended after every batch. A failed or canceled build keeps its work, and a rebuild only embeds new or changed chunks. Delete the file to reset it. Changing a project's embedding model re-embeds everything once, and the old model's cache stays for switching back.

`embeddings export` writes a project's index vectors to `workspace/exports/<project>-embeddings-<date>.ohemb.gz`: gzip of one JSON header line (model, dims, count), then the same `[sha1][float32 × dims]` records as the cache. `embeddings import` appends the records this machine's cache lacks, so the next build there finds them. The keys are hashes of the text the model sees, and chunk titles use repo-relative paths, so they match when the repo is somewhere else.

Index time estimates use, in order: this platform's past builds with the same embedding model, its measured benchmark rates, then a broad initial range from its CPU and memory. Builds that were mostly cached are not used as samples.

## Evals

`mine-evals` scans git history for commits that change both source and test files, within size limits. Each becomes a task: start at the parent commit, give the model only the commit message and the files it touched, let it implement, then add the commit's tests and run the build and tests. Evals leave no branches behind. Results go to `workspace/results/<project>/`.

## Files

```
packs/          engine packs (models, languages, docs, workflows, templates) — public
workspace/      one user's data — never committed
  config.toml   this machine: self, roles, bind, aliases
  platforms/    one file per machine
  links.toml    which machine may hand work to which
  projects/     one file per project
  exports/      embeddings exported for another machine
  plans/ jobs/ runs/ results/ index/ evals/ docs/ audit/ secrets/ state/ cache/
```
