# Slopo duplication review

[Slopo](https://github.com/rafal-qa/slopo) finds similar implementations across
Atlas's modules. Codex runs the tool and evaluates its findings. A separate local
Ollama embedding model compares code snippets, so embedding needs no API key and
sends no source code to an embedding provider.

## Setup

Install the CLI and local model on each Mac:

```sh
brew install uv ollama
uv tool install slopo==0.7.0
ollama serve
```

Leave `ollama serve` running in that terminal. In another terminal, run:

```sh
ollama pull unclemusclez/jina-embeddings-v2-base-code
```

Run all Slopo commands from the Atlas repository root. The checked-in
[`slopo.conf.yaml`](../slopo.conf.yaml) uses the local endpoint at
`http://127.0.0.1:11434`. Start `ollama serve` again before later scans if it has
stopped. If Ollama is already serving on that port, use the existing process.

## Use from Codex

The repository includes three explicit-use skills under `.agents/skills/`:

- `$slopo-review` checks uncommitted changes. Add a Git base, such as
  `$slopo-review origin/main`, to check a branch.
- `$slopo-analyze-ignore` scans the codebase and writes obvious false positives
  to `slopo.ignore.txt`.
- `$slopo-analyze-one` examines the highest-ranked remaining cluster. Add a
  cluster hash to choose a specific result.

The skills refresh the index and embeddings themselves. They require Slopo on
`PATH` and the local Ollama server running. New skills are available to Codex on
the next turn.

For a manual report without changing the ignore list:

```sh
slopo show-config
slopo index
slopo embed
slopo analyze
```

Open `slopo-report/index.md` for the results. Similarity is a review lead. Check
callers, behavior, and ownership before deciding to consolidate code. Atlas's
package boundaries still apply even when implementations look alike.

## Scan scope and local state

The initial configuration covers authored implementation code across the
repository. It excludes tests, fixtures, stories, dependencies, build outputs,
and generated contracts. The hand-authored Protocol Go API at
`packages/protocol/generated/go/atlasprotocol/types.go` remains included.

Slopo does not read `.gitignore`; its exclusions live in `source_dir_exclude`.
Edit that list to include tests in a later pass or exclude new output directories.
Slopo 0.7.0 also skips bodies over 10,000 characters and bodies below its AST
complexity threshold, so a successful scan does not cover every function.

Each worktree keeps its own ignored `slopo.db`, logs, and reports. Embeddings are
cached, so later runs only embed new or changed bodies. Commit reviewed ignore
hashes with their reasons, but keep reports and the database local. Changing the
source directory, model, dimensions, or body threshold requires removing the
local database and indexing again.

## Skill provenance

The three skills are unmodified copies from Slopo 0.7.0, upstream commit
`f8014eb5618e86b121901e1c7b0998e592e3cd69`, under AGPL-3.0-or-later. Their
[license](../.agents/skills/SLOPO-LICENSE) is included alongside them. The Slopo
CLI is installed separately as developer tooling.

To update, inspect the new Slopo release, update the pinned installation command,
and compare `slopo agent-configs` exports with the checked-in skills. Revalidate
the configuration and run a scan before replacing them.
