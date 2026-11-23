# OpenHelper — run `make help` for the list of targets.

SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

# Use a new enough Node.js even if an older one (nvm, Homebrew node@20, apt) comes first on PATH.
NODE_DIR := $(shell ./scripts/find-node.sh 2>/dev/null)
export PATH := $(if $(NODE_DIR),$(NODE_DIR):)$(PATH)

OH := node server/dist/cli.js
PROFILE ?= auto

.PHONY: help install prereqs setup init detect plan build typecheck test lint-scripts check-all dev serve mock-llm \
        llama-swap-config sandbox-image install-service token download-model tune bench mac-gpu-limit \
        add-project docs-list docs-fetch index mine-evals eval models pin audit clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[1m%-18s\033[0m %s\n", $$1, $$2}'

# --- setting up a machine ----------------------------------------------------------------
install: ## Everything for a new machine: system packages, then setup (YES=1 for no questions)
	./scripts/install-prereqs.sh
	./scripts/setup.sh $(PROFILE)

prereqs: ## Install system packages only: build tools, Node.js 22, CUDA, check tools, sandbox
	./scripts/install-prereqs.sh

setup: ## Build llama.cpp + llama-swap + engine for this machine (PROFILE=auto|desktop|mac|cpu)
	./scripts/setup.sh $(PROFILE)

init: build ## Create workspace/ for this machine (PLATFORM=desktop|mac|...)
	$(OH) init --platform $(or $(PLATFORM),$(error set PLATFORM=name))

detect: build ## Detect memory, GPU and disk
	$(OH) detect

plan: build ## Show the tier, models and disk this machine needs (TIER= to override)
	$(OH) plan $(if $(TIER),--tier $(TIER))

llama-swap-config: build ## Regenerate workspace/llama-swap.yaml from the platform file
	$(OH) llama-swap-config

download-model: ## Download and pin a model (ID=model-id, optional URL=)
	./scripts/download-model.sh $(or $(ID),$(error set ID=model-id)) $(URL)

models: build ## List model packs and whether their files are present
	$(OH) models list

pin: ## Record the llama.cpp and llama-swap versions setup used into versions.lock
	@test -f workspace/versions.recorded || { echo "run make setup first"; exit 1; }
	@while IFS='=' read -r k v; do sed -i.bak "s#^$$k=.*#$$k=$$v#" versions.lock; done < workspace/versions.recorded; rm -f versions.lock.bak
	@git --no-pager diff --stat -- versions.lock || true

tune: ## Sweep --n-cpu-moe for an MoE model (ID=model-id)
	./scripts/tune.sh $(or $(ID),$(error set ID=model-id))

bench: ## Benchmark one model file (MODEL_FILE=path)
	./scripts/bench.sh

mac-gpu-limit: ## macOS: raise the GPU memory limit for large models (asks first)
	./scripts/mac-gpu-limit.sh

sandbox-image: ## Build the sandbox image generated code runs in (docker or podman)
	$(or $(shell command -v podman),docker) build -t openhelper-sandbox:latest sandbox

install-service: build ## Install and start the model server and engine as user services
	./scripts/install-service.sh

token: ## Print this machine's API token (for the dashboard login)
	@test -f server/dist/cli.js || $(MAKE) -s build >/dev/null
	@$(OH) token

# --- projects -----------------------------------------------------------------------------
add-project: build ## Register a repo as a project (REPO=~/code/repo, optional NAME=)
	$(OH) add-project $(or $(REPO),$(error set REPO=path/to/repo)) $(if $(NAME),--name $(NAME))

docs-list: build ## List doc packs and whether they are fetched
	$(OH) docs list

docs-fetch: build ## Fetch a doc pack (ID=pack-id)
	$(OH) docs fetch $(or $(ID),$(error set ID=pack-id))

index: build ## Build a project's search index (PROJECT=name)
	$(OH) index $(or $(PROJECT),$(error set PROJECT=name))

mine-evals: build ## Build eval tasks from a project's git history (PROJECT=name, LIMIT=100)
	$(OH) mine-evals $(or $(PROJECT),$(error set PROJECT=name)) --limit $(or $(LIMIT),100)

eval: ## Run the eval from the dashboard (Projects page) so it uses the running model server
	@echo "Start an eval job from the dashboard, or: curl -H \"Authorization: Bearer \$$(make -s token)\" -d '{\"type\":\"eval\",\"project\":\"$(PROJECT)\",\"start\":true}' -H 'content-type: application/json' http://127.0.0.1:8740/api/jobs"

audit: build ## Show the audit log (VERIFY=1 to check the hash chain)
	$(OH) audit $(if $(VERIFY),--verify)

# --- development --------------------------------------------------------------------------
node_modules: package.json server/package.json dashboard/package.json
	npm install --no-audit --no-fund
	@touch node_modules

build: node_modules ## Build the engine and dashboard
	npm run build

typecheck: node_modules ## Type-check the engine and dashboard
	npm run typecheck

test: node_modules ## Run the test suite (uses a mock model server, no GPU needed)
	npm test

lint-scripts: ## shellcheck every shell script
	shellcheck -x scripts/*.sh packs/languages/scripts/*.sh

check-all: typecheck test lint-scripts ## Everything CI runs

dev: node_modules ## Engine with auto-reload; run `make mock-llm` alongside to try it without a GPU
	npm run dev:server

mock-llm: node_modules ## A fake model server on 127.0.0.1:8741 for trying the dashboard
	npm run mock-llm

serve: build ## Start the engine and dashboard in the foreground
	$(OH) serve

clean: ## Remove build output (never touches workspace/)
	rm -rf server/dist dashboard/dist
