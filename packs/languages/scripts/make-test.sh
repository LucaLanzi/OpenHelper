#!/bin/sh
# Run `make test` (or `make check`) if the Makefile defines it; otherwise skip (exit 77).
for t in test check; do
    if make -n "$t" >/dev/null 2>&1; then
        exec make "$t"
    fi
done
echo "no test or check target"
exit 77
