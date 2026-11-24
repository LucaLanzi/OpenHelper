#!/bin/sh
# Run a tool installed in the project (node_modules/.bin); skip (exit 77) if it is not installed.
# Never downloads anything: the sandbox has no network.
tool="$1"
shift
bin="node_modules/.bin/$tool"
if [ ! -x "$bin" ]; then
    echo "$tool is not installed in this project (node_modules/.bin/$tool)"
    exit 77
fi
exec "$bin" "$@"
