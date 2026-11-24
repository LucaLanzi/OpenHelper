#!/bin/sh
# Run ctest in a build directory; exit 77 (skipped) when the project defines no tests.
dir="${1:-build}"
out=$(ctest --test-dir "$dir" --output-on-failure 2>&1)
rc=$?
printf '%s\n' "$out"
if printf '%s' "$out" | grep -q "No tests were found"; then
    exit 77
fi
exit "$rc"
