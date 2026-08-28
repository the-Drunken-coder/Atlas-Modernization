# Runtime restart fencing benchmark

The repeatable PostgreSQL benchmark is `BenchmarkRuntimeRestartFencing` in `services/core/internal/actions/task_runtime_benchmark_test.go`. It seeds Tasks outside the timed section and measures runtime registration against 100, 1,000, and 10,000 nonterminal Tasks.

Run it against a disposable, migrated PostgreSQL database:

```bash
ATLAS_ACTIONS_DATABASE_URL=postgres://... \
  go test ./internal/actions -run '^$' \
  -bench '^BenchmarkRuntimeRestartFencing$' -benchtime=3x -count=1
```

The initial atomic implementation was measured on 2026-08-20 using PostgreSQL 15 on an Apple M1 Pro:

| Nonterminal Tasks | Three-run mean |
| ---: | ---: |
| 100 | 0.242 s |
| 1,000 | 2.973 s |
| 10,000 | 28.526 s |

The 10,000-Task mean alone proves that its worst run exceeded the 15-second acceptance limit. Atlas therefore installs the replacement runtime as unready before draining stale Tasks in committed batches of 100. An exact repeated Begin continues an interrupted drain, and Ready rejects while any stale nonterminal Task remains. Runtime stop uses the same committed batch drain.

After the batch fallback was installed, three individual end-to-end registration passes measured:

| Nonterminal Tasks | Run 1 | Run 2 | Run 3 | Worst |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 0.225 s | 0.280 s | 0.268 s | 0.280 s |
| 1,000 | 2.484 s | 2.554 s | 2.628 s | 2.628 s |
| 10,000 | 27.381 s | 27.298 s | 25.640 s | 27.381 s |

The end-to-end drain remains proportional to the backlog, but it no longer holds one database transaction or the old runtime lock for that duration. The worst full drain also remains below the SDK's 30-second request timeout on the measured machine, and an exact Begin retry safely continues if transport or timing interrupts it.
