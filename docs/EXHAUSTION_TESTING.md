# Exhaustion testing Forge

This is the procedure for stress-testing the Forge agent before relying on it. It
runs the real end-to-end path repeatedly and inspects what each run actually did.

## What to run

Repeat a real mission many times, from clean clones, against a scratch branch or a
throwaway repository. Vary the mission (create-only, single-file modify,
multi-file) so the run covers different code paths.

```bash
export FIRSTBORN_KEYLESS_ONLY=true
export TASK_ID="exhaustion-$(date +%s)"
export TASK_TITLE="Exhaustion run"
export TASK_DESC="<a real, bounded task>"
export GITHUB_REPOSITORY="<owner>/<repo>"
npx tsx src/agent/forge-runner.ts
```

The report is written to `.firstborn/evidence/<task-id>.json`.

## What to watch

Each report contains an ordered `trace` array — one entry per mission stage
(`INSPECT`, `PLAN`, `VALIDATE`, `APPLY`, `TEST`, `POLICY`, `COMMIT`, `PR`) with a
status of `PASSED`, `FAILED`, `BLOCKED`, or `SKIPPED`.

- **Stuck loops**: a trace that never reaches `TEST`, or that repeats `INSPECT`
  beyond `FORGE_MAX_MISSION_ATTEMPTS`.
- **Silent weak models**: `modelInvoked.keylessRouteErrors` records when a stronger
  tier was skipped and why. A run that settles below `chat:large` tells you the
  top tier failed or returned no usable text — a routing signal, not a crash.
- **Wrong success**: a `PASSED` `PR`/`COMMIT` alongside any `FAILED`/`BLOCKED`
  entry is a bug; `summarizeTrace` reports `completed: false` in that case.
- **Resource growth**: `modelInvoked.callsCount`, `testResults.length`, and
  wall-clock (`startTime` -> `endTime`) across runs.

## Bounded limits that prevent runaway behaviour

All are clamped by `loadForgeLimits` (see `src/agent/limits.ts`), so no environment
value can raise them without bound.

| Variable | Default | Guards against |
| :-- | :-- | :-- |
| `FORGE_MAX_MISSION_ATTEMPTS` | 1 | repeated mission-level retries |
| `FORGE_MAX_MODEL_CALLS` | 6 | unbounded model calls |
| `FORGE_MAX_REPAIRS` | 2 | unbounded patch-repair loops |
| `FORGE_MODEL_ATTEMPTS` | 2 | per-call model retries |
| `FORGE_MAX_RUNTIME_MS` | 600000 | runaway wall-clock |
| `FORGE_MAX_FILES` | 5 | oversized patches |
| `FORGE_MAX_EDITS` | 8 | oversized patches |
| `FORGE_MAX_PATCH_BYTES` | 102400 | oversized patches |

## Pass criteria

A run passes exhaustion testing when the trace reaches a terminal success stage
(`COMMIT`/`PR`, or `POLICY`/`TEST` for no-write runs) with no `FAILED`/`BLOCKED`
entries, every requirement reports evidence, and no limit had to be raised to get
there.
