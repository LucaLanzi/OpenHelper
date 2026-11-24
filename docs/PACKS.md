# Packs

Packs are how OpenHelper learns new models, languages, docs and workflows without engine changes. Engine packs live in `packs/`; your own go in `workspace/packs/` and override engine packs with the same id.

## Model packs (`packs/models/<id>.toml`)

```toml
id = "qwen3-8b-q4km"
name = "Qwen3 8B (Q4_K_M)"
family = "qwen3"            # the reviewer must come from a different family than the main model
kind = "dense"              # or "moe"
params_b = 8
active_params_b = 8         # for MoE: parameters read per token
quant = "Q4_K_M"
size_gb = 5
roles = ["light", "main"]   # main, light, reviewer, draft, embed
license = "check the model card"
min_usable_gb = 8
ctx_default = 16384
server_args = ["--jinja", "--flash-attn", "on"]
verified = false            # true only after the hash is pinned and it passed your eval
sha256 = ""                 # set by `make download-model`

[source]
hf_repo = "owner/repo-GGUF"
filename = "model-Q4_K_M.gguf"
```

## Language packs (`packs/languages/<id>.toml`)

A language pack says how to detect the language, where its tests live, which docs to cite, which language server to use, which error messages mean "the model invented something", and which checks to run.

```toml
id = "rust"
name = "Rust"
detect = ["Cargo.toml", "**/*.rs"]
source_globs = ["**/*.rs"]
test_globs = ["**/tests/**/*.rs"]
docs = ["rust-std"]
hallucination_patterns = ["cannot find function", "no method named", "unresolved import"]

[lsp]
command = "rust-analyzer"

[[checks]]
id = "build"
name = "cargo build"
kind = "build"            # syntax, build, test, lint, static
order = 10                # lower runs first, across all packs
when_files = ["Cargo.toml"]
run = "cargo build --offline"
requires = ["cargo"]      # missing binary → skipped (and the status cannot be green)
required = true           # false = advisory; does not block green when skipped
timeout_s = 1800
```

Conventions:

- A check that exits **77** means "not applicable here" and is shown as skipped.
- `{files}` in `run` expands to matching files (from `files = [...]`), shell-quoted.
- Checks run in the sandbox with the network off: never download in a check.
- Helper scripts go in `packs/languages/scripts/` and are reached as `$OH_PACKS/languages/scripts/<name>.sh`.

## Doc packs (`packs/docs/<id>.toml`)

```toml
id = "nodejs"
name = "Node.js API documentation"
version = "v22"
license = "MIT"
redistributable = true

[[sources]]
url = "https://nodejs.org/dist/latest-v22.x/docs/api/all.json"
format = "json"            # tar, zip, html, markdown, json, text
sha256 = ""                # empty: recorded on first download, then enforced
subdir = ""                # for archives: only index this folder or file

# Optional, tried in order when the URL above cannot be reached (no answer or an HTTP error).
# A SHA-256 mismatch never falls through to the next one: it stops the fetch.
[[sources.alternatives]]
url = "https://mirror.example.org/node-v22-docs.tar.gz"
format = "tar"
subdir = "doc/api"
```

The GNU packs use this: when gnu.org does not answer, they take the manual from the release tarball on GNU's mirrors (Bash's HTML reference manual, Make's Info files, which are indexed as text).

Alternatives to `sources`: `local_command` (index the output of a command, such as `cmake --help-full`), or `make docs-add ID=<id> FILE=<path>` for docs you downloaded yourself. Doc content is never bundled in this repo.

## Workflows (`packs/workflows/<name>.yaml`) and templates

Workflow steps name a platform alias (`@plan`, `@build`) or a platform, an agent (`planner`, `coder`, `reviewer`, `explainer`), a prompt, an optional `gate: human-approve`, check kinds and `best_of`. Prompt templates in `packs/templates/` can be overridden per workspace.
