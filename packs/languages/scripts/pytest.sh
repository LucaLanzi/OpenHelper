#!/bin/sh
# Run pytest; exit 77 (skipped) when pytest is missing or no tests were collected.
python3 -c "import pytest" 2>/dev/null || { echo "pytest is not installed"; exit 77; }
python3 -m pytest -q -p no:cacheprovider
rc=$?
if [ "$rc" -eq 5 ]; then
    echo "no tests collected"
    exit 77
fi
exit "$rc"
