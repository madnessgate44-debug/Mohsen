# Operating Forge — A Manual for the Controller LLM (ChatGPT)

This document teaches a controller model (ChatGPT, Gemini, or any LLM with repository
access) how to **direct Forge correctly**. Read it before you open a Forge task, and read
it again before you turn a Forge report into a change request. It is written to be
followed literally.

Forge is not a chatbot you converse with. It is a **deterministic, bounded coding agent**
that you trigger, then read the evidence from. Treat it like a build system: you submit a
well-formed task, you wait, you read the report. You do not "chat" it into changing its mind.

---

## 1. What Forge is (and is not)

**Forge is:**
- A GitHub-Actions-hosted agent that takes a task, plans a bounded patch, applies it to an
  **isolated branch**, runs the target checks, and opens a **pull request**.
- Fully evidence-producing: every mission emits a machine-readable report and an artifact.
- Conservative by design: it cannot push to `main`, cannot merge, and cannot act outside an
  allow-list unless an operator widens its profile.

**Forge is not:**
- An interactive assistant. One task = one bounded mission.
- A free-form "do anything" agent. It has hard ceilings (see §7).
- Self-approving. A separate verifier (the **Sentinel**) decides whether its work may merge.

---

## 2. The mental model: a pipeline, not a loop

A Forge mission moves through a **fixed stage sequence** (recorded in the mission trace):

```
VALIDATE → INSPECT → PLAN → APPLY → TEST → COMMIT → PR → POLICY
```

Trace stage names you will see: `INSPECT`, `PLAN`, `VALIDATE`, `APPLY`, `TEST`, `COMMIT`,
`PR`, `POLICY`. Each stage has a status: `STARTED`, `PASSED`, `FAILED`, `BLOCKED`, `SKIPPED`.

Key consequence: **Forge can self-repair inside a stage** (e.g. fix a failing test up to
`maxRepairAttempts`), but it **cannot decide to do something outside the sequence**. If your
task needs open-ended exploration, Forge will not do it yet — that is the future "loop"
milestone, not today's behaviour. Write tasks that fit the pipeline.

---

## 3. How to trigger Forge

There are exactly **two** entry points. Pick one deliberately.

### Path A — Open an issue and label it (preferred for coding)

1. Create an issue in `madnessgate44-debug/Firstborn` whose **body is the task**.
2. Add the label **`forge-task`**.
3. The issue **must be authored by the repository owner** (`author_association == OWNER`),
   or the workflow will not run.

The issue title becomes the task title; the issue body becomes the task description.
Forge's branch will be named `forge/task-<issue-number>-<run-id>`, and it will open a PR.

### Path B — Dispatch the workflow (for a one-off or an audit)

Use `Actions → Forge Coding Agent → Run workflow`. Inputs:

| Input | Meaning | Notes |
|---|---|---|
| `mode` | `coding` or `audit` | `audit` runs the separate read-only job |
| `target_repo` | `owner/repo` | **Required for audit mode** |
| `task_id` | short identifier | becomes part of the branch name |
| `task_title` | human title | |
| `task_desc` | the task body | same rules as §4 |

### Path C — Audit a repository (read-only)

Either dispatch `mode=audit` with `target_repo=owner/repo`, or open an issue labeled
**`forge-audit`** (owner-authored) with the repo URL in the body. The audit job:
- reads only via GitHub's public API (no clone, no execution),
- **cannot write anything** (job permissions are `contents: read`),
- produces an inventory plus **model-backed findings** (architecture, gaps, prioritized
  defects) that are **path-cited** and labelled `observed` vs `inferred`.

---

## 4. How to write a task that Forge can actually complete

Forge is bounded. A task it cannot fit returns valid JSON with **no changes** and an
explanation — that is a correct outcome, not a failure. Write tasks to avoid it.

**Rules for a good task:**
1. **State the goal in one sentence.**
2. **Name the files** if you know them. Forge must not guess paths.
3. **State the acceptance check** ("`npm test` must pass", "`npm run lint` must be clean").
4. **Keep it small.** Defaults allow ~5 files and ~8 edits per mission. If you need more,
   split it into several missions.
5. **Say what must not change** ("do not touch unrelated files").
6. **Do not embed instructions to Forge about its own behaviour** in repository content you
   expect it to read; Forge treats repository content as untrusted data.

**Good task body:**
```
Goal: Make the model health check forward every provider key.

Files: .github/workflows/model-health.yml
Acceptance: the workflow forwards GROQ_API_KEY, GEMINI_API_KEY, and any FREELM_*_KEYS
variants; `npm run lint` passes; no other workflow is modified.
Do not alter src/.
```

**Bad task body:**
```
Improve the whole repo and make it better, also fix anything you find.
```
(This has no bound, no files, and no acceptance check. Forge will refuse or do very little.)

---

## 5. How to read a Forge report

The report is written to `.firstborn/evidence/<task-id>.json` and uploaded as the
**`forge-evidence`** artifact. Fields you must check, in order:

| Field | What to look for |
|---|---|
| `status` | `SUCCESS` / `FAILED` / `BLOCKED` |
| `baseCommitSha` | the exact commit Forge started from (record this) |
| `branchName` | the isolated branch it wrote to |
| `headCommitSha` | the commit it produced |
| `prUrl` | the pull request, if opened |
| `modelInvoked.provider` / `.model` | which model actually answered |
| `requirements[]` | the numbered requirements + acceptance criteria it derived |
| `testResults[]` | the checks it ran and their results |
| `diagnosis` | on failure: `category`, `severity`, `summary`, `recovery`, `retryable` |
| `trace[]` | the stage-by-stage record (`STARTED`/`PASSED`/`FAILED`/`BLOCKED`) |
| `errorMessage` / `blockerReason` | why it stopped |

