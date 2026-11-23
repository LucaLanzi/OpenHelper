#!/bin/sh
# Static checks for a Makefile in the current directory:
#  1. dry run with --warn-undefined-variables (warnings fail the check)
#  2. recipe lines must start with a tab, not spaces
#  3. common phony targets that exist should be declared .PHONY
mf=""
for f in GNUmakefile makefile Makefile; do
    if [ -f "$f" ]; then mf="$f"; break; fi
done
[ -n "$mf" ] || { echo "no Makefile"; exit 77; }
status=0

out=$(make -n --warn-undefined-variables -f "$mf" 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then
    printf '%s\n' "$out" | tail -n 40
    echo "make -n failed (exit $rc)"
    status=1
fi
if printf '%s' "$out" | grep -q "warning: undefined variable"; then
    printf '%s\n' "$out" | grep "warning: undefined variable"
    status=1
fi

# A line indented with spaces right after a rule line is almost always a broken recipe.
awk -v f="$mf" '
    /^[^#\t][^=]*:([^=]|$)/ { inrule = 1; next }
    /^$/ { inrule = 0; next }
    inrule && /^ +[^ ]/ { printf "%s:%d: recipe line starts with spaces, not a tab\n", f, NR; bad = 1 }
    END { exit bad }
' "$mf" || status=1

for t in all clean test check install distclean; do
    if grep -Eq "^${t}[[:space:]]*:" "$mf" && ! grep -Eq "^\.PHONY:.*(^|[[:space:]])$t([[:space:]]|$)" "$mf"; then
        echo "$mf: target '$t' is not declared .PHONY"
        status=1
    fi
done
exit "$status"
