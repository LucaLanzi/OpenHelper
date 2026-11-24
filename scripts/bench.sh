#!/usr/bin/env bash
# make bench MODEL_FILE=/path/to/model.gguf [ARGS="--n-cpu-moe 20"]
# Prompt processing and generation speed for one model, saved under workspace/results.

# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"

gguf="${MODEL_FILE:?set MODEL_FILE=/path/to/model.gguf}"
bench="$OH_ROOT/vendor/llama.cpp/build/bin/llama-bench"
[ -x "$bench" ] || die "llama-bench not built; run make setup"
out="$OH_WS/results/bench-$(basename "$gguf" .gguf)-$(date +%Y%m%d-%H%M%S).md"
mkdir -p "$(dirname "$out")"
# shellcheck disable=SC2086
"$bench" -m "$gguf" -ngl 999 -p 512,4096 -n 128 -fa 1 -o md ${ARGS:-} | tee "$out"
echo "saved $out"
