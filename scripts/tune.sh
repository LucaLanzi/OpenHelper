#!/usr/bin/env bash
# make tune ID=<model id>
# Sweeps --n-cpu-moe with llama-bench for an MoE model and prints prompt and generation speed.
# Record the best value in your platform file under [model_overrides."<id>"] n_cpu_moe.

# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"

id="${1:?usage: tune.sh MODEL_ID}"
bench="$OH_ROOT/vendor/llama.cpp/build/bin/llama-bench"
[ -x "$bench" ] || die "llama-bench not built; run make setup"
gguf="${MODEL_FILE:-$(oh models path "$id")}"
[ -f "$gguf" ] || die "model file for $id not found at $gguf (download it with make download-model, or set MODEL_FILE)"

layers="${LAYERS:-48}"
echo "Sweeping --n-cpu-moe for $gguf (layers: $layers; set LAYERS to change)"
out="$OH_WS/results/tune-$id-$(date +%Y%m%d-%H%M%S).md"
mkdir -p "$(dirname "$out")"
for n in $(seq "${FROM:-8}" "${STEP:-4}" "$layers"); do
    echo "--- n_cpu_moe=$n"
    "$bench" -m "$gguf" -ngl 999 --n-cpu-moe "$n" -p 2048 -n 128 -b 2048 -ub 2048 -fa 1 -o md 2>/dev/null | tee -a "$out" || echo "(failed: probably out of VRAM)"
done
echo "Results saved to $out. Pick the smallest n_cpu_moe that does not run out of VRAM."
