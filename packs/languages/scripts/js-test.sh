#!/bin/sh
# Run `npm test` when package.json defines a real test script; otherwise skip (exit 77).
has=$(node -e '
const p = JSON.parse(require("fs").readFileSync("package.json", "utf8"));
const t = (p.scripts || {}).test || "";
process.stdout.write(t && !/no test specified/.test(t) ? "yes" : "no");
' 2>/dev/null)
if [ "$has" != "yes" ]; then
    echo "package.json has no test script"
    exit 77
fi
[ -d node_modules ] || { echo "node_modules missing; run npm install in the repo first"; exit 77; }
exec npm test --silent
