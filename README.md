# Firstborn / Forge

Forge is the deterministic coding agent for the Firstborn project. It is designed to
be driven by a supervising controller (a human operator or a "shared GPT" orchestrator)
over two stable interfaces: a GitHub Actions workflow and a local HTTP API.

This document is the integration contract. It defines how a controller submits work,
what it gets back, and what evidence accompanies every claim.

---

## 1. What Forge does

For a single task Forge will:

1. Validate the task definition and verify the target repository and base commit.
2. Inspect the repository and load its persistent instructions (`AGENTS.md`).
3. Ask a free, keyless model for a plan and an exact-anchor patch (see section 3).
4. Apply the patch in an isolated branch/worktree (`forge/task-<id>-<run>`).
5. Run the repository's checks (`npm ci`, `npm run lint`, `npm run build`, `npm test`, `git diff --check`).
6. Commit exactly the tested tree and, when authorized, open a pull request.
7. Return a `TaskExecutionReport` with the requirements matrix, raw test results, and
   any honest blocker.

Forge never rewrites architecture, touches secrets, or changes unrelated files.

---

## 2. Interfaces a controller can use

### 2.1 GitHub Actions (primary, remote)

The workflow `.github/workflows/forge.yml` runs the agent. It has two triggers:

- `workflow_dispatch` with inputs `task_id`, `task_title`, `task_desc`.
- An issue labeled `forge-task` authored by the repository `OWNER` (`issues: [labeled]`).

Both call `npx tsx src/agent/forge-runner.ts`, which reads the task from environment
variables (`TASK_ID`, `TASK_TITLE`, `TASK_DESC`, `GITHUB_REPOSITORY`) and runs
with free-tier keyed providers (`GROQ_API_KEY` and `GEMINI_API_KEY` repo secrets) plus
keyless endpoints as a last-resort fallback. `FIRSTBORN_KEYLESS_ONLY=true` is an
optional lock.

Dispatch example:

```bash
gh workflow run forge.yml --repo <owner>/<repo> --ref main \
  -f task_id="add-field-x" \
  -f task_title="Add field X" \
  -f task_desc="Modify only src/types/agent.ts ... (requirements + acceptance criteria)"
```

The run uploads a `forge-evidence` artifact containing the `TaskExecutionReport` JSON
and a preflight record.

### 2.2 Local HTTP API (`server.ts`)

Start the server with `npm start` (Express on `PORT`, default 3000). All task
endpoints require a GitHub token (`Authorization: Bearer <token>`) that is validated
against GitHub and checked against an allowlist.

| Method | Path | Purpose |
| :-- | :-- | :-- |
| GET | `/api/health` | Liveness and active model/provider policy. |
| GET | `/api/github/inspect?repo=owner/repo` | Real repository inspection. |
| POST | `/api/tasks/run` | Submit and execute a task synchronously; returns the report. |
| GET | `/api/tasks/:id` | Retrieve a previously stored report. |
| POST | `/api/verify/check` | Re-run the verification checks. |
| GET | `/api/coordination` | Returns `COORDINATION.md` for handoff context. |

Submit example:

```bash
curl -sS -X POST http://localhost:3000/api/tasks/run \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "add-field-x",
    "title": "Add field X",
    "description": "REQ-1 ... acceptance criteria ...",
    "targetRepo": "madnessgate44-debug/Firstborn",
    "targetBranch": "main",
    "allowPrCreation": true
  }'
```

### 2.3 Configuration

| Variable | Effect |
| :-- | :-- |
| `GITHUB_TOKEN` | Required for authenticated endpoints and for commits/PRs. |
| `FIRSTBORN_KEYLESS_ONLY` | `true` removes provider credentials and disables the Gemini fallback. |
| `FORGE_ALLOWED_REPOS` | Comma-separated repository allowlist (default: this repo). |
| `FORGE_ALLOWED_LOGINS` | Comma-separated operator allowlist (default: the owner). |
| `PORT` | HTTP port for `server.ts` (default 3000). |
| `FORGE_PERMISSION_PROFILE` | `readonly` \| `sandbox` \| `review` (default) \| `publish`. Controls branch/commit/PR authority. Merge is never granted. |
| `FORGE_REQUIRE_HUMAN_APPROVAL` | `true` caps the effective profile at `sandbox` (branch only, no PR) until a human approves. |
| `FORGE_ALLOWED_BRANCH_PREFIX` | Branch prefix the agent may push (default `forge/task-`). |
| `FORGE_FORBIDDEN_BRANCHES` | Branches that can never be pushed (default `main,master`). |
| `FORGE_MAX_MISSION_ATTEMPTS` | Bounded mission-level retries for transient base movement (default 1, clamped to 5). |

### Permission control plane (R7)
Every GitHub write step consults a single pure decision function
(`evaluatePermissionPolicy`) before acting. The default is least privilege:
commit to an isolated `forge/task-*` branch and open a reviewable PR; `main` is
denied by policy; merging is not representable. See
`docs/R7_PERMISSION_RISK_ASSESSMENT.md` for the risk assessment and the full
profile table.

---

## 3. Model policy (free-tier keyed first, keyless fallback)

Requirement: Forge must prefer free-tier provider keys; keyless Kilo/OVHcloud endpoints
are the last resort.

