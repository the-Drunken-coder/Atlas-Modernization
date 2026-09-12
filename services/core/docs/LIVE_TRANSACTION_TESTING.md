# Live transaction testing

Atlas Core's transaction tier runs against a disposable PostgreSQL container. It keeps the fast offline Go suite and the live database evidence separate.

Run the required tier from the repository root:

```bash
services/core/scripts/run_live_transaction_tests.sh
```

Run the bounded nightly variant with the race detector, three repetitions, and shuffled test order:

```bash
services/core/scripts/run_live_transaction_tests.sh --nightly
```

Both commands require Docker, Git, Go, and Python 3. A missing command, an unavailable Docker daemon, PostgreSQL startup failure, skipped live dependency, missing coverage profile, malformed profile, or missing module fails the run. The script does not retry failures.

## Isolation and cleanup

The runner starts PostgreSQL with a unique container name, a random loopback port, no host bind mount, and no named volume. Its exit trap captures PostgreSQL logs and inspection data, then removes the container. Pull, start, and cleanup commands have explicit time limits. A failed removal changes an otherwise successful run to a failure and identifies the exact owned container in `classification.md`.

Each live Go test creates a unique PostgreSQL schema through `internal/testenv`. Test cleanup closes the test pool before dropping that schema. Tests within one contention scenario continue to share their pool and transactions so they still exercise the intended locks. `TestIsolatedDatabaseSchemasDoNotShareData` writes tables with the same name into two schemas and proves that each pool reads only its own row. `TestIsolatedDatabaseSchemaIsDroppedAtTestCleanup` proves that subtest cleanup removes the schema.

The fixture Entity and Task IDs remain within the protocol's 50 character limit. Runtime IDs remain within the 100 character limit. Handler scenarios use the generated runtime registration, ready, stop, and Task request validation paths.

## Behavior covered

| Group | Existing behavior executed against PostgreSQL |
| --- | --- |
| Feed | Successful writes append ordered committed events. Duplicate Entity creation and a Task rejected for an unregistered Asset do not advance the change clock or leave gaps. |
| Task routes | Create, idempotent replay, delivery, acknowledgement, start, progress, completion, failure, cancellation, immediate scheduling, exact JSON number storage, runtime readiness, and runtime stop. |
| Runtime fences | Delivery holds the current runtime fence. Replacement and stop drain nonterminal Tasks in bounded committed batches. Retired and stale runtime IDs cannot become current or mutate Tasks. |
| Contention | Entity and Object create/delete races, unique alias races, idempotent Task creation, clock-before-resource lock ordering, and concurrent runtime drain cases. |

The verifier owns the explicit test list and generates the live selector. After execution, it reads the Go JSON event log and fails if any listed test did not pass or reported a skip. The selector is also recorded in `metadata.txt`. The required run uses source order once. The nightly run uses Go's `-shuffle=on` and `-count=3`; `live.log` records the shuffle seeds and order emitted by each test process.

## Coverage evidence

The offline profile instruments the ordinary Go test processes while the runner removes database and MinIO credentials from their environment. Live tests skip in that profile. The live profile instruments the selected `testenv`, `actions`, `handlers`, `database`, and `feed` packages while the test processes call disposable PostgreSQL. No separate Atlas Core server process runs or contributes coverage.

The coverage checker uses exact covered and total statement ratios measured with the required command. It merges identical source ranges emitted by the three live test binaries, and counts a source block once if any of those processes executed it. The live total and action floors leave a small measured margin for scheduling-dependent error branches in the contention tests.

| Profile | Module | Floor |
| --- | --- | --- |
| Offline | Total | 46.7% (3539/7572) |
| Offline | Actions | 24.7% (674/2730) |
| Offline | Handlers | 45.6% (548/1201) |
| Offline | Database | 25.0% (64/256) |
| Offline | Feed | 70.7% (270/382) |
| Offline | Test environment | 28.1% (18/64) |
| Offline | Storage | 29.3% (27/92) |
| Offline | Admin | 13.9% (51/366) |
| Live | Total | 35.5% (1645/4633) |
| Live | Actions | 38.0% (1038/2730) |
| Live | Handlers | 19.9% (239/1201) |
| Live | Database | 59.0% (151/256) |
| Live | Feed | 49.0% (187/382) |
| Live | Test environment | 53.1% (34/64) |

Coverage percentage does not replace the behavior assertions above. The live tier does not cover a separately built Core executable, MinIO, migration upgrade fixtures, admin authentication, or SDK clients. Those paths remain in their existing tests or other acceptance tickets.

## Artifacts

Each run writes a unique directory under `.atlas/core-live-transactions/`. It contains:

- `metadata.txt` with the exact Git revision, tool versions, mode, image digest, selector, repetition count, and ordering mode
- `commands.log` with each executed command
- `coverage-checker-tests.log`, `selection-verifier-tests.log`, `offline.log`, `offline.coverage.out`, `live.log`, `selection-verification.log`, and `live.coverage.out`
- `coverage.txt` with separately labeled module results
- `postgres.log` and `postgres-inspect.json`
- `classification.md`, which records a clean run or leaves a failed command unclassified for assessment

GitHub Actions uploads this directory even when a command fails. The required job has a 30 minute limit. The scheduled and manually selected nightly job has a 45 minute limit.
