# Using OpenHelper from your editor (Continue, Cline)

The dashboard runs OpenHelper's own agents. You can also use your local models from an editor agent, with OpenHelper's search and checks available to it as tools.

Two pieces:

- **Models:** llama-swap serves an OpenAI-compatible API on `http://127.0.0.1:8741/v1`. Any editor agent that accepts an OpenAI-compatible base URL can use it. Asking for a model by id loads it.
- **Tools:** `node server/dist/cli.js mcp` is an MCP server with three tools:
  - `list_projects`: your projects and whether they are indexed.
  - `search`: your code and pinned docs, returned as labelled passages to cite.
  - `run_checks`: build, test and lint a directory in the sandbox, returning Checked, Partly checked or Failed checks.

  `run_checks` refuses to run when the machine has no sandbox. Set one up with `make sandbox-vm`, or set `OPENHELPER_MCP_ALLOW_HOST=1` in the editor's MCP settings to allow it anyway.

## Continue (VS Code and the `cn` CLI)

```bash
node server/dist/cli.js harness continue
```

This writes `workspace/harness/continue-config.yaml` with your main and light models, the MCP server, and two rules: search before using an API you're unsure of, and run checks before saying a change works. Copy it to `~/.continue/config.yaml` (back up yours first) or merge the sections into your file. The `cn` CLI reads the same file: `cn --config workspace/harness/continue-config.yaml`.

## Cline (VS Code and the `cline` CLI)

```bash
node server/dist/cli.js harness cline
```

It prints the three settings to enter: the OpenAI Compatible provider with the base URL and model id, Compact Prompt on, and the MCP server entry written to `workspace/harness/cline-mcp-settings.json`.

## What you give up compared with the dashboard

Editor agents call the model directly. The plan approval gate, best-of-N, the automatic repair loop, the audit log and the link policy between machines only apply to work started from the dashboard or its API. The MCP tools give the editor agent the same search and checks, but whether it uses them is up to that agent.