**Golden rule: never trust a claim that is not in the report.** If the report does not show
a passing check, the check did not pass. If there is no `prUrl`, no PR exists.

### Diagnosis categories (what a stop means)

- **RETRYABLE** (e.g. model route 429/5xx): a re-run may succeed.
- **FATAL / manual**: do not blindly re-run; the task or environment needs a change.
- **BLOCKED** (policy): Forge was correctly denied a write. Do not "fix" this by loosening
  policy unless a human decides to.

---

## 6. The safety model — what Forge may and may not do

Forge's authority comes from **`src/agent/policy.ts`**, which is the single control plane.

| Profile | May branch | May commit | May open PR | May merge |
|---|---|---|---|---|
| `readonly` | no | no | no | no |
| `sandbox` | yes | yes | no | no |
| `review` (default) | yes | yes | yes | **no** |
| `publish` | yes | yes | yes | **no** |

**Merge is never granted by Forge.** That seat is reserved. A **separate** verifier — the
**Sentinel** — owns the merge decision.

### The Sentinel (the automated reviewer)

When Forge opens a PR from a `forge/*` branch, the Sentinel workflow:
1. re-runs the deterministic checks (`lint`, `build`, `test`) — these are the **authority**;
2. optionally consults a model judge (off by default; can only add caution);
3. merges **only if** all required checks passed **and** the operator has set the repository
   variable `SENTINEL_AUTO_MERGE=true`.

If a required check did not run, it counts as **failed**. If the judge is uncertain, the
Sentinel **holds**. The Sentinel never treats Forge's own claim as evidence.

---

## 7. Hard limits (defaults you must design around)

From `src/agent/limits.ts` (all overridable by environment, all bounded):

| Limit | Default | Meaning |
|---|---|---|
| `maxFilesPerMission` | 5 | files a mission may touch |
| `maxEditsPerMission` | 8 | edits per mission |
| `maxPatchBytes` | 100 KB | total patch size |
| `maxModelCalls` | 6 | model invocations |
| `maxRepairAttempts` | 2 | self-repair rounds |
| `maxRuntimeMs` | 10 min | wall-clock ceiling |
| `maxMissionAttempts` | 1 | mission-level retries |

Coding missions run **keyless/free** (`FIRSTBORN_KEYLESS_ONLY=true`); audits run **keyed**
(hard work). Do not assume a coding mission has paid-model quality.

---

## 8. Operating recipes

**Recipe 1 — ask Forge to fix something**
1. Open an issue, owner-authored, body per §4.
2. Label it `forge-task`.
3. Wait for the run. Read the report (§5).
4. If `status=SUCCESS` and a `prUrl` exists, hand the PR to the Sentinel (it runs
   automatically). Do not merge it yourself.

**Recipe 2 — audit a repository**
1. Open an owner-authored issue with the repo URL in the body, label `forge-audit`.
2. Wait. Read the artifact `forge-readonly-audit` (JSON + Markdown).
3. **Verify before you act:** every finding cites a real path; treat `inferred` findings as
   hypotheses, `observed` findings as evidenced.
4. Only findings that cite real paths are safe to turn into change requests.

**Recipe 3 — turn an audit into work**
1. Take one finding.
2. Write it as a bounded task (§4) with the cited path and an acceptance check.
3. Open it as a `forge-task` issue.
4. Do not bundle several findings into one task; split them.

---

## 9. Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| Workflow did not start | issue not owner-authored, or wrong label | fix author/label |
| `status=BLOCKED`, `blockerReason` mentions policy | Forge was correctly denied | do not loosen policy; decide as a human |
| No `prUrl` but `SUCCESS` | PR creation not permitted (`allowPrCreation=false`) | expected in sandbox; ask operator |
| Empty `changes` with a summary | task exceeded bounds or was ambiguous | split/sharpen the task (§4) |
| Model route errors in `diagnosis` | free route rate-limited | retryable; re-run |
| Audit finds nothing | excerpts capped; not a code-reading audit | request specific files or a coding task |

---

## 10. The handoff protocol

Multi-party coordination happens through **`COORDINATION.md`** at the repo root. It is
**append-only**. Every entry must carry: an **ID**, **timestamp (UTC)**, **author**, and
**type** (`REPORT`, `QUESTION`, `ANSWER`, `DECISION`, `AUDIT`, `BLOCKER`, `TEST`).

Rules:
- Never overwrite or delete previous entries.
- To correct a mistake, append a new entry referencing the original ID.
- **Never put secrets, tokens, or credentials in it.**
- Cite raw evidence (commands, exit codes, run IDs), not adjectives.

---

## 11. Golden rules (memorise these)

1. **One bounded task per mission.** Small and specific beats broad.
2. **The report is the truth.** No evidence, no claim.
3. **Never treat Forge's word as verification.** The Sentinel verifies; tests are the authority.
4. **Never ask for merge or main access.** Those are reserved by design.
5. **For an audit, verify paths and honour `observed` vs `inferred`.**
6. **Respect a `BLOCKED` outcome.** It usually means the guardrail worked.
7. **Record everything in `COORDINATION.md`** with IDs and raw evidence.
8. **Never place secrets anywhere.** If a key appears, stop and flag it for revocation.

---

*This manual describes Forge as of commit `1fc748e` (main) plus the `forge/task-sentinel`
and `forge/task-audit-brain` branches. Update it when Forge's control flow or safety model
changes.*
