# Upgrading

## From 0.0.1

Nothing to do by hand. Existing files keep working; missing fields get these defaults:

| File | Field | Default | Meaning |
| --- | --- | --- | --- |
| `projects/*.toml` | `platform` | this machine | where its jobs run |
| | `search` | `platform-default` | hybrid if the platform has an embedding model, else keyword |
| | `language_mode` | `auto` | every language pack applies, as before |
| | `checks` | not set | every check of those languages runs |
| | `model`, `light_model`, `embed_model` | empty | use the platform's models |
| `platforms/*.toml` | `display_name`, `tailscale_hostname`, `tailscale_ipv4` | empty | registry information only |
| | `connection` | `api` | |
| | `ssh` | empty | SSH testing off |
| | `hooks` | `health`, `capabilities`, `models`, `job-status`, `job-logs`, `index-estimate` | read-only operations; tick `start-job`, `cancel-job`, `index` or `workflow-step` to let other machines start work here |
| | `os` | `other` when missing | was `linux`; press **Detect capabilities** to fill it in |

After updating:

- **Rebuild each project's index once.** Indexes from 0.0.1 still load, but stored their vectors as text, which made big projects fail to save. The rebuild also skips `coverage/` folders and doc menus. Its embeddings are cached, so every later rebuild is fast.
- To let a machine run another machine's jobs, tick its hooks on the **Platforms** page on both machines, and allow the link in **Settings**. Nothing crosses machines without both.

Not supported yet: a shared platform registry (for example a file in a private GitHub repo). Each instance keeps its own `platforms/` files.
