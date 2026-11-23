# Mac verification: OpenHelper v0.0.1 on Qwen3-8B

Date: 2026-11-23. Code: `build/v0.1` at 26771ad, except where a row names another commit.
Machine: M1 Pro MacBook Pro, 32 GB, macOS 26.6.2. llama.cpp b12651 (f5e6915c2) with Metal, llama-swap 275, Lima 2.3.0.
Models: Qwen3-8B Q4_K_M and Qwen3-Embedding-0.6B Q8_0, both Apache-2.0, from Qwen's Hugging Face repos, SHA-256 matched.

**Verdict:** the 8B pipeline works end to end for questions and small changes. It is not reliable on harder multi-file work.

## Passed

| Step | Result |
| --- | --- |
| `make check-all` | 66 of 66 tests, typecheck and shellcheck |
| `make install`, Metal build | Done after the fixes below |
| Services | `127.0.0.1` only; `/api/health` OK; audit chain intact (`first_broken: -1`) |
| Lima sandbox | All 6 checks of this repo pass, under the `openhelper-sandbox` AppArmor profile |
| Sandbox confinement | Mount denied, `/proc/sysrq-trigger` read-only, no network |
| Index | calc-demo 6,727 chunks; openhelper-test 10,171 chunks; hybrid, 1024-dim |
| Doc packs | 7 fetched; gnu-bash and gnu-make came from mirror tarballs because gnu.org timed out |
| Ask (API) | First token 15.4 s, total 23.2 s, 3 valid citations |
| Dashboard | Headless Chrome: login, all 10 pages, no console or API errors; Ask answered in 21.1 s |
| `implement-feature` on calc-demo | Green two-file patch; plan 78 s, implement + review 147 s, 17,699 tokens; branch left, `main` unchanged |
| Model swap | Unloaded, then reloaded and answered in 24.2 s |
| Kill switch | On blocks every link; off restores them |
| MCP | `list_projects`, `search` and `run_checks` answer |
| Copying weights | Model and index copied to a second workspace on this Mac: hash identical, search works |
| Custom packs | A Rust language pack and a custom model pack load from `workspace/packs/` |

## Speed

`make bench`, two runs:

| Test | Tokens/s |
| --- | --- |
| Prompt, 512 tokens | 225.0–225.3 |
| Prompt, 4096 tokens | 202.1–202.6 |
| Generation, 128 tokens | 24.9–25.0 |

27B and 35B-A3B were not downloaded, by the owner's decision, so there is no speed comparison.

## Evals

Hidden tests, LIMIT=5. Results before a274fd7 are not valid and are left out: the index leaked answers, `make test` broke worktrees, and the sandbox skipped every check.

| Project | Commit | Thinking in implement | Passed | Minutes per task | "Checked" was right |
| --- | --- | --- | --- | --- | --- |
| calc-demo | 9c9d3a9 | on (default) | 5 of 5 | 0.4–1.5 | 100% |
| calc-demo | a274fd7 | off | 4 of 5 | 0.1–0.3 | 100% |
| openhelper-test | 26771ad | on | **0 of 5** | 3.5–14.1 | **0%** |

calc-demo is a small repo built for this test, with one-function commits. It is not evidence about real repos.

openhelper-test by task:

| Task | Status | Why it failed | Tokens | Minutes |
| --- | --- | --- | --- | --- |
| f1241c636d | Failed checks | edit not applied | 11,464 | 3.5 |
| 662be04141 | **Checked** | hidden tests failed | 10,750 | 4.3 |
| 67461f949e | Failed checks | edit not applied | 20,366 | 14.1 |
| 7ddfb1ba62 | **Checked** | hidden tests failed | 13,124 | 7.5 |
| 2ffeb8e231 | **Checked** | hidden tests failed | 11,393 | 4.6 |

"Checked" was wrong 3 times out of 3 here. It means the repo's existing checks passed, so diffs still need review.

## Failed or not done

- **Log out and back in:** not tested yet. It needs the owner.
- **`make sandbox-vm`:** not run on this Mac. The VM here was set up by hand with system containerd. The script's `nerdctl info` check has the same flaw fixed in the engine by a274fd7: on this VM it would choose plain `nerdctl`, so it was not run against it.
- **Phone layout:** the Jobs page overflows horizontally at 390 px. The other three phone pages fit.
- **Not run:** Ubuntu desktop, 27B and 35B models, two real machines, copying between two real machines, fine-tuning (no training command exists).
- **Restarts:** a restart still fails a job that is in progress. An eval on 9c9d3a9 was lost this way:

```text
status failed error server restarted while the job was in progress
```

## Bugs found and fixed on this Mac

| Symptom | Fix |
| --- | --- |
| Pytest check could not see pipx's pytest | Dedicated `vendor/check-python` |
| `make setup` died with SIGPIPE on 8,013 tags | Ask git for the newest tag |
| Lima docs: wrong containerd mode, `-` build context | Corrected commands |
| Large doc files counted as not fetched | Higher limit for docs |
| Generation stopped at 5 minutes (`UND_ERR_HEADERS_TIMEOUT`) | Stream replies |
| `node_modules` link broken inside the sandbox | Mount the source repo read-only |
| AppArmor blocked signals inside a container (`kill EACCES`) | Dedicated profile with one added rule |
| `make test` reinstalled dependencies with no network | Install only when missing |
| Repair prompt had no file content | Show the plan and its files |
| Evals retrieved the answer from the index | Filter to the task's checkout |
| A sentence became a file name, so a no-op passed | Reject non-paths |
| Labelled and missing file paths in model replies | Parse them; use the plan's file |
| Sandbox picked the wrong `nerdctl`, skipping all checks | Detect by the image |
| Reviewer approved an empty patch | Empty or failed changes cannot be approved |
| 8B copied the `path/to/file.py` example | Show the plan's real path |

## Left on this Mac

Nothing was deleted, as the owner asked. These can be removed when no longer wanted:

- `workspace/.lima-write-test`, an empty file from a write test
- `workspace/worktrees/mwtvn2e4-1` and its branch in the test clone, from the interrupted eval
- `workspace/test-repos/`, the OpenHelper clone and calc-demo
- The `openhelper` Lima VM, about 7.4 GB