> Warning: prompts and code may be sent to anonymous third-party endpoints. Do not use
> Forge on confidential client code unless `FIRSTBORN_KEYLESS_ONLY` is off and keyed
> providers answer.

- Primary path: the `freelm` router with keyless endpoints (Kilo Gateway, OVHcloud).
  No key is required; Gemini is an optional fallback that is disabled in keyless-only mode.
- Discovery and ranking: Forge enumerates the live candidate models, then requests the
  top capability tier first (`chat:large` / `chat:best`, i.e. the large-tagged models),
  and only steps down to `chat`, `chat:fast`, and `chat:small` when a stronger route
  fails or returns no usable text.
- Failover: `freelm` degrades internally first (rate-limit rotation, cooldowns,
  benching retired/overloaded models) before Forge steps down an alias tier.
- Transparency: every response records the chosen provider/model and the reason any
  stronger route was skipped in `keylessRouteErrors`.

Observed keyless routes include `nvidia/nemotron-3-super-120b-a12b:free` (Kilo),
`Meta-Llama-3.3-70B` and `gpt-oss-120b` (OVHcloud).

---

## 4. Task definition

```ts
interface TaskDefinition {
  id: string;              // stable task id, also the branch/evidence name
  title: string;
  description: string;     // requirements + objective acceptance criteria
  targetRepo: string;      // "owner/repo", must be allowlisted
  targetBranch: string;    // base branch, default "main"
  createdAt: string;       // ISO-8601
  author: string;
  allowPrCreation: boolean;// false = commit locally only, no PR
}
```

Write the description as a numbered requirement list with testable acceptance
criteria, and name the exact files or scope Forge may touch. Precise, bounded
requests produce smaller and more reliable patches.

---

## 5. Report contract

```ts
interface TaskExecutionReport {
  taskId: string;
  status: TaskStatus;
  startTime: string;
  endTime?: string;
  baseCommitSha: string;
  headCommitSha?: string;
  branchName?: string;
  prUrl?: string;
  prNumber?: number;
  modelInvoked: {
    provider: string; model: string; callsCount: number;
    fallbackUsed?: boolean; keylessRouteErrors?: string[];
  };
  requirements: TaskRequirement[];   // { id, description, acceptanceCriteria, status, evidence }
  plannedChanges: FileChangePlan[];
  testResults: TestExecutionResult[];// raw command, exitCode, stdout, stderr
  logs: { timestamp: string; level: 'info'|'warn'|'error'; message: string }[];
  errorMessage?: string;
  blockerReason?: string;
}
```

### Status semantics

| Status | Meaning |
| :-- | :-- |
| `QUEUED` / `VALIDATING` / `INSPECTING` / `PLANNING` / `EDITING` / `TESTING` / `VERIFYING` | In-flight stages. |
| `PR_OPENED` | Success: tested commit created and a pull request opened. |
| `FAILED` | A test or validation genuinely failed; inspect `errorMessage`. |
| `BLOCKED` | A required external capability is unavailable; inspect `blockerReason`. |
| `CANCELLED` | Superseded or explicitly aborted. |

A controller must treat `FAILED` and `BLOCKED` as distinct. `BLOCKED` means the work
may be sound but an external precondition is missing; never report it as success.

---

## 6. Evidence contract

Every claim in a report is backed by raw evidence:

- `testResults[]` carries the exact command, exit code, and full stdout/stderr.
- `trace[]` records each mission stage transition (`INSPECT` -> ... -> `PR`) with
  status, so a run's path is analyzable after the fact.
- `npm run model:smoke` proves the keyless model path end to end.
- On GitHub runs, the `forge-evidence` artifact holds the report JSON and preflight record.
- Locally, reports are written to `.firstborn/evidence/<taskId>.json`.

Verification commands (the same checks CI runs):

```bash
npm ci
npm run lint          # tsc --noEmit
npm run build         # vite build
npm test              # node:test suites
npm run model:smoke   # keyless primary model smoke test
npm start             # boots the HTTP API
```

---

## 7. Safety model

- An exact-command registry with `shell: false`; no arbitrary shell execution.
- Patch validation rejects path traversal, symlinks, and protected files, and requires
  unique exact anchors.
- Operator credentials are validated server-side against an allowlist and are never
  logged; secrets are stripped from git subprocess environments.
- Untrusted input (issue bodies, task text, model output) is treated as data, never as
  instructions that can widen permissions.
- Forge pushes only to isolated `forge/task-*` branches and never to the default branch.

---

## 8. Operational notes and caveats

These are verified facts about the current environment, useful when a controller
interprets results:

- **PR creation from Actions needs the repo setting "Allow GitHub Actions to create and
  approve pull requests".** If it is off, GitHub returns 403.
- **Bot-authored PR checks can be held at `action_required` until approved.** `forge.yml`
  tries to approve them automatically.
- **The API token used for automation is a GitHub App installation token.** It cannot read
  or change repository Actions settings (`GET /repos/{owner}/{repo}/actions/permissions`
  returns `403`), so those settings must be managed by a repository administrator.
- **Free-tier variability.** Named free models change over time and are rate-limited; the
  router adapts and always prefers the strongest available tier, but a specific model is
  never guaranteed across runs.
