# Security

OpenHelper runs a model that writes and runs code on your machines. These are the boundaries it keeps:

- **Network:** llama-server binds to 127.0.0.1. The engine refuses to listen on all interfaces; bind it to localhost or your Tailscale IP. Nothing calls home.
- **Auth:** every API route except `/api/health` needs the machine's token (`workspace/secrets/api-token`, mode 600). Tokens for other machines stay in `workspace/secrets/peers.toml` on the control machine and are never sent to the browser.
- **This machine only:** actions that read a path on the machine (adding repos, local docs, importing embeddings), the Setup page, platforms, languages, and restart, update or turn off only accept requests from the machine itself: loopback, or one of its own addresses such as its Tailscale IP. The check uses the TCP peer address, not a header. Model management, project model settings and embedding export only need the token, so they work over Tailscale.
- **Code execution:** generated code runs only in the sandbox, with network off and only the worktree writable. Automatic running is refused without a sandbox. Your checkout is never modified; changes go on new branches through separate worktrees.
- **Edits:** edit paths that leave the worktree or touch `.git` are refused.
- **Prompt injection:** text from repos, docs, web pages and other agents is data. Agents on other machines can only submit jobs where a link allows it, within budgets, and the kill switch stops all cross-machine work.
- **Secrets:** common secret files are never indexed; known token formats are redacted before indexing and before being shown to a model.
- **Audit:** every job, approval, config change, model swap and cross-machine hand-off is written to a hash-chained log (`./openhelper audit --verify`).
- **Supply chain:** llama.cpp, llama-swap and model files are pinned (`versions.lock`, SHA-256 in model packs). Doc downloads are pinned on first use.

Report a vulnerability by opening a private security advisory on GitHub.
