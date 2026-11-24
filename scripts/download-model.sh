#!/usr/bin/env bash
# make download-model ID=<model id> [URL=<direct url>]
# Downloads a model file after you confirm, then pins its SHA-256.

# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"

id="${1:?usage: download-model.sh ID [URL]}"
url="${2:-}"
pack="$OH_WS/packs/models/$id.toml"
[ -f "$pack" ] || pack="$OH_ROOT/packs/models/$id.toml"
[ -f "$pack" ] || die "no model pack $id"

field() { sed -n "s/^$1 *= *\"\(.*\)\"/\1/p" "$pack" | head -n1; }
repo="$(field hf_repo)"
file="$(field filename)"
pinned_url="$(field url)"
pinned_sha="$(field sha256)"
size="$(sed -n 's/^size_gb *= *\([0-9.]*\)/\1/p' "$pack" | head -n1)"
license="$(field license)"

[ -z "$url" ] && url="$pinned_url"
if [ -z "$url" ]; then
    if [ -z "$repo" ] || [ -z "$file" ]; then
        die "the $id pack has no download source yet. Pick the GGUF file on Hugging Face, then run:
  make download-model ID=$id URL=https://huggingface.co/<repo>/resolve/main/<file>.gguf"
    fi
    url="https://huggingface.co/$repo/resolve/main/$file"
fi
[ -n "$file" ] || file="$(basename "${url%%\?*}")"

dest_dir="${OPENHELPER_MODELS:-$OH_WS/models}"
mkdir -p "$dest_dir"
dest="$dest_dir/$file"

echo "Model:   $id"
echo "License: $license"
echo "Size:    ~${size} GB"
echo "From:    $url"
echo "To:      $dest"
free_gb="$(df -Pk "$dest_dir" | awk 'NR==2 {printf "%d", $4/1024/1024}')"
echo "Free:    ${free_gb} GB"

file_sha() { if have shasum; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }

if [ -n "$pinned_sha" ] && [ -f "$dest" ] && [ "$(file_sha "$dest")" = "$pinned_sha" ]; then
    log "already downloaded; SHA-256 matches the pinned value"
    exit 0
fi
confirm "Download it?" || die "cancelled"

if [ -n "$pinned_sha" ]; then
    # Download beside the real name, so a partial or bad file is never taken for the model.
    part="$dest.part"
    if [ -f "$dest" ] && [ ! -f "$part" ]; then mv "$dest" "$part"; fi
    curl -fL --retry 3 -C - -o "$part" "$url"
    # A pinned model must match its hash exactly; a mismatch is a stop, not a fix.
    got="$(file_sha "$part")"
    if [ "$got" != "$pinned_sha" ]; then
        rm -f "$part"
        die "SHA-256 mismatch for $dest (expected $pinned_sha, got $got). Not using it."
    fi
    mv "$part" "$dest"
    log "SHA-256 matches the pinned value"
else
    curl -fL --retry 3 -C - -o "$dest" "$url"
    oh models pin "$id" --file "$dest" --url "$url"
fi
