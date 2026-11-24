# Contributing

Thanks for helping. The most useful contributions are usually packs: a new language, a doc set, a model that works well on common hardware, or a workflow.

1. Fork and clone, then `make build`.
2. Make your change. Language and model support belong in `packs/`, not in engine code.
3. `make check-all` must pass. It runs the typecheck, the test suite against a mock model server, and shellcheck. No GPU needed.
4. For a model pack, include where you measured it: hardware, tokens/s, and errors per 100 tasks on an eval set, and leave `verified = false` unless you pinned the hash and ran the eval.
5. Open a pull request describing what changed and how you tested it.

Do not commit anything from `workspace/`, model files, or downloaded docs.
